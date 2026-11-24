import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type * as ArchiverNs from 'archiver';
import * as tar from 'tar';
import { db, recordAuditLog } from '../db.js';
import { CHMOD_MODE_REGEX, sanitizeContainerFilePath } from '../security.js';
import { isIncusReady, type VmInstanceRow } from './incusController.js';

const require = createRequire(import.meta.url);
const archiver = require('archiver') as (
  format: 'zip',
  options?: ArchiverNs.ArchiverOptions
) => ArchiverNs.Archiver;
const execFileAsync = promisify(execFile);

export interface VpsFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  permissions: string;
  permissionsOctal: string;
  owner: string;
  modifiedAt: string;
}

const PROTECTED_ROOT_PATHS = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
]);

function getInstanceOrThrow(instanceId: number): VmInstanceRow {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');
  return inst;
}

async function ensureLocalIncusReady(inst: VmInstanceRow): Promise<void> {
  if (inst.node_id && inst.node_id !== 1) {
    throw new Error('Remote node VPS file browsing requires direct host SSH or local node connection.');
  }
  const ready = await isIncusReady();
  if (!ready) {
    throw new Error('Incus daemon is unavailable on this host. Deploy on Ubuntu/Debian VPS to manage live container files.');
  }
}

function makeTempWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbbahi-vps-'));
}

function modeStringToOctal(modeStr: string): string {
  if (modeStr.length < 10) return '644';
  const rwx = modeStr.slice(1, 10);
  let out = '';
  for (let i = 0; i < 3; i++) {
    const chunk = rwx.slice(i * 3, i * 3 + 3);
    let val = 0;
    if (chunk[0] === 'r') val += 4;
    if (chunk[1] === 'w') val += 2;
    if (chunk[2] === 'x' || chunk[2] === 's' || chunk[2] === 't') val += 1;
    out += String(val);
  }
  return out;
}

function parseLsLine(line: string, parentDir: string): VpsFileEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('total ')) return null;
  // Works on both GNU coreutils (`ls -la --time-style=long-iso`) and BusyBox (`ls -la`)
  const parts = trimmed.split(/\s+/);
  if (parts.length < 8) return null;

  const perms = parts[0];
  if (!/^[dlcbps-][rwxstST-]{9}/.test(perms)) return null;

  const owner = `${parts[2]}:${parts[3]}`;
  const size = Number(parts[4]) || 0;

  // Detect ISO date (YYYY-MM-DD HH:MM) vs classic (Mon DD HH:MM/YYYY)
  let nameStartIdx = 8;
  let modifiedAt = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(parts[5])) {
    modifiedAt = `${parts[5]} ${parts[6]}`;
    nameStartIdx = 7;
  } else {
    modifiedAt = `${parts[5]} ${parts[6]} ${parts[7]}`;
    nameStartIdx = 8;
  }

  let rawName = parts.slice(nameStartIdx).join(' ');
  const isSymlink = perms.startsWith('l');
  if (isSymlink && rawName.includes(' -> ')) {
    rawName = rawName.split(' -> ')[0];
  }
  if (!rawName || rawName === '.' || rawName === '..') return null;

  const entryPath = parentDir === '/' ? `/${rawName}` : `${parentDir}/${rawName}`;
  return {
    name: rawName,
    path: path.posix.normalize(entryPath),
    isDirectory: perms.startsWith('d'),
    isSymlink,
    size,
    permissions: perms.slice(0, 10),
    permissionsOctal: modeStringToOctal(perms),
    owner,
    modifiedAt,
  };
}

export async function listContainerFiles(
  instanceId: number,
  rawDirPath?: string
): Promise<{ currentPath: string; entries: VpsFileEntry[] }> {
  const inst = getInstanceOrThrow(instanceId);
  await ensureLocalIncusReady(inst);

  const currentPath = sanitizeContainerFilePath(rawDirPath, '/root');
  const script =
    'target="$1"; [ -d "$target" ] || { echo "ERR_NOT_DIR" >&2; exit 2; }; ls -la --time-style=long-iso "$target" 2>/dev/null || ls -la "$target"';

  const { stdout } = await execFileAsync(
    'incus',
    ['exec', inst.instance_name, '--', '/bin/sh', '-c', script, '--', currentPath],
    { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }
  );

  const entries: VpsFileEntry[] = [];
  for (const line of stdout.split('\n')) {
    const parsed = parseLsLine(line, currentPath);
    if (parsed) entries.push(parsed);
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { currentPath, entries };
}

export async function readContainerFile(
  instanceId: number,
  rawFilePath: string
): Promise<{ path: string; content: string; size: number }> {
  const inst = getInstanceOrThrow(instanceId);
  await ensureLocalIncusReady(inst);

  const cleanPath = sanitizeContainerFilePath(rawFilePath);
  const { stdout: sizeOut } = await execFileAsync(
    'incus',
    [
      'exec',
      inst.instance_name,
      '--',
      '/bin/sh',
      '-c',
      'f="$1"; [ -f "$f" ] || exit 2; wc -c < "$f"',
      '--',
      cleanPath,
    ],
    { timeout: 8000 }
  );
  const byteSize = Number(sizeOut.trim()) || 0;
  if (byteSize > 2 * 1024 * 1024) {
    throw new Error('File is larger than 2 MB. Download it instead of opening in the web editor.');
  }

  const tmpDir = makeTempWorkdir();
  const localFile = path.join(tmpDir, 'pull.bin');
  try {
    await execFileAsync('incus', ['file', 'pull', `${inst.instance_name}${cleanPath}`, localFile], {
      timeout: 15000,
    });
    const content = fs.readFileSync(localFile, 'utf8');
    return { path: cleanPath, content, size: byteSize };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function writeContainerFile(params: {
  instanceId: number;
  filePath: string;
  content: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  const inst = getInstanceOrThrow(params.instanceId);
  await ensureLocalIncusReady(inst);

  const cleanPath = sanitizeContainerFilePath(params.filePath);
  const parentDir = path.posix.dirname(cleanPath);
  const tmpDir = makeTempWorkdir();
  const localFile = path.join(tmpDir, 'push.bin');

  try {
    fs.writeFileSync(localFile, params.content, 'utf8');
    await execFileAsync(
      'incus',
      ['exec', inst.instance_name, '--', 'mkdir', '-p', parentDir],
      { timeout: 8000 }
    );
    await execFileAsync('incus', ['file', 'push', localFile, `${inst.instance_name}${cleanPath}`], {
      timeout: 15000,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.file_edit',
    target: inst.instance_name,
    details: `Saved ${cleanPath}`,
    ipAddress: params.ipAddress,
  });
}

export async function createContainerEntry(params: {
  instanceId: number;
  targetPath: string;
  type: 'file' | 'folder';
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<string> {
  const inst = getInstanceOrThrow(params.instanceId);
  await ensureLocalIncusReady(inst);

  const cleanPath = sanitizeContainerFilePath(params.targetPath);
  if (params.type === 'folder') {
    await execFileAsync('incus', ['exec', inst.instance_name, '--', 'mkdir', '-p', cleanPath], {
      timeout: 8000,
    });
  } else {
    const parent = path.posix.dirname(cleanPath);
    await execFileAsync(
      'incus',
      [
        'exec',
        inst.instance_name,
        '--',
        '/bin/sh',
        '-c',
        'mkdir -p "$1" && touch "$2"',
        '--',
        parent,
        cleanPath,
      ],
      { timeout: 8000 }
    );
  }

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.file_create',
    target: inst.instance_name,
    details: `Created ${params.type} ${cleanPath}`,
    ipAddress: params.ipAddress,
  });
  return cleanPath;
}

export async function renameOrMoveContainerEntry(params: {
  instanceId: number;
  sourcePath: string;
  destPath: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  const inst = getInstanceOrThrow(params.instanceId);
  await ensureLocalIncusReady(inst);

  const src = sanitizeContainerFilePath(params.sourcePath);
  const dst = sanitizeContainerFilePath(params.destPath);
  if (src === '/' || dst === '/') {
    throw new Error('Cannot move root filesystem directory.');
  }
  const dstParent = path.posix.dirname(dst);
  await execFileAsync(
    'incus',
    [
      'exec',
      inst.instance_name,
      '--',
      '/bin/sh',
      '-c',
      'mkdir -p "$1" && mv -- "$2" "$3"',
      '--',
      dstParent,
      src,
      dst,
    ],
    { timeout: 12000 }
  );

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.file_move',
    target: inst.instance_name,
    details: `Moved ${src} -> ${dst}`,
    ipAddress: params.ipAddress,
  });
}

export async function chmodContainerEntry(params: {
  instanceId: number;
  targetPath: string;
  mode: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  const inst = getInstanceOrThrow(params.instanceId);
  await ensureLocalIncusReady(inst);

  const cleanPath = sanitizeContainerFilePath(params.targetPath);
  const cleanMode = String(params.mode || '').trim();
  if (!CHMOD_MODE_REGEX.test(cleanMode)) {
    throw new Error('Permissions mode must be a valid octal value (e.g. 644 or 755).');
  }

  await execFileAsync(
    'incus',
    ['exec', inst.instance_name, '--', 'chmod', cleanMode, cleanPath],
    { timeout: 8000 }
  );

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.file_chmod',
    target: inst.instance_name,
    details: `chmod ${cleanMode} ${cleanPath}`,
    ipAddress: params.ipAddress,
  });
}

export async function deleteContainerEntry(params: {
  instanceId: number;
  targetPath: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  const inst = getInstanceOrThrow(params.instanceId);
  await ensureLocalIncusReady(inst);

  const cleanPath = sanitizeContainerFilePath(params.targetPath);
  if (PROTECTED_ROOT_PATHS.has(cleanPath)) {
    throw new Error(`Protected system path '${cleanPath}' cannot be deleted from File Manager.`);
  }

  await execFileAsync(
    'incus',
    ['exec', inst.instance_name, '--', 'rm', '-rf', '--', cleanPath],
    { timeout: 15000 }
  );

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.file_delete',
    target: inst.instance_name,
    details: `Deleted ${cleanPath}`,
    ipAddress: params.ipAddress,
  });
}

export async function uploadContainerFiles(params: {
  instanceId: number;
  targetDir: string;
  files: Express.Multer.File[];
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<string[]> {
  const inst = getInstanceOrThrow(params.instanceId);
  await ensureLocalIncusReady(inst);

  const cleanDir = sanitizeContainerFilePath(params.targetDir, '/root');
  await execFileAsync('incus', ['exec', inst.instance_name, '--', 'mkdir', '-p', cleanDir], {
    timeout: 8000,
  });

  const tmpDir = makeTempWorkdir();
  const uploaded: string[] = [];
  try {
    for (const f of params.files) {
      const safeName = path.basename(f.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!safeName || safeName === '.' || safeName === '..') continue;
      const localTmp = path.join(tmpDir, safeName);
      fs.writeFileSync(localTmp, f.buffer);
      const remotePath = cleanDir === '/' ? `/${safeName}` : `${cleanDir}/${safeName}`;
      await execFileAsync(
        'incus',
        ['file', 'push', localTmp, `${inst.instance_name}${remotePath}`],
        { timeout: 60000 }
      );
      uploaded.push(safeName);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.file_upload',
    target: inst.instance_name,
    details: `Uploaded ${uploaded.join(', ')} into ${cleanDir}`,
    ipAddress: params.ipAddress,
  });

  return uploaded;
}

export async function prepareContainerDownload(params: {
  instanceId: number;
  targetPath: string;
  archiveFormat?: 'tar.gz' | 'zip';
}): Promise<{ filePath: string; filename: string; cleanupDir: string }> {
  const inst = getInstanceOrThrow(params.instanceId);
  await ensureLocalIncusReady(inst);

  const cleanPath = sanitizeContainerFilePath(params.targetPath);
  const { stdout: typeOut } = await execFileAsync(
    'incus',
    [
      'exec',
      inst.instance_name,
      '--',
      '/bin/sh',
      '-c',
      'p="$1"; if [ -d "$p" ]; then echo dir; elif [ -f "$p" ]; then echo file; else echo missing; fi',
      '--',
      cleanPath,
    ],
    { timeout: 8000 }
  );

  const kind = typeOut.trim();
  if (kind === 'missing') {
    throw new Error('Target path does not exist inside instance.');
  }

  const cleanupDir = makeTempWorkdir();
  const baseName = path.posix.basename(cleanPath) || 'root';

  if (kind === 'file') {
    const outFile = path.join(cleanupDir, baseName);
    try {
      await execFileAsync('incus', ['file', 'pull', `${inst.instance_name}${cleanPath}`, outFile], {
        timeout: 60000,
      });
      return { filePath: outFile, filename: baseName, cleanupDir };
    } catch (err) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      throw err;
    }
  }

  // Directory archive (.tar.gz or .zip)
  const format = params.archiveFormat === 'zip' ? 'zip' : 'tar.gz';
  const parentDir = path.posix.dirname(cleanPath);
  const tarTarget = cleanPath === '/' ? '.' : baseName;
  const tarCwd = cleanPath === '/' ? '/' : parentDir;
  const tarGzPath = path.join(cleanupDir, `${baseName}.tar.gz`);

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'incus',
        ['exec', inst.instance_name, '--', 'tar', '-czf', '-', '-C', tarCwd, tarTarget],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const out = fs.createWriteStream(tarGzPath);
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          proc.kill('SIGTERM');
        } catch {
          // ignore
        }
        out.destroy();
        reject(new Error('Container archive preparation timed out.'));
      }, 120000);

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          try {
            proc.kill('SIGTERM');
          } catch {
            // ignore
          }
          out.destroy();
          reject(err);
        } else {
          resolve();
        }
      };

      proc.stdout.pipe(out);
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('error', (err) => finish(err));
      out.on('error', (err) => finish(err));
      proc.on('close', (code) => {
        if (code === 0) {
          if (out.writableFinished) {
            finish();
          } else {
            out.once('finish', () => finish());
          }
        } else {
          finish(new Error(stderr.trim() || `tar exited with code ${code}`));
        }
      });
    });

    if (format === 'tar.gz') {
      return { filePath: tarGzPath, filename: `${baseName}.tar.gz`, cleanupDir };
    }

    // Convert tar.gz -> zip cleanly on host via tar.extract + archiver
    const extractDir = path.join(cleanupDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    await tar.extract({ file: tarGzPath, cwd: extractDir });

    const zipPath = path.join(cleanupDir, `${baseName}.zip`);
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(extractDir, false);
      void archive.finalize();
    });

    return { filePath: zipPath, filename: `${baseName}.zip`, cleanupDir };
  } catch (err) {
    fs.rmSync(cleanupDir, { recursive: true, force: true });
    throw err;
  }
}
