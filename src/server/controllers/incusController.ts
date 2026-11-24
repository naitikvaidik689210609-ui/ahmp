import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  deleteBackupFromCloud,
  downloadBackupFromCloud,
  getCloudConfig,
  isCloudConfigured,
  uploadBackupToCloud,
} from '../cloudStorage.js';
import { db, getDataDir, recordAuditLog } from '../db.js';
import {
  CONTAINER_NAME_REGEX,
  decryptSecret,
  encryptSecret,
  getUserQuotaSummary,
  INCUS_OS_TEMPLATES,
  isValidDomain,
  isValidPort,
  isValidSnapshotName,
  resolveConfinedPath,
  sanitizeDisplayName,
  slugifyContainerName,
  SSH_PUBLIC_KEY_REGEX,
  type UserRole,
} from '../security.js';
import { sendDiscordAlert } from '../webhook.js';
import { dispatchNodeCommand, getNodeById } from './nodeController.js';

const execFileAsync = promisify(execFile);

function safeJsonParse<T>(raw: string, fallback: T): T {
  const trimmed = (raw || '').trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return fallback;
  }
}

export interface ProvisionProgressEvent {
  operationId: string;
  step: number;
  totalSteps: number;
  label: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
}

export type ProgressCallback = (ev: Omit<ProvisionProgressEvent, 'operationId'>) => void;

export interface VmInstanceRow {
  id: number;
  name: string;
  instance_name: string;
  type: 'container' | 'vm';
  os_template: string;
  vcpu: number;
  ram_mb: number;
  disk_gb: number;
  status: string;
  is_suspended: number;
  owner_id: number | null;
  owner_username?: string;
  node_id?: number;
  node_name?: string;
  node_location?: string;
  ip_address: string | null;
  ssh_port?: number | null;
  host_ipv4?: string | null;
  created_at: string;
}

export interface VmSshKeyRow {
  id: number;
  instance_id: number;
  label: string;
  public_key: string;
  fingerprint: string;
  created_at: string;
}

export interface VmTelemetry {
  instanceId: number;
  live: boolean;
  status: string;
  cpuPercent: number;
  ramUsedMb: number;
  ramLimitMb: number;
  swapUsedMb: number;
  swapTotalMb: number;
  diskUsedGb: number;
  diskTotalGb: number;
  netRxBytesPerSec: number;
  netTxBytesPerSec: number;
  netTotalRxBytes: number;
  netTotalTxBytes: number;
  uptimeSeconds: number;
  kernel: string;
  internalIp: string | null;
  hostIpv4: string;
  sshPort: number | null;
  timestamp: number;
}

export interface PortAllocationRow {
  id: number;
  resource_type: string;
  resource_id: number;
  host_port: number;
  target_port: number;
  protocol: 'tcp' | 'udp';
  device_name: string;
  created_at: string;
}

export interface ReverseProxyRow {
  id: number;
  instance_id: number;
  domain: string;
  target_port: number;
  ssl_enabled: number;
  engine: 'caddy' | 'nginx';
  created_at: string;
}

export async function isIncusReady(): Promise<boolean> {
  try {
    await execFileAsync('incus', ['version'], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

export async function syncIncusInstances(viewer?: {
  id: number;
  role: UserRole;
}): Promise<VmInstanceRow[]> {
  let rows: VmInstanceRow[];

  if (!viewer || viewer.role === 'owner' || viewer.role === 'admin') {
    rows = db
      .prepare(
        `SELECT vi.id, vi.name, vi.instance_name, vi.type, vi.os_template, vi.vcpu, vi.ram_mb, vi.disk_gb,
                vi.status, vi.is_suspended, vi.owner_id, vi.node_id, vi.ip_address, vi.ssh_port, vi.host_ipv4, vi.created_at,
                u.username AS owner_username, n.name AS node_name, n.location AS node_location
         FROM vm_instances vi
         LEFT JOIN users u ON u.id = vi.owner_id
         LEFT JOIN nodes n ON n.id = vi.node_id
         ORDER BY vi.created_at DESC`
      )
      .all() as VmInstanceRow[];
  } else {
    rows = db
      .prepare(
        `SELECT vi.id, vi.name, vi.instance_name, vi.type, vi.os_template, vi.vcpu, vi.ram_mb, vi.disk_gb,
                vi.status, vi.is_suspended, vi.owner_id, vi.node_id, vi.ip_address, vi.ssh_port, vi.host_ipv4, vi.created_at,
                u.username AS owner_username, n.name AS node_name, n.location AS node_location
         FROM vm_instances vi
         LEFT JOIN users u ON u.id = vi.owner_id
         LEFT JOIN nodes n ON n.id = vi.node_id
         WHERE vi.owner_id = ?
         ORDER BY vi.created_at DESC`
      )
      .all(viewer.id) as VmInstanceRow[];
  }

  const incusUp = await isIncusReady();
  if (!incusUp) return rows;

  try {
    const { stdout } = await execFileAsync('incus', ['list', '--format=json'], { timeout: 4000 });
    const list = safeJsonParse<
      Array<{
        name: string;
        status: string;
        state?: {
          network?: Record<string, { addresses?: Array<{ family: string; address: string; scope: string }> }>;
        };
      }>
    >(stdout, []);

    const byName = new Map(list.map((item) => [item.name, item]));
    for (const row of rows) {
      if (row.node_id && row.node_id !== 1) continue;
      const live = byName.get(row.instance_name);
      if (!live) continue;

      const status = live.status.toLowerCase() === 'running' ? 'running' : 'stopped';
      let ipAddr: string | null = row.ip_address;

      if (live.state?.network) {
        for (const [iface, netInfo] of Object.entries(live.state.network)) {
          if (iface === 'lo') continue;
          const v4 = netInfo.addresses?.find((a) => a.family === 'inet' && a.scope === 'global');
          if (v4) {
            ipAddr = v4.address;
            break;
          }
        }
      }

      if (status !== row.status || ipAddr !== row.ip_address) {
        db.prepare('UPDATE vm_instances SET status = ?, ip_address = ? WHERE id = ?').run(
          status,
          ipAddr,
          row.id
        );
        row.status = status;
        row.ip_address = ipAddr;
      }
    }
  } catch {
    // Ignore transient incus list failures
  }

  return rows;
}

const IPV4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;
let cachedPublicIpv4: { ip: string; fetchedAt: number } | null = null;

export async function detectHostPublicIpv4(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedPublicIpv4 && Date.now() - cachedPublicIpv4.fetchedAt < 5 * 60 * 1000) {
    return cachedPublicIpv4.ip;
  }

  // 1. Try external IPv4 discovery via curl / fetch
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-4', '-s', '--max-time', '2', 'https://ifconfig.me'],
      { timeout: 3000 }
    );
    const trimmed = stdout.trim();
    if (IPV4_REGEX.test(trimmed) && !trimmed.startsWith('127.')) {
      cachedPublicIpv4 = { ip: trimmed, fetchedAt: Date.now() };
      return trimmed;
    }
  } catch {
    // fallback below
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch('https://api.ipify.org', { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const ip = (await res.text()).trim();
      if (IPV4_REGEX.test(ip) && !ip.startsWith('127.')) {
        cachedPublicIpv4 = { ip, fetchedAt: Date.now() };
        return ip;
      }
    }
  } catch {
    // fallback below
  }

  // 2. Try primary node FQDN if explicitly configured beyond loopback
  const localNode = db.prepare('SELECT fqdn FROM nodes WHERE id = 1').get() as
    | { fqdn: string }
    | undefined;
  if (localNode?.fqdn && localNode.fqdn !== '127.0.0.1' && localNode.fqdn !== 'localhost') {
    cachedPublicIpv4 = { ip: localNode.fqdn, fetchedAt: Date.now() };
    return localNode.fqdn;
  }

  // 3. Fallback to first non-internal network interface IPv4
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        cachedPublicIpv4 = { ip: addr.address, fetchedAt: Date.now() };
        return addr.address;
      }
    }
  }

  return '127.0.0.1';
}

export function getNextFreeSharedPort(protocol: 'tcp' | 'udp' = 'tcp'): number {
  const usedRows = db
    .prepare('SELECT host_port FROM port_allocations WHERE protocol = ?')
    .all(protocol) as Array<{ host_port: number }>;
  const mcRows = db.prepare('SELECT port FROM minecraft_servers').all() as Array<{ port: number }>;
  const sshRows = db
    .prepare('SELECT ssh_port FROM vm_instances WHERE ssh_port IS NOT NULL')
    .all() as Array<{ ssh_port: number }>;

  const used = new Set<number>([
    ...usedRows.map((r) => r.host_port),
    ...mcRows.map((r) => r.port),
    ...sshRows.map((r) => r.ssh_port),
  ]);

  const pools = db
    .prepare(
      `SELECT start_port, end_port, protocol, label FROM port_pools
       WHERE protocol IN (?, 'both')
       ORDER BY CASE WHEN label = 'Incus Shared IPv4 NAT' THEN 0 ELSE 1 END, id ASC`
    )
    .all(protocol) as Array<{ start_port: number; end_port: number; protocol: string; label: string }>;

  for (const pool of pools) {
    const start = Math.max(1024, Math.min(65535, pool.start_port));
    const end = Math.max(start, Math.min(65535, pool.end_port));
    for (let p = start; p <= end; p++) {
      if (!used.has(p)) return p;
    }
  }

  for (let p = 2200; p <= 4999; p++) {
    if (!used.has(p)) return p;
  }
  for (let p = 10000; p <= 60000; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error('No free NAT ports remaining in configured port pools.');
}

function setRootPasswordInInstance(instanceName: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('incus', ['exec', instanceName, '--', 'chpasswd'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `chpasswd exited with code ${code}`));
    });
    child.stdin.write(`root:${password}\n`);
    child.stdin.end();
  });
}

async function configureOpenSshInInstance(instanceName: string): Promise<void> {
  const sshSetupScript = [
    'set -e',
    'if ! command -v sshd >/dev/null 2>&1; then',
    '  if command -v apt-get >/dev/null 2>&1; then',
    '    export DEBIAN_FRONTEND=noninteractive',
    '    apt-get update -qq && apt-get install -y -qq openssh-server >/dev/null 2>&1 || true',
    '  elif command -v dnf >/dev/null 2>&1; then',
    '    dnf install -y -q openssh-server >/dev/null 2>&1 || true',
    '  elif command -v apk >/dev/null 2>&1; then',
    '    apk add --no-cache openssh >/dev/null 2>&1 || true',
    '  fi',
    'fi',
    'mkdir -p /etc/ssh /run/sshd /root/.ssh && chmod 700 /root/.ssh',
    'if [ -f /etc/ssh/sshd_config ]; then',
    '  sed -i "s/^#*PermitRootLogin.*/PermitRootLogin yes/" /etc/ssh/sshd_config || true',
    '  sed -i "s/^#*PasswordAuthentication.*/PasswordAuthentication yes/" /etc/ssh/sshd_config || true',
    '  sed -i "s/^#*PubkeyAuthentication.*/PubkeyAuthentication yes/" /etc/ssh/sshd_config || true',
    '  grep -q "^PermitRootLogin" /etc/ssh/sshd_config || echo "PermitRootLogin yes" >> /etc/ssh/sshd_config',
    '  grep -q "^PasswordAuthentication" /etc/ssh/sshd_config || echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config',
    'fi',
    'if [ -d /etc/ssh/sshd_config.d ]; then',
    '  printf "PermitRootLogin yes\\nPasswordAuthentication yes\\nPubkeyAuthentication yes\\n" > /etc/ssh/sshd_config.d/99-fbbahi.conf',
    'fi',
    'ssh-keygen -A >/dev/null 2>&1 || true',
    'if command -v systemctl >/dev/null 2>&1; then',
    '  systemctl enable ssh sshd >/dev/null 2>&1 || true',
    '  systemctl restart ssh || systemctl restart sshd || true',
    'elif command -v rc-service >/dev/null 2>&1; then',
    '  rc-update add sshd default >/dev/null 2>&1 || true',
    '  rc-service sshd restart >/dev/null 2>&1 || true',
    'elif command -v service >/dev/null 2>&1; then',
    '  service ssh restart || service sshd restart || true',
    'fi',
  ].join('\n');

  await execFileAsync('incus', ['exec', instanceName, '--', '/bin/sh', '-c', sshSetupScript], {
    timeout: 90000,
  }).catch(() => {});
}

async function waitForInstanceIp(instanceName: string): Promise<string | null> {
  for (let i = 0; i < 6; i++) {
    try {
      const { stdout } = await execFileAsync('incus', ['list', instanceName, '--format=json'], {
        timeout: 4000,
      });
      const list = safeJsonParse<
        Array<{
          state?: {
            network?: Record<string, { addresses?: Array<{ family: string; address: string; scope: string }> }>;
          };
        }>
      >(stdout, []);
      const net = list[0]?.state?.network;
      if (net) {
        for (const [iface, netInfo] of Object.entries(net)) {
          if (iface === 'lo') continue;
          const v4 = netInfo.addresses?.find((a) => a.family === 'inet' && a.scope === 'global');
          if (v4) return v4.address;
        }
      }
    } catch {
      // ignore transient boot delay
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

export async function createIncusInstance(params: {
  name: string;
  type: 'container' | 'vm';
  osTemplate: string;
  vcpu: number;
  ramMb: number;
  diskGb: number;
  rootPassword: string;
  ownerId: number;
  nodeId?: number;
  enforceQuota: boolean;
  userId: number;
  username: string;
  ipAddress: string;
  onProgress?: ProgressCallback;
}): Promise<{ instance: VmInstanceRow; incusProvisioned: boolean; note?: string }> {
  const displayName = sanitizeDisplayName(params.name);
  if (!displayName || displayName.length < 2) {
    throw new Error('Instance name must be at least 2 characters.');
  }

  if (params.type !== 'container' && params.type !== 'vm') {
    throw new Error('Instance type must be container or vm.');
  }

  const template = INCUS_OS_TEMPLATES[params.osTemplate];
  if (!template) {
    throw new Error('Unsupported OS template.');
  }

  const vcpu = Number(params.vcpu);
  if (!Number.isInteger(vcpu) || vcpu < 1 || vcpu > 32) {
    throw new Error('vCPU count must be between 1 and 32.');
  }

  const ramMb = Number(params.ramMb);
  if (!Number.isInteger(ramMb) || ramMb < 256 || ramMb > 131072) {
    throw new Error('RAM must be between 256 MB and 131072 MB.');
  }

  const diskGb = Number(params.diskGb);
  if (!Number.isInteger(diskGb) || diskGb < 5 || diskGb > 2000) {
    throw new Error('Disk size must be between 5 GB and 2000 GB.');
  }

  if (!params.rootPassword || params.rootPassword.length < 6) {
    throw new Error('Root password must be at least 6 characters.');
  }

  if (params.enforceQuota) {
    const quota = getUserQuotaSummary(params.ownerId);
    if (quota.used.vmInstances + 1 > quota.limits.maxVmInstances) {
      throw new Error(
        `Quota exceeded: Maximum LXC/VM instances (${quota.limits.maxVmInstances}) reached.`
      );
    }
    if (quota.used.ramMb + ramMb > quota.limits.maxRamMb) {
      throw new Error(
        `Quota exceeded: Requested ${ramMb} MB RAM exceeds remaining budget (${Math.max(
          0,
          quota.limits.maxRamMb - quota.used.ramMb
        )} MB free).`
      );
    }
    if (quota.used.cpuPercent + vcpu * 100 > quota.limits.maxCpuPercent) {
      throw new Error(
        `Quota exceeded: Requested ${vcpu} vCPU (${vcpu * 100}%) exceeds CPU budget.`
      );
    }
    if (quota.used.diskGb + diskGb > quota.limits.maxDiskGb) {
      throw new Error(
        `Quota exceeded: Requested ${diskGb} GB disk exceeds remaining storage budget.`
      );
    }
  }

  const targetNodeId = params.nodeId ? Number(params.nodeId) : 1;
  const targetNode = getNodeById(targetNodeId);
  if (!targetNode) {
    throw new Error('Selected target VPS node does not exist.');
  }

  const emitStep = (step: number, label: string, status: 'running' | 'done' | 'error' = 'running', detail?: string) => {
    params.onProgress?.({ step, totalSteps: 5, label, status, detail });
  };

  const instanceName = slugifyContainerName(displayName, params.type === 'vm' ? 'vm' : 'lxc');
  const assignedSshPort = getNextFreeSharedPort('tcp');
  const hostIpv4 = targetNode.is_local === 0 ? targetNode.fqdn : await detectHostPublicIpv4();
  const encryptedPass = encryptSecret(params.rootPassword);

  let status = 'stopped';
  let internalIp: string | null = null;
  let incusProvisioned = false;
  let note: string | undefined;

  emitStep(1, `Pulling OS Image (${template.label})...`, 'running');

  if (targetNode.is_local === 0) {
    emitStep(2, `Allocating ${vcpu} vCPU, ${ramMb} MB RAM & ${diskGb} GB Disk Storage...`, 'running');
    const remoteRes = await dispatchNodeCommand<{ status?: string }>(
      targetNode.id,
      'incus:create',
      {
        image: template.image,
        instanceName,
        type: params.type,
        vcpu,
        ramMb,
        diskGb,
      },
      120000
    );
    emitStep(3, `Configuring Network & Shared IPv4 NAT Rules (SSH :${assignedSshPort})...`, 'running');
    emitStep(4, 'Setting Root Password & SSH Server...', 'running');
    status = remoteRes.status || 'running';
    incusProvisioned = true;
  } else {
    const incusUp = await isIncusReady();
    if (incusUp) {
      emitStep(2, `Allocating ${vcpu} vCPU, ${ramMb} MB RAM & ${diskGb} GB Disk Storage...`, 'running');
      const args = [
        'launch',
        template.image,
        instanceName,
        ...(params.type === 'vm' ? ['--vm'] : []),
        '-c',
        `limits.cpu=${vcpu}`,
        '-c',
        `limits.memory=${ramMb}MB`,
        '-d',
        `root,size=${diskGb}GB`,
      ];

      await execFileAsync('incus', args, { timeout: 120000 });

      emitStep(3, `Configuring Network & Shared IPv4 NAT Rules (SSH :${assignedSshPort})...`, 'running');
      await execFileAsync(
        'incus',
        [
          'config',
          'device',
          'add',
          instanceName,
          'ssh-port',
          'proxy',
          `listen=tcp:0.0.0.0:${assignedSshPort}`,
          'connect=tcp:127.0.0.1:22',
        ],
        { timeout: 10000 }
      ).catch(() => {});
      internalIp = await waitForInstanceIp(instanceName);

      emitStep(4, 'Setting Root Password & SSH Server...', 'running');
      await configureOpenSshInInstance(instanceName);
      try {
        await setRootPasswordInInstance(instanceName, params.rootPassword);
      } catch {
        // Agent may still be booting for VMs
      }

      status = 'running';
      incusProvisioned = true;
    } else {
      emitStep(2, `Allocating ${vcpu} vCPU, ${ramMb} MB RAM & ${diskGb} GB Disk Storage...`, 'running');
      emitStep(3, `Configuring Network & Shared IPv4 NAT Rules (SSH :${assignedSshPort})...`, 'running');
      emitStep(4, 'Registering Root Password & SSH Port Allocation...', 'running');
      note =
        'Instance specification and Shared IPv4 SSH port registered in SQLite. Install and initialize Incus on Ubuntu/Debian VPS using install.sh to launch live LXC/KVM instances.';
    }
  }

  const result = db.transaction(() => {
    const inserted = db
      .prepare(
        `INSERT INTO vm_instances
         (name, instance_name, type, os_template, vcpu, ram_mb, disk_gb, status, owner_id, node_id, ip_address, ssh_port, host_ipv4, encrypted_root_pass)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        displayName,
        instanceName,
        params.type,
        params.osTemplate,
        vcpu,
        ramMb,
        diskGb,
        status,
        params.ownerId,
        targetNode.id,
        internalIp,
        assignedSshPort,
        hostIpv4,
        encryptedPass
      );

    const newId = Number(inserted.lastInsertRowid);
    db.prepare(
      `INSERT OR IGNORE INTO port_allocations (resource_type, resource_id, host_port, target_port, protocol, device_name)
       VALUES ('incus', ?, ?, 22, 'tcp', 'ssh-port')`
    ).run(newId, assignedSshPort);

    return newId;
  })();

  const instance = db
    .prepare(
      `SELECT vi.id, vi.name, vi.instance_name, vi.type, vi.os_template, vi.vcpu, vi.ram_mb, vi.disk_gb,
              vi.status, vi.is_suspended, vi.owner_id, vi.node_id, vi.ip_address, vi.ssh_port, vi.host_ipv4, vi.created_at,
              u.username AS owner_username, n.name AS node_name, n.location AS node_location
       FROM vm_instances vi
       LEFT JOIN users u ON u.id = vi.owner_id
       LEFT JOIN nodes n ON n.id = vi.node_id
       WHERE vi.id = ?`
    )
    .get(result) as VmInstanceRow;

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.create',
    target: instanceName,
    details: `${params.type.toUpperCase()} (${template.label}, ${vcpu} vCPU, ${ramMb}MB, ${diskGb}GB, SSH :${assignedSshPort}, node=${targetNode.name})`,
    ipAddress: params.ipAddress,
  });

  if (status === 'running') {
    void sendDiscordAlert({
      event: 'start',
      title: `Incus ${params.type.toUpperCase()} Launched: ${displayName}`,
      description: `Instance \`${instanceName}\` (${template.label}) is running on **${targetNode.name}** (SSH \`${hostIpv4}:${assignedSshPort}\`).`,
    });
  }

  emitStep(
    5,
    incusProvisioned ? 'VPS Online & Ready!' : 'VPS Profile Registered (Incus CLI Offline)',
    'done',
    `SSH root@${hostIpv4} -p ${assignedSshPort}`
  );

  return { instance, incusProvisioned, note };
}

export async function controlIncusInstance(params: {
  id: number;
  action: 'start' | 'stop' | 'restart' | 'kill' | 'delete';
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ status: string; deleted?: boolean }> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  if (params.action === 'stop' || params.action === 'kill' || params.action === 'delete') {
    stopIncusSshx(inst.id);
  }

  if (inst.node_id && inst.node_id !== 1) {
    if (params.action === 'delete') {
      await dispatchNodeCommand(inst.node_id, 'incus:power', {
        instanceName: inst.instance_name,
        action: 'delete',
      }).catch(() => {});

      const vmBackupDir = path.join(getDataDir(), 'vm-backups', inst.instance_name);
      if (fs.existsSync(vmBackupDir)) {
        fs.rmSync(vmBackupDir, { recursive: true, force: true });
      }
      db.transaction(() => {
        db.prepare(`DELETE FROM port_allocations WHERE resource_type = 'incus' AND resource_id = ?`).run(
          inst.id
        );
        db.prepare('DELETE FROM vm_instances WHERE id = ?').run(inst.id);
      })();

      recordAuditLog({
        userId: params.userId,
        username: params.username,
        action: 'incus.delete',
        target: inst.instance_name,
        details: `Deleted remote instance '${inst.name}' (node#${inst.node_id})`,
        ipAddress: params.ipAddress,
      });
      return { status: 'deleted', deleted: true };
    }

    const remoteAction = params.action === 'kill' ? 'stop' : params.action;
    const remoteRes = await dispatchNodeCommand<{ status?: string }>(inst.node_id, 'incus:power', {
      instanceName: inst.instance_name,
      action: remoteAction,
    });
    const nextStatus = remoteRes.status || (remoteAction === 'stop' ? 'stopped' : 'running');
    db.prepare('UPDATE vm_instances SET status = ? WHERE id = ?').run(nextStatus, inst.id);

    recordAuditLog({
      userId: params.userId,
      username: params.username,
      action: `incus.${params.action}`,
      target: inst.instance_name,
      details: `Remote action on node#${inst.node_id}: ${params.action}`,
      ipAddress: params.ipAddress,
    });

    void sendDiscordAlert({
      event: remoteAction === 'stop' ? 'stop' : 'start',
      title: `Remote Instance ${params.action.toUpperCase()}: ${inst.name}`,
      description: `Instance \`${inst.instance_name}\` (${params.action}) by ${params.username}.`,
    });
    return { status: nextStatus };
  }

  const incusUp = await isIncusReady();

  if (params.action === 'delete') {
    if (incusUp) {
      try {
        await execFileAsync('incus', ['delete', inst.instance_name, '--force'], { timeout: 20000 });
      } catch {
        // Instance may already be gone
      }
    }
    const vmBackupDir = path.join(getDataDir(), 'vm-backups', inst.instance_name);
    if (fs.existsSync(vmBackupDir)) {
      fs.rmSync(vmBackupDir, { recursive: true, force: true });
    }
    db.transaction(() => {
      db.prepare(`DELETE FROM port_allocations WHERE resource_type = 'incus' AND resource_id = ?`).run(
        inst.id
      );
      db.prepare('DELETE FROM vm_instances WHERE id = ?').run(inst.id);
    })();

    recordAuditLog({
      userId: params.userId,
      username: params.username,
      action: 'incus.delete',
      target: inst.instance_name,
      details: `Deleted instance '${inst.name}'`,
      ipAddress: params.ipAddress,
    });

    return { status: 'deleted', deleted: true };
  }

  if (!incusUp) {
    throw new Error(
      'Incus CLI/daemon is unavailable on this host. Deploy on an Ubuntu/Debian VPS using install.sh to control live LXC/KVM instances.'
    );
  }

  if (params.action === 'start') {
    await execFileAsync('incus', ['start', inst.instance_name], { timeout: 20000 });
  } else if (params.action === 'stop') {
    await execFileAsync('incus', ['stop', inst.instance_name], { timeout: 20000 });
  } else if (params.action === 'kill') {
    await execFileAsync('incus', ['stop', inst.instance_name, '--force'], { timeout: 15000 });
  } else if (params.action === 'restart') {
    await execFileAsync('incus', ['restart', inst.instance_name], { timeout: 30000 });
  }

  const nextStatus = params.action === 'stop' || params.action === 'kill' ? 'stopped' : 'running';
  db.prepare('UPDATE vm_instances SET status = ? WHERE id = ?').run(nextStatus, inst.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: `incus.${params.action}`,
    target: inst.instance_name,
    details: `Instance action: ${params.action}`,
    ipAddress: params.ipAddress,
  });

  void sendDiscordAlert({
    event: nextStatus === 'stopped' ? 'stop' : 'start',
    title: `Incus Instance ${params.action.toUpperCase()}: ${inst.name}`,
    description: `Instance \`${inst.instance_name}\` action '${params.action}' executed by ${params.username}.`,
  });

  return { status: nextStatus };
}

export async function reinstallIncusInstance(params: {
  id: number;
  osTemplate: string;
  rootPassword: string;
  userId: number;
  username: string;
  ipAddress: string;
  onProgress?: ProgressCallback;
}): Promise<{ instance: VmInstanceRow; incusProvisioned: boolean; note?: string }> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const template = INCUS_OS_TEMPLATES[params.osTemplate];
  if (!template) throw new Error('Unsupported OS template.');

  if (!params.rootPassword || params.rootPassword.length < 6) {
    throw new Error('Root password must be at least 6 characters.');
  }

  const emitStep = (step: number, label: string, status: 'running' | 'done' | 'error' = 'running', detail?: string) => {
    params.onProgress?.({ step, totalSteps: 5, label, status, detail });
  };

  stopIncusSshx(inst.id);
  const incusUp = await isIncusReady();
  const savedPorts = listPortAllocations('incus', inst.id);
  const encryptedPass = encryptSecret(params.rootPassword);
  const hostIpv4 = inst.host_ipv4 || (await detectHostPublicIpv4());
  let incusProvisioned = false;
  let note: string | undefined;

  emitStep(1, `Pulling OS Image (${template.label})...`, 'running');

  if (incusUp) {
    try {
      await execFileAsync('incus', ['delete', inst.instance_name, '--force'], { timeout: 30000 });
    } catch {
      // Ignore if container already absent
    }

    emitStep(
      2,
      `Allocating ${inst.vcpu} vCPU, ${inst.ram_mb} MB RAM & ${inst.disk_gb} GB Disk Storage...`,
      'running'
    );

    const args = [
      'launch',
      template.image,
      inst.instance_name,
      ...(inst.type === 'vm' ? ['--vm'] : []),
      '-c',
      `limits.cpu=${inst.vcpu}`,
      '-c',
      `limits.memory=${inst.ram_mb}MB`,
      '-d',
      `root,size=${inst.disk_gb}GB`,
    ];

    if (inst.ip_address) {
      args.push('-d', `eth0,ipv4.address=${inst.ip_address}`);
    }

    await execFileAsync('incus', args, { timeout: 120000 });

    emitStep(
      3,
      `Restoring Network & ${savedPorts.length} Shared IPv4 NAT Rules...`,
      'running'
    );

    // Re-attach preserved NAT port forwards (including ssh-port)
    for (const rule of savedPorts) {
      await execFileAsync(
        'incus',
        [
          'config',
          'device',
          'add',
          inst.instance_name,
          rule.device_name,
          'proxy',
          `listen=${rule.protocol}:0.0.0.0:${rule.host_port}`,
          `connect=${rule.protocol}:127.0.0.1:${rule.target_port}`,
        ],
        { timeout: 10000 }
      ).catch(() => {});
    }

    emitStep(4, 'Setting Root Password, SSH Server & Authorized Keys...', 'running');
    await configureOpenSshInInstance(inst.instance_name);
    try {
      await setRootPasswordInInstance(inst.instance_name, params.rootPassword);
    } catch {
      // Ignore transient VM agent startup
    }
    await syncAuthorizedKeysToInstance(inst.id).catch(() => {});

    const refreshedIp = await waitForInstanceIp(inst.instance_name);
    db.prepare(
      `UPDATE vm_instances
       SET os_template = ?, status = 'running', ip_address = COALESCE(?, ip_address),
           host_ipv4 = ?, encrypted_root_pass = ?
       WHERE id = ?`
    ).run(params.osTemplate, refreshedIp, hostIpv4, encryptedPass, inst.id);
    incusProvisioned = true;
  } else {
    emitStep(2, `Preserving ${inst.vcpu} vCPU, ${inst.ram_mb} MB RAM & ${inst.disk_gb} GB Disk...`, 'running');
    emitStep(3, `Preserving ${savedPorts.length} Shared IPv4 NAT Rules...`, 'running');
    emitStep(4, 'Updating Root Credentials & OS Template...', 'running');
    db.prepare(
      `UPDATE vm_instances SET os_template = ?, host_ipv4 = ?, encrypted_root_pass = ? WHERE id = ?`
    ).run(params.osTemplate, hostIpv4, encryptedPass, inst.id);
    note =
      'OS template updated and port forward rules preserved in SQLite. Connect Incus on Ubuntu/Debian VPS to execute live container wipe & relaunch.';
  }

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.reinstall_os',
    target: inst.instance_name,
    details: `Reinstalled OS template to ${template.label} (kept ${savedPorts.length} port rules)`,
    ipAddress: params.ipAddress,
  });

  const updated = db
    .prepare(
      `SELECT vi.id, vi.name, vi.instance_name, vi.type, vi.os_template, vi.vcpu, vi.ram_mb, vi.disk_gb,
              vi.status, vi.is_suspended, vi.owner_id, vi.node_id, vi.ip_address, vi.ssh_port, vi.host_ipv4, vi.created_at,
              u.username AS owner_username, n.name AS node_name, n.location AS node_location
       FROM vm_instances vi
       LEFT JOIN users u ON u.id = vi.owner_id
       LEFT JOIN nodes n ON n.id = vi.node_id
       WHERE vi.id = ?`
    )
    .get(inst.id) as VmInstanceRow;

  emitStep(
    5,
    incusProvisioned ? 'VPS Online & Ready!' : 'Reinstall Profile Saved (Incus CLI Offline)',
    'done'
  );

  return { instance: updated, incusProvisioned, note };
}

export async function listInstanceSnapshots(
  id: number
): Promise<Array<{ name: string; created_at: string; stateful: boolean }>> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const incusUp = await isIncusReady();
  if (!incusUp) return [];

  try {
    const { stdout } = await execFileAsync('incus', ['snapshot', 'list', inst.instance_name, '--format=json'], {
      timeout: 5000,
    });
    const parsed = safeJsonParse<Array<{ name: string; created_at: string; stateful?: boolean }>>(stdout, []);
    return parsed.map((s) => ({
      name: s.name,
      created_at: s.created_at,
      stateful: Boolean(s.stateful),
    }));
  } catch {
    return [];
  }
}

export async function createInstanceSnapshot(params: {
  id: number;
  snapshotName: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  if (!isValidSnapshotName(params.snapshotName)) {
    throw new Error('Snapshot name must contain only letters, numbers, hyphens, or underscores.');
  }

  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const incusUp = await isIncusReady();
  if (!incusUp) {
    throw new Error('Incus daemon is unavailable on this host.');
  }

  await execFileAsync('incus', ['snapshot', 'create', inst.instance_name, params.snapshotName], {
    timeout: 20000,
  });

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.snapshot_create',
    target: inst.instance_name,
    details: `Created snapshot '${params.snapshotName}'`,
    ipAddress: params.ipAddress,
  });
}

export interface IncusBackupRow {
  id: number;
  instance_id: number;
  name: string;
  backup_kind: 'snapshot' | 'archive';
  archive_filename: string | null;
  size_bytes: number;
  backup_type: 'manual' | 'scheduled' | 'pre_restore';
  cloud_provider?: string;
  cloud_key?: string;
  created_by: string;
  created_at: string;
  exists_on_disk?: boolean;
}

function getVmBackupsDir(instanceName: string): string {
  const dir = path.join(getDataDir(), 'vm-backups', instanceName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function createIncusBackupOrSnapshot(params: {
  instanceId: number;
  name?: string;
  kind: 'snapshot' | 'archive';
  backupType?: 'manual' | 'scheduled' | 'pre_restore';
  createdBy: string;
  userId?: number | null;
  ipAddress?: string;
  retentionCount?: number;
}): Promise<IncusBackupRow> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const incusUp = await isIncusReady();
  if (!incusUp) {
    throw new Error('Incus daemon is unavailable on this host.');
  }

  const backupType = params.backupType || 'manual';
  const rawName = (params.name || '').trim();
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const safeName = rawName
    ? rawName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30)
    : `${backupType === 'scheduled' ? 'auto' : backupType === 'pre_restore' ? 'pre' : 'snap'}-${stamp}`;

  if (!isValidSnapshotName(safeName)) {
    throw new Error('Snapshot/backup name must contain only letters, numbers, hyphens, or underscores.');
  }

  let archiveFilename: string | null = null;
  let sizeBytes = 0;
  let cloudProvider = 'local';
  let cloudKey = '';

  if (params.kind === 'snapshot') {
    await execFileAsync('incus', ['snapshot', 'create', inst.instance_name, safeName], {
      timeout: 30000,
    });
  } else {
    const dir = getVmBackupsDir(inst.instance_name);
    archiveFilename = `${safeName}-${Date.now()}.tar.gz`;
    const destTarGz = resolveConfinedPath(dir, archiveFilename);
    await execFileAsync('incus', ['export', inst.instance_name, destTarGz], {
      timeout: 300000,
    });
    sizeBytes = fs.statSync(destTarGz).size;

    const cloudCfg = getCloudConfig();
    if (isCloudConfigured(cloudCfg) && cloudCfg.autoUpload) {
      try {
        const uploaded = await uploadBackupToCloud(
          destTarGz,
          `incus/${inst.instance_name}/${archiveFilename}`
        );
        cloudProvider = uploaded.provider;
        cloudKey = uploaded.key;
      } catch {
        // Keep local archive even if cloud offload fails temporarily
      }
    }
  }

  const res = db
    .prepare(
      `INSERT INTO incus_backups
       (instance_id, name, backup_kind, archive_filename, size_bytes, backup_type, created_by, cloud_provider, cloud_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      inst.id,
      safeName,
      params.kind,
      archiveFilename,
      sizeBytes,
      backupType,
      params.createdBy,
      cloudProvider,
      cloudKey
    );

  if (backupType === 'scheduled' && params.retentionCount && params.retentionCount > 0) {
    const oldRows = db
      .prepare(
        `SELECT id, name, backup_kind, archive_filename, cloud_provider, cloud_key FROM incus_backups
         WHERE instance_id = ? AND backup_type = 'scheduled' AND backup_kind = ?
         ORDER BY id DESC LIMIT -1 OFFSET ?`
      )
      .all(inst.id, params.kind, params.retentionCount) as Array<{
      id: number;
      name: string;
      backup_kind: 'snapshot' | 'archive';
      archive_filename: string | null;
      cloud_provider?: string;
      cloud_key?: string;
    }>;

    for (const old of oldRows) {
      if (old.backup_kind === 'snapshot') {
        await execFileAsync('incus', ['snapshot', 'delete', inst.instance_name, old.name], {
          timeout: 15000,
        }).catch(() => {});
      } else if (old.archive_filename) {
        try {
          const p = resolveConfinedPath(getVmBackupsDir(inst.instance_name), old.archive_filename);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
          // ignore
        }
        if (old.cloud_key) {
          await deleteBackupFromCloud(old.cloud_provider || 'none', old.cloud_key);
        }
      }
      db.prepare('DELETE FROM incus_backups WHERE id = ?').run(old.id);
    }
  }

  recordAuditLog({
    userId: params.userId ?? null,
    username: params.createdBy,
    action:
      backupType === 'scheduled'
        ? 'incus.scheduled_backup'
        : params.kind === 'snapshot'
        ? 'incus.snapshot_create'
        : 'incus.archive_create',
    target: inst.instance_name,
    details: `Created ${backupType} ${params.kind} '${safeName}'${
      cloudProvider !== 'local' ? ` (cloud=${cloudProvider})` : ''
    }`,
    ipAddress: params.ipAddress || '127.0.0.1',
  });

  const created = db
    .prepare('SELECT * FROM incus_backups WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as IncusBackupRow;

  return { ...created, exists_on_disk: true };
}

export async function listIncusBackupsAndSnapshots(instanceId: number): Promise<IncusBackupRow[]> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const incusUp = await isIncusReady();
  if (incusUp) {
    try {
      const { stdout } = await execFileAsync(
        'incus',
        ['snapshot', 'list', inst.instance_name, '--format=json'],
        { timeout: 5000 }
      );
      const liveSnaps = safeJsonParse<Array<{ name: string; created_at: string }>>(stdout, []);
      const existingSnapNames = new Set(
        (
          db
            .prepare(
              `SELECT name FROM incus_backups WHERE instance_id = ? AND backup_kind = 'snapshot'`
            )
            .all(inst.id) as Array<{ name: string }>
        ).map((r) => r.name)
      );

      for (const s of liveSnaps) {
        if (!existingSnapNames.has(s.name)) {
          db.prepare(
            `INSERT INTO incus_backups (instance_id, name, backup_kind, size_bytes, backup_type, created_by, created_at)
             VALUES (?, ?, 'snapshot', 0, 'manual', 'incus', ?)`
          ).run(inst.id, s.name, s.created_at || new Date().toISOString());
        }
      }
    } catch {
      // Ignore transient snapshot list error
    }
  }

  const rows = db
    .prepare('SELECT * FROM incus_backups WHERE instance_id = ? ORDER BY id DESC')
    .all(inst.id) as IncusBackupRow[];

  const dir = path.join(getDataDir(), 'vm-backups', inst.instance_name);
  return rows.map((r) => {
    let existsOnDisk = true;
    if (r.backup_kind === 'archive' && r.archive_filename) {
      try {
        existsOnDisk = fs.existsSync(resolveConfinedPath(dir, r.archive_filename));
      } catch {
        existsOnDisk = false;
      }
    }
    return { ...r, exists_on_disk: existsOnDisk };
  });
}

export async function restoreIncusBackup(params: {
  instanceId: number;
  backupId: number;
  createPreRestore?: boolean;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ restored: boolean; preRestoreSnapshot?: IncusBackupRow }> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const row = db
    .prepare('SELECT * FROM incus_backups WHERE id = ? AND instance_id = ?')
    .get(params.backupId, inst.id) as IncusBackupRow | undefined;
  if (!row) throw new Error('Snapshot or backup point not found.');

  const incusUp = await isIncusReady();
  if (!incusUp) {
    throw new Error('Incus daemon is unavailable on this host.');
  }

  let preRestoreSnapshot: IncusBackupRow | undefined;
  if (params.createPreRestore !== false && row.backup_kind === 'snapshot') {
    try {
      preRestoreSnapshot = await createIncusBackupOrSnapshot({
        instanceId: inst.id,
        name: `pre-restore-${Date.now().toString(36)}`,
        kind: 'snapshot',
        backupType: 'pre_restore',
        createdBy: params.username,
        userId: params.userId,
        ipAddress: params.ipAddress,
      });
    } catch {
      // Proceed even if safety snapshot failed
    }
  }

  if (row.backup_kind === 'snapshot') {
    await execFileAsync('incus', ['snapshot', 'restore', inst.instance_name, row.name], {
      timeout: 30000,
    });
  } else {
    if (!row.archive_filename) {
      throw new Error('Archive filename missing.');
    }
    const tarPath = resolveConfinedPath(getVmBackupsDir(inst.instance_name), row.archive_filename);
    if (!fs.existsSync(tarPath)) {
      if (row.cloud_key && row.cloud_provider && row.cloud_provider !== 'local') {
        await downloadBackupFromCloud(row.cloud_provider, row.cloud_key, tarPath);
      } else {
        throw new Error('Backup archive file is missing on disk.');
      }
    }

    const savedPorts = listPortAllocations('incus', inst.id);
    await execFileAsync('incus', ['delete', inst.instance_name, '--force'], {
      timeout: 30000,
    }).catch(() => {});

    await execFileAsync('incus', ['import', tarPath, inst.instance_name], {
      timeout: 300000,
    });

    for (const rule of savedPorts) {
      await execFileAsync(
        'incus',
        [
          'config',
          'device',
          'add',
          inst.instance_name,
          rule.device_name,
          'proxy',
          `listen=${rule.protocol}:0.0.0.0:${rule.host_port}`,
          `connect=${rule.protocol}:127.0.0.1:${rule.target_port}`,
        ],
        { timeout: 10000 }
      ).catch(() => {});
    }

    await execFileAsync('incus', ['start', inst.instance_name], { timeout: 20000 }).catch(() => {});
    db.prepare(`UPDATE vm_instances SET status = 'running' WHERE id = ?`).run(inst.id);
  }

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: row.backup_kind === 'snapshot' ? 'incus.snapshot_restore' : 'incus.archive_restore',
    target: inst.instance_name,
    details: `Restored point-in-time ${row.backup_kind} '${row.name}'`,
    ipAddress: params.ipAddress,
  });

  return { restored: true, preRestoreSnapshot };
}

export async function uploadIncusBackupToCloud(params: {
  instanceId: number;
  backupId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<IncusBackupRow> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const row = db
    .prepare(
      `SELECT * FROM incus_backups WHERE id = ? AND instance_id = ? AND backup_kind = 'archive'`
    )
    .get(params.backupId, inst.id) as IncusBackupRow | undefined;
  if (!row || !row.archive_filename) {
    throw new Error('Only downloadable .tar.gz VM/LXC archives can be uploaded to cloud storage.');
  }

  const filePath = resolveConfinedPath(getVmBackupsDir(inst.instance_name), row.archive_filename);
  if (!fs.existsSync(filePath)) {
    throw new Error('Local archive file must exist on disk to upload to cloud.');
  }

  const uploaded = await uploadBackupToCloud(
    filePath,
    `incus/${inst.instance_name}/${row.archive_filename}`
  );
  db.prepare('UPDATE incus_backups SET cloud_provider = ?, cloud_key = ? WHERE id = ?').run(
    uploaded.provider,
    uploaded.key,
    row.id
  );

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.archive_cloud_upload',
    target: inst.instance_name,
    details: `Offloaded VM archive '${row.archive_filename}' to ${uploaded.provider.toUpperCase()}`,
    ipAddress: params.ipAddress,
  });

  const updated = db.prepare('SELECT * FROM incus_backups WHERE id = ?').get(row.id) as IncusBackupRow;
  return { ...updated, exists_on_disk: true };
}

export async function deleteIncusBackup(params: {
  instanceId: number;
  backupId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const row = db
    .prepare('SELECT * FROM incus_backups WHERE id = ? AND instance_id = ?')
    .get(params.backupId, inst.id) as IncusBackupRow | undefined;
  if (!row) throw new Error('Backup or snapshot not found.');

  if (row.backup_kind === 'snapshot') {
    const incusUp = await isIncusReady();
    if (!incusUp) {
      throw new Error('Incus daemon is unavailable on this host.');
    }
    await execFileAsync('incus', ['snapshot', 'delete', inst.instance_name, row.name], {
      timeout: 15000,
    }).catch(() => {});
  } else if (row.archive_filename) {
    const filePath = resolveConfinedPath(getVmBackupsDir(inst.instance_name), row.archive_filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (row.cloud_key && row.cloud_provider && row.cloud_provider !== 'local') {
      await deleteBackupFromCloud(row.cloud_provider, row.cloud_key);
    }
  }

  db.prepare('DELETE FROM incus_backups WHERE id = ?').run(row.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: row.backup_kind === 'snapshot' ? 'incus.snapshot_delete' : 'incus.archive_delete',
    target: inst.instance_name,
    details: `Deleted ${row.backup_kind} '${row.name}'`,
    ipAddress: params.ipAddress,
  });
}

export async function getIncusBackupArchivePath(
  instanceId: number,
  backupId: number
): Promise<{
  filePath: string;
  filename: string;
}> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const row = db
    .prepare(
      `SELECT * FROM incus_backups WHERE id = ? AND instance_id = ? AND backup_kind = 'archive'`
    )
    .get(backupId, inst.id) as IncusBackupRow | undefined;
  if (!row || !row.archive_filename) {
    throw new Error('Backup archive not found.');
  }

  const filePath = resolveConfinedPath(getVmBackupsDir(inst.instance_name), row.archive_filename);
  if (!fs.existsSync(filePath)) {
    if (row.cloud_key && row.cloud_provider && row.cloud_provider !== 'local') {
      await downloadBackupFromCloud(row.cloud_provider, row.cloud_key, filePath);
    } else {
      throw new Error('Backup archive file is missing on disk.');
    }
  }
  return { filePath, filename: row.archive_filename };
}

export async function restoreInstanceSnapshot(params: {
  id: number;
  snapshotName: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  if (!isValidSnapshotName(params.snapshotName)) {
    throw new Error('Invalid snapshot name.');
  }

  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const incusUp = await isIncusReady();
  if (!incusUp) {
    throw new Error('Incus daemon is unavailable on this host.');
  }

  await execFileAsync('incus', ['snapshot', 'restore', inst.instance_name, params.snapshotName], {
    timeout: 20000,
  });

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.snapshot_restore',
    target: inst.instance_name,
    details: `Restored snapshot '${params.snapshotName}'`,
    ipAddress: params.ipAddress,
  });
}

export async function deleteInstanceSnapshot(params: {
  id: number;
  snapshotName: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  if (!isValidSnapshotName(params.snapshotName)) {
    throw new Error('Invalid snapshot name.');
  }

  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const incusUp = await isIncusReady();
  if (!incusUp) {
    throw new Error('Incus daemon is unavailable on this host.');
  }

  await execFileAsync('incus', ['snapshot', 'delete', inst.instance_name, params.snapshotName], {
    timeout: 15000,
  });

  db.prepare(
    `DELETE FROM incus_backups WHERE instance_id = ? AND name = ? AND backup_kind = 'snapshot'`
  ).run(inst.id, params.snapshotName);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.snapshot_delete',
    target: inst.instance_name,
    details: `Deleted snapshot '${params.snapshotName}'`,
    ipAddress: params.ipAddress,
  });
}

export function listPortAllocations(resourceType: 'minecraft' | 'incus', resourceId: number): PortAllocationRow[] {
  return db
    .prepare(
      `SELECT * FROM port_allocations WHERE resource_type = ? AND resource_id = ? ORDER BY host_port ASC`
    )
    .all(resourceType, resourceId) as PortAllocationRow[];
}

export async function addIncusPortForward(params: {
  id: number;
  hostPort: number;
  targetPort: number;
  protocol: 'tcp' | 'udp';
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<PortAllocationRow> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  if (!isValidPort(params.hostPort)) {
    throw new Error('Host port must be between 1024 and 65535.');
  }
  const targetPort = Number(params.targetPort);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error('Target port must be between 1 and 65535.');
  }
  if (params.protocol !== 'tcp' && params.protocol !== 'udp') {
    throw new Error('Protocol must be tcp or udp.');
  }

  const conflict = db
    .prepare('SELECT id FROM port_allocations WHERE host_port = ? AND protocol = ?')
    .get(params.hostPort, params.protocol);
  if (conflict) {
    throw new Error(`Port ${params.hostPort}/${params.protocol} is already allocated.`);
  }

  const deviceName = `proxy-${params.protocol}-${params.hostPort}`;
  const incusUp = await isIncusReady();

  if (incusUp) {
    await execFileAsync(
      'incus',
      [
        'config',
        'device',
        'add',
        inst.instance_name,
        deviceName,
        'proxy',
        `listen=${params.protocol}:0.0.0.0:${params.hostPort}`,
        `connect=${params.protocol}:127.0.0.1:${targetPort}`,
      ],
      { timeout: 10000 }
    );
  }

  const res = db
    .prepare(
      `INSERT INTO port_allocations (resource_type, resource_id, host_port, target_port, protocol, device_name)
       VALUES ('incus', ?, ?, ?, ?, ?)`
    )
    .run(inst.id, params.hostPort, targetPort, params.protocol, deviceName);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.port_add',
    target: inst.instance_name,
    details: `NAT ${params.hostPort}/${params.protocol} -> ${targetPort}`,
    ipAddress: params.ipAddress,
  });

  return db
    .prepare('SELECT * FROM port_allocations WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as PortAllocationRow;
}

export async function removeIncusPortForward(params: {
  id: number;
  allocationId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const alloc = db
    .prepare(
      `SELECT * FROM port_allocations WHERE id = ? AND resource_type = 'incus' AND resource_id = ?`
    )
    .get(params.allocationId, inst.id) as PortAllocationRow | undefined;
  if (!alloc) throw new Error('Port rule not found.');

  const incusUp = await isIncusReady();
  if (incusUp) {
    try {
      await execFileAsync(
        'incus',
        ['config', 'device', 'remove', inst.instance_name, alloc.device_name],
        { timeout: 10000 }
      );
    } catch {
      // Device may already be removed
    }
  }

  db.prepare('DELETE FROM port_allocations WHERE id = ?').run(alloc.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.port_remove',
    target: inst.instance_name,
    details: `Removed NAT ${alloc.host_port}/${alloc.protocol}`,
    ipAddress: params.ipAddress,
  });
}

export function buildReverseProxyConfig(
  proxy: { domain: string; target_port: number; ssl_enabled: number; engine: 'caddy' | 'nginx' },
  internalIp: string
): string {
  const upstream = `${internalIp}:${proxy.target_port}`;
  if (proxy.engine === 'caddy') {
    return [
      `${proxy.ssl_enabled ? proxy.domain : `http://${proxy.domain}`} {`,
      `  reverse_proxy ${upstream}`,
      `  encode zstd gzip`,
      `}`,
    ].join('\n');
  }
  return [
    `server {`,
    `  listen ${proxy.ssl_enabled ? '443 ssl http2' : '80'};`,
    `  server_name ${proxy.domain};`,
    ...(proxy.ssl_enabled
      ? [
          `  ssl_certificate /etc/letsencrypt/live/${proxy.domain}/fullchain.pem;`,
          `  ssl_certificate_key /etc/letsencrypt/live/${proxy.domain}/privkey.pem;`,
        ]
      : []),
    `  location / {`,
    `    proxy_pass http://${upstream};`,
    `    proxy_set_header Host $host;`,
    `    proxy_set_header X-Real-IP $remote_addr;`,
    `    proxy_set_header X-Forwarded-Proto $scheme;`,
    `  }`,
    `}`,
  ].join('\n');
}

export function listReverseProxies(instanceId: number): Array<ReverseProxyRow & { configPreview: string }> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(instanceId) as
    | VmInstanceRow
    | undefined;
  const rows = db
    .prepare('SELECT * FROM reverse_proxies WHERE instance_id = ? ORDER BY id DESC')
    .all(instanceId) as ReverseProxyRow[];
  const ip = inst?.ip_address || '127.0.0.1';
  return rows.map((r) => ({
    ...r,
    configPreview: buildReverseProxyConfig(r, ip),
  }));
}

export async function createReverseProxy(params: {
  instanceId: number;
  domain: string;
  targetPort: number;
  sslEnabled: boolean;
  engine: 'caddy' | 'nginx';
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<ReverseProxyRow & { configPreview: string; appliedOnHost: boolean }> {
  if (!isValidDomain(params.domain)) {
    throw new Error('Invalid domain or subdomain format.');
  }
  const targetPort = Number(params.targetPort);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error('Target port must be between 1 and 65535.');
  }
  if (params.engine !== 'caddy' && params.engine !== 'nginx') {
    throw new Error('Proxy engine must be caddy or nginx.');
  }

  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const cleanDomain = params.domain.trim().toLowerCase();
  const exists = db.prepare('SELECT id FROM reverse_proxies WHERE domain = ?').get(cleanDomain);
  if (exists) {
    throw new Error(`Domain '${cleanDomain}' is already routed.`);
  }

  const res = db
    .prepare(
      `INSERT INTO reverse_proxies (instance_id, domain, target_port, ssl_enabled, engine)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(inst.id, cleanDomain, targetPort, params.sslEnabled ? 1 : 0, params.engine);

  const created = db
    .prepare('SELECT * FROM reverse_proxies WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as ReverseProxyRow;

  const configPreview = buildReverseProxyConfig(created, inst.ip_address || '127.0.0.1');
  let appliedOnHost = false;

  try {
    const dir = params.engine === 'caddy' ? '/etc/caddy/conf.d' : '/etc/nginx/conf.d';
    if (fs.existsSync(dir)) {
      fs.writeFileSync(path.join(dir, `fbbahi-${cleanDomain}.conf`), configPreview + '\n', 'utf8');
      if (params.engine === 'caddy') {
        await execFileAsync('systemctl', ['reload', 'caddy'], { timeout: 5000 }).catch(() => {});
      } else {
        await execFileAsync('systemctl', ['reload', 'nginx'], { timeout: 5000 }).catch(() => {});
      }
      appliedOnHost = true;
    }
  } catch {
    appliedOnHost = false;
  }

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.proxy_create',
    target: inst.instance_name,
    details: `${params.engine.toUpperCase()} route ${cleanDomain} -> :${targetPort}`,
    ipAddress: params.ipAddress,
  });

  return { ...created, configPreview, appliedOnHost };
}

export function deleteReverseProxy(params: {
  instanceId: number;
  proxyId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): void {
  const row = db
    .prepare('SELECT * FROM reverse_proxies WHERE id = ? AND instance_id = ?')
    .get(params.proxyId, params.instanceId) as ReverseProxyRow | undefined;
  if (!row) throw new Error('Reverse proxy rule not found.');

  const dir = row.engine === 'caddy' ? '/etc/caddy/conf.d' : '/etc/nginx/conf.d';
  const filePath = path.join(dir, `fbbahi-${row.domain}.conf`);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore host file errors
  }

  db.prepare('DELETE FROM reverse_proxies WHERE id = ?').run(row.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.proxy_delete',
    target: `instance#${params.instanceId}`,
    details: `Removed domain route ${row.domain}`,
    ipAddress: params.ipAddress,
  });
}

interface PrevTelemetrySample {
  cpuNs: number;
  rxBytes: number;
  txBytes: number;
  ts: number;
  kernel?: string;
}
const prevTelemetrySamples = new Map<string, PrevTelemetrySample>();

export async function getIncusInstanceTelemetry(id: number): Promise<VmTelemetry> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const hostIpv4 = inst.host_ipv4 || (await detectHostPublicIpv4());
  const base: VmTelemetry = {
    instanceId: inst.id,
    live: false,
    status: inst.status,
    cpuPercent: 0,
    ramUsedMb: 0,
    ramLimitMb: inst.ram_mb,
    swapUsedMb: 0,
    swapTotalMb: 0,
    diskUsedGb: 0,
    diskTotalGb: inst.disk_gb,
    netRxBytesPerSec: 0,
    netTxBytesPerSec: 0,
    netTotalRxBytes: 0,
    netTotalTxBytes: 0,
    uptimeSeconds: 0,
    kernel: '--',
    internalIp: inst.ip_address,
    hostIpv4,
    sshPort: inst.ssh_port ?? null,
    timestamp: Date.now(),
  };

  const incusUp = await isIncusReady();
  if (!incusUp || inst.status !== 'running' || (inst.node_id && inst.node_id !== 1)) {
    return base;
  }

  try {
    const { stdout } = await execFileAsync('incus', ['list', inst.instance_name, '--format=json'], {
      timeout: 3000,
    });
    const parsed = safeJsonParse<
      Array<{
        status?: string;
        state?: {
          memory?: { usage?: number; swap_usage?: number };
          cpu?: { usage?: number };
          disk?: Record<string, { usage?: number; total?: number }>;
          network?: Record<
            string,
            {
              addresses?: Array<{ family: string; address: string; scope: string }>;
              counters?: { bytes_received?: number; bytes_sent?: number };
            }
          >;
        };
      }>
    >(stdout, []);

    const item = parsed[0];
    if (!item || !item.state) return base;

    const now = Date.now();
    const cpuNs = item.state.cpu?.usage || 0;
    const ramUsedMb = Math.round((item.state.memory?.usage || 0) / (1024 * 1024));
    let swapUsedMb = Math.round((item.state.memory?.swap_usage || 0) / (1024 * 1024));
    let swapTotalMb = 0;

    let internalIp: string | null = inst.ip_address;
    let totalRx = 0;
    let totalTx = 0;

    if (item.state.network) {
      for (const [iface, netInfo] of Object.entries(item.state.network)) {
        if (iface === 'lo') continue;
        totalRx += netInfo.counters?.bytes_received || 0;
        totalTx += netInfo.counters?.bytes_sent || 0;
        const v4 = netInfo.addresses?.find((a) => a.family === 'inet' && a.scope === 'global');
        if (v4) internalIp = v4.address;
      }
    }

    let diskUsedGb = 0;
    let diskTotalGb = inst.disk_gb;
    if (item.state.disk?.root?.usage) {
      diskUsedGb = Number((item.state.disk.root.usage / (1024 * 1024 * 1024)).toFixed(2));
    }

    const prev = prevTelemetrySamples.get(inst.instance_name);
    let cpuPercent = 0;
    let netRxBytesPerSec = 0;
    let netTxBytesPerSec = 0;

    if (prev && now > prev.ts) {
      const elapsedMs = now - prev.ts;
      const cpuDeltaNs = Math.max(0, cpuNs - prev.cpuNs);
      const rawCpuPct = (cpuDeltaNs / (elapsedMs * 1_000_000 * Math.max(1, inst.vcpu))) * 100;
      cpuPercent = Number(Math.min(100, Math.max(0, rawCpuPct)).toFixed(1));

      const elapsedSec = elapsedMs / 1000;
      netRxBytesPerSec = Math.max(0, Math.round((totalRx - prev.rxBytes) / elapsedSec));
      netTxBytesPerSec = Math.max(0, Math.round((totalTx - prev.txBytes) / elapsedSec));
    }

    let uptimeSeconds = 0;
    let kernel = prev?.kernel || '--';
    try {
      const procScript =
        'uname -r; cat /proc/uptime; grep -E "^(SwapTotal|SwapFree):" /proc/meminfo; df -k / | tail -1';
      const { stdout: procOut } = await execFileAsync(
        'incus',
        ['exec', inst.instance_name, '--', '/bin/sh', '-c', procScript],
        { timeout: 2000 }
      );
      const lines = procOut.trim().split('\n');
      if (lines[0]) kernel = lines[0].trim();
      if (lines[1]) {
        const upSec = parseFloat(lines[1].trim().split(/\s+/)[0] || '0');
        if (Number.isFinite(upSec)) uptimeSeconds = Math.floor(upSec);
      }
      let swapTotalKb = 0;
      let swapFreeKb = 0;
      for (const line of lines.slice(2)) {
        if (line.startsWith('SwapTotal:')) {
          swapTotalKb = parseInt(line.replace(/[^\d]/g, ''), 10) || 0;
        } else if (line.startsWith('SwapFree:')) {
          swapFreeKb = parseInt(line.replace(/[^\d]/g, ''), 10) || 0;
        }
      }
      if (swapTotalKb > 0) {
        swapTotalMb = Math.round(swapTotalKb / 1024);
        swapUsedMb = Math.round(Math.max(0, swapTotalKb - swapFreeKb) / 1024);
      }
      const dfLine = lines[lines.length - 1];
      const dfParts = dfLine.trim().split(/\s+/);
      if (dfParts.length >= 4 && /^\d+$/.test(dfParts[1]) && /^\d+$/.test(dfParts[2])) {
        const totKb = Number(dfParts[1]);
        const usedKb = Number(dfParts[2]);
        diskTotalGb = Number((totKb / (1024 * 1024)).toFixed(2)) || inst.disk_gb;
        diskUsedGb = Number((usedKb / (1024 * 1024)).toFixed(2));
      }
    } catch {
      // Keep base container stats if quick /proc inspect fails
    }

    prevTelemetrySamples.set(inst.instance_name, {
      cpuNs,
      rxBytes: totalRx,
      txBytes: totalTx,
      ts: now,
      kernel,
    });

    return {
      instanceId: inst.id,
      live: true,
      status: (item.status || 'running').toLowerCase(),
      cpuPercent,
      ramUsedMb,
      ramLimitMb: inst.ram_mb,
      swapUsedMb,
      swapTotalMb,
      diskUsedGb,
      diskTotalGb,
      netRxBytesPerSec,
      netTxBytesPerSec,
      netTotalRxBytes: totalRx,
      netTotalTxBytes: totalTx,
      uptimeSeconds,
      kernel,
      internalIp,
      hostIpv4,
      sshPort: inst.ssh_port ?? null,
      timestamp: now,
    };
  } catch {
    return base;
  }
}

export async function getIncusInstanceMetrics(id: number): Promise<VmTelemetry> {
  return getIncusInstanceTelemetry(id);
}

export async function renameIncusInstance(params: {
  id: number;
  newName: string;
  newHostname?: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<VmInstanceRow> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const cleanDisplay = sanitizeDisplayName(params.newName);
  if (!cleanDisplay || cleanDisplay.length < 2) {
    throw new Error('New instance name must be at least 2 characters.');
  }

  let nextInstanceName = inst.instance_name;
  if (params.newHostname && params.newHostname.trim()) {
    const candidate = params.newHostname.trim().toLowerCase();
    if (!CONTAINER_NAME_REGEX.test(candidate)) {
      throw new Error('Hostname must be 3-31 chars (letters, numbers, hyphens, underscores).');
    }
    nextInstanceName = candidate;
  }

  if (nextInstanceName !== inst.instance_name) {
    const conflict = db
      .prepare('SELECT id FROM vm_instances WHERE instance_name = ? AND id != ?')
      .get(nextInstanceName, inst.id);
    if (conflict) {
      throw new Error(`Hostname '${nextInstanceName}' is already in use.`);
    }

    const incusUp = await isIncusReady();
    const wasRunning = inst.status === 'running';
    if (incusUp && (!inst.node_id || inst.node_id === 1)) {
      if (wasRunning) {
        await execFileAsync('incus', ['stop', inst.instance_name], { timeout: 25000 }).catch(() => {});
      }
      await execFileAsync('incus', ['rename', inst.instance_name, nextInstanceName], {
        timeout: 20000,
      });
      if (wasRunning) {
        await execFileAsync('incus', ['start', nextInstanceName], { timeout: 25000 }).catch(() => {});
        await execFileAsync(
          'incus',
          [
            'exec',
            nextInstanceName,
            '--',
            '/bin/sh',
            '-c',
            'printf "%s\\n" "$1" > /etc/hostname && hostname "$1" 2>/dev/null || true',
            '--',
            nextInstanceName,
          ],
          { timeout: 8000 }
        ).catch(() => {});
      }
    }

    const oldBackupDir = path.join(getDataDir(), 'vm-backups', inst.instance_name);
    const newBackupDir = path.join(getDataDir(), 'vm-backups', nextInstanceName);
    if (fs.existsSync(oldBackupDir) && !fs.existsSync(newBackupDir)) {
      fs.renameSync(oldBackupDir, newBackupDir);
    }
  }

  db.prepare('UPDATE vm_instances SET name = ?, instance_name = ? WHERE id = ?').run(
    cleanDisplay,
    nextInstanceName,
    inst.id
  );

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.rename',
    target: nextInstanceName,
    details: `Renamed '${inst.name}' (${inst.instance_name}) -> '${cleanDisplay}' (${nextInstanceName})`,
    ipAddress: params.ipAddress,
  });

  return db
    .prepare(
      `SELECT vi.id, vi.name, vi.instance_name, vi.type, vi.os_template, vi.vcpu, vi.ram_mb, vi.disk_gb,
              vi.status, vi.is_suspended, vi.owner_id, vi.node_id, vi.ip_address, vi.ssh_port, vi.host_ipv4, vi.created_at,
              u.username AS owner_username, n.name AS node_name, n.location AS node_location
       FROM vm_instances vi
       LEFT JOIN users u ON u.id = vi.owner_id
       LEFT JOIN nodes n ON n.id = vi.node_id
       WHERE vi.id = ?`
    )
    .get(inst.id) as VmInstanceRow;
}

export async function getIncusSshDetails(id: number): Promise<{
  hostIpv4: string;
  sshPort: number | null;
  internalIp: string | null;
  rootPassword: string;
  keys: VmSshKeyRow[];
}> {
  const row = db
    .prepare(
      `SELECT id, ip_address, ssh_port, host_ipv4, encrypted_root_pass, node_id
       FROM vm_instances WHERE id = ?`
    )
    .get(id) as
    | {
        id: number;
        ip_address: string | null;
        ssh_port: number | null;
        host_ipv4: string | null;
        encrypted_root_pass: string | null;
        node_id: number;
      }
    | undefined;
  if (!row) throw new Error('Instance not found.');

  let sshPort = row.ssh_port;
  if (!sshPort) {
    const existingPort = db
      .prepare(
        `SELECT host_port FROM port_allocations WHERE resource_type = 'incus' AND resource_id = ? AND target_port = 22 LIMIT 1`
      )
      .get(row.id) as { host_port: number } | undefined;
    sshPort = existingPort?.host_port ?? null;
  }

  const hostIpv4 = row.host_ipv4 || (await detectHostPublicIpv4());
  const keys = db
    .prepare('SELECT * FROM vm_ssh_keys WHERE instance_id = ? ORDER BY id DESC')
    .all(id) as VmSshKeyRow[];

  return {
    hostIpv4,
    sshPort,
    internalIp: row.ip_address,
    rootPassword: decryptSecret(row.encrypted_root_pass),
    keys,
  };
}

export async function resetIncusRootPassword(params: {
  id: number;
  newPassword: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ appliedLive: boolean }> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.id) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');
  if (!params.newPassword || params.newPassword.length < 6) {
    throw new Error('Root password must be at least 6 characters.');
  }

  let appliedLive = false;
  const incusUp = await isIncusReady();
  if (incusUp && inst.status === 'running' && (!inst.node_id || inst.node_id === 1)) {
    await configureOpenSshInInstance(inst.instance_name);
    await setRootPasswordInInstance(inst.instance_name, params.newPassword);
    appliedLive = true;
  }

  db.prepare('UPDATE vm_instances SET encrypted_root_pass = ? WHERE id = ?').run(
    encryptSecret(params.newPassword),
    inst.id
  );

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.ssh_password_reset',
    target: inst.instance_name,
    details: appliedLive ? 'Reset live root password' : 'Updated stored root password',
    ipAddress: params.ipAddress,
  });

  return { appliedLive };
}

async function syncAuthorizedKeysToInstance(instanceId: number): Promise<boolean> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) return false;

  const incusUp = await isIncusReady();
  if (!incusUp || inst.status !== 'running' || (inst.node_id && inst.node_id !== 1)) {
    return false;
  }

  const keys = db
    .prepare('SELECT public_key FROM vm_ssh_keys WHERE instance_id = ? ORDER BY id ASC')
    .all(instanceId) as Array<{ public_key: string }>;

  const content = keys.map((k) => k.public_key.trim()).join('\n') + (keys.length ? '\n' : '');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbbahi-ssh-'));
  const tmpFile = path.join(tmpDir, 'authorized_keys');
  try {
    fs.writeFileSync(tmpFile, content, { mode: 0o600 });
    await execFileAsync(
      'incus',
      ['exec', inst.instance_name, '--', 'sh', '-c', 'mkdir -p /root/.ssh && chmod 700 /root/.ssh'],
      { timeout: 8000 }
    );
    await execFileAsync(
      'incus',
      ['file', 'push', tmpFile, `${inst.instance_name}/root/.ssh/authorized_keys`],
      { timeout: 8000 }
    );
    await execFileAsync(
      'incus',
      ['exec', inst.instance_name, '--', 'chmod', '600', '/root/.ssh/authorized_keys'],
      { timeout: 8000 }
    );
    return true;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function addVmSshKey(params: {
  instanceId: number;
  label: string;
  publicKey: string;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ key: VmSshKeyRow; syncedLive: boolean }> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const cleanKey = String(params.publicKey || '').trim();
  if (!SSH_PUBLIC_KEY_REGEX.test(cleanKey)) {
    throw new Error('Invalid SSH public key format (expected ssh-ed25519, ssh-rsa, or ecdsa).');
  }
  const cleanLabel = sanitizeDisplayName(params.label) || 'My SSH Key';

  const keyBody = cleanKey.split(/\s+/)[1] || cleanKey;
  const fingerprint =
    'SHA256:' + crypto.createHash('sha256').update(Buffer.from(keyBody, 'base64')).digest('base64').replace(/=+$/, '');

  const res = db
    .prepare(
      `INSERT INTO vm_ssh_keys (instance_id, label, public_key, fingerprint) VALUES (?, ?, ?, ?)`
    )
    .run(inst.id, cleanLabel, cleanKey, fingerprint);

  const syncedLive = await syncAuthorizedKeysToInstance(inst.id).catch(() => false);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.ssh_key_add',
    target: inst.instance_name,
    details: `Added SSH key '${cleanLabel}' (${fingerprint})`,
    ipAddress: params.ipAddress,
  });

  const row = db
    .prepare('SELECT * FROM vm_ssh_keys WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as VmSshKeyRow;
  return { key: row, syncedLive };
}

export async function removeVmSshKey(params: {
  instanceId: number;
  keyId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  const row = db
    .prepare('SELECT * FROM vm_ssh_keys WHERE id = ? AND instance_id = ?')
    .get(params.keyId, params.instanceId) as VmSshKeyRow | undefined;
  if (!row) throw new Error('SSH key not found.');

  db.prepare('DELETE FROM vm_ssh_keys WHERE id = ?').run(row.id);
  await syncAuthorizedKeysToInstance(params.instanceId).catch(() => {});

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.ssh_key_remove',
    target: `instance#${params.instanceId}`,
    details: `Removed SSH key '${row.label}'`,
    ipAddress: params.ipAddress,
  });
}

const activeSshxSessions = new Map<number, { url: string; proc: ChildProcess; startedAt: string }>();

export function stopIncusSshx(instanceId: number): boolean {
  const existing = activeSshxSessions.get(instanceId);
  if (!existing) return false;
  try {
    existing.proc.kill('SIGTERM');
  } catch {
    // ignore
  }
  activeSshxSessions.delete(instanceId);
  return true;
}

export async function launchIncusSshx(params: {
  instanceId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ url: string; startedAt: string; reused: boolean }> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');
  if (inst.node_id && inst.node_id !== 1) {
    throw new Error('One-click SSHX launch is available for local node Incus instances.');
  }

  const existing = activeSshxSessions.get(inst.id);
  if (existing && !existing.proc.killed && existing.proc.exitCode === null) {
    return { url: existing.url, startedAt: existing.startedAt, reused: true };
  }

  const incusUp = await isIncusReady();
  if (!incusUp) {
    throw new Error('Incus daemon is unavailable on this host. Run install.sh on Ubuntu/Debian VPS to launch live sshx sessions.');
  }
  if (inst.status !== 'running') {
    throw new Error('Start the VPS/LXC instance before launching an SSHX session.');
  }

  const cmd =
    'command -v sshx >/dev/null 2>&1 || { (command -v curl >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null 2>&1) || (dnf install -y -q curl >/dev/null 2>&1) || (apk add --no-cache curl >/dev/null 2>&1)); curl -sSf https://sshx.io/get | sh; }; exec sshx';

  const result = await new Promise<{ url: string; startedAt: string }>((resolve, reject) => {
    const proc = spawn('incus', ['exec', inst.instance_name, '--', '/bin/sh', '-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let outputBuf = '';

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          proc.kill('SIGTERM');
        } catch {
          // ignore
        }
        reject(new Error('Timed out waiting for sshx collaborative URL. Check outbound internet access inside the VPS.'));
      }
    }, 28000);

    const inspectChunk = (chunk: Buffer) => {
      outputBuf += chunk.toString('utf8');
      const match = outputBuf.match(/https:\/\/sshx\.io\/s\/[A-Za-z0-9#_-]+/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        const startedAt = new Date().toISOString();
        activeSshxSessions.set(inst.id, { url: match[0], proc, startedAt });
        resolve({ url: match[0], startedAt });
      }
    };

    proc.stdout.on('data', inspectChunk);
    proc.stderr.on('data', inspectChunk);
    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    proc.on('close', (code) => {
      activeSshxSessions.delete(inst.id);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`sshx exited with code ${code ?? 1}: ${outputBuf.slice(-260).trim()}`));
      }
    });
  });

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.sshx_launch',
    target: inst.instance_name,
    details: 'Started collaborative sshx terminal session',
    ipAddress: params.ipAddress,
  });

  return { ...result, reused: false };
}

export type IncusRecipeId = 'docker' | 'nodejs_pm2' | 'nginx_certbot' | 'python3' | 'tailscale';

const INCUS_APP_RECIPES: Record<
  IncusRecipeId,
  { label: string; script: string }
> = {
  docker: {
    label: 'Docker Engine + Compose',
    script: [
      'set -e',
      'if command -v apt-get >/dev/null 2>&1; then',
      '  export DEBIAN_FRONTEND=noninteractive',
      '  apt-get update -qq && apt-get install -y -qq curl ca-certificates gnupg',
      '  curl -fsSL https://get.docker.com | sh',
      '  systemctl enable --now docker || service docker start || true',
      'elif command -v dnf >/dev/null 2>&1; then',
      '  dnf install -y curl && curl -fsSL https://get.docker.com | sh && systemctl enable --now docker',
      'elif command -v apk >/dev/null 2>&1; then',
      '  apk add --no-cache docker docker-cli-compose && rc-update add docker boot && service docker start || true',
      'fi',
      'docker --version',
    ].join('\n'),
  },
  nodejs_pm2: {
    label: 'Node.js LTS + PM2',
    script: [
      'set -e',
      'if command -v apt-get >/dev/null 2>&1; then',
      '  export DEBIAN_FRONTEND=noninteractive',
      '  apt-get update -qq && apt-get install -y -qq curl ca-certificates',
      '  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
      '  apt-get install -y -qq nodejs',
      'elif command -v dnf >/dev/null 2>&1; then',
      '  dnf install -y nodejs npm',
      'elif command -v apk >/dev/null 2>&1; then',
      '  apk add --no-cache nodejs npm',
      'fi',
      'npm install -g pm2',
      'node -v && pm2 -v',
    ].join('\n'),
  },
  nginx_certbot: {
    label: 'Nginx + Certbot',
    script: [
      'set -e',
      'if command -v apt-get >/dev/null 2>&1; then',
      '  export DEBIAN_FRONTEND=noninteractive',
      '  apt-get update -qq && apt-get install -y -qq nginx certbot python3-certbot-nginx',
      '  systemctl enable --now nginx || service nginx start || true',
      'elif command -v dnf >/dev/null 2>&1; then',
      '  dnf install -y epel-release nginx certbot python3-certbot-nginx && systemctl enable --now nginx',
      'elif command -v apk >/dev/null 2>&1; then',
      '  apk add --no-cache nginx certbot && rc-update add nginx default && service nginx start || true',
      'fi',
      'nginx -v',
    ].join('\n'),
  },
  python3: {
    label: 'Python 3 + pip + venv',
    script: [
      'set -e',
      'if command -v apt-get >/dev/null 2>&1; then',
      '  export DEBIAN_FRONTEND=noninteractive',
      '  apt-get update -qq && apt-get install -y -qq python3 python3-pip python3-venv',
      'elif command -v dnf >/dev/null 2>&1; then',
      '  dnf install -y python3 python3-pip',
      'elif command -v apk >/dev/null 2>&1; then',
      '  apk add --no-cache python3 py3-pip',
      'fi',
      'python3 --version && pip3 --version',
    ].join('\n'),
  },
  tailscale: {
    label: 'Tailscale VPN',
    script: [
      'set -e',
      'if command -v apt-get >/dev/null 2>&1; then',
      '  export DEBIAN_FRONTEND=noninteractive',
      '  apt-get update -qq && apt-get install -y -qq curl ca-certificates',
      '  curl -fsSL https://tailscale.com/install.sh | sh',
      'elif command -v dnf >/dev/null 2>&1; then',
      '  dnf install -y curl && curl -fsSL https://tailscale.com/install.sh | sh',
      'elif command -v apk >/dev/null 2>&1; then',
      '  apk add --no-cache tailscale && rc-update add tailscale default && service tailscale start || true',
      'fi',
      'tailscale version',
    ].join('\n'),
  },
};

export async function runIncusAppRecipe(params: {
  instanceId: number;
  recipeId: IncusRecipeId;
  userId: number;
  username: string;
  ipAddress: string;
  onOutput?: (chunk: string) => void;
}): Promise<{ label: string; exitCode: number; output: string }> {
  const recipe = INCUS_APP_RECIPES[params.recipeId];
  if (!recipe) {
    throw new Error('Unsupported 1-click application recipe.');
  }

  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');
  if (inst.node_id && inst.node_id !== 1) {
    throw new Error('1-click recipes currently run on local node Incus instances.');
  }

  const incusUp = await isIncusReady();
  if (!incusUp) {
    throw new Error('Incus daemon is unavailable on this host.');
  }
  if (inst.status !== 'running') {
    throw new Error('Start the VPS/LXC instance before installing software recipes.');
  }

  params.onOutput?.(`\r\n\x1b[35m[FB BAHI Recipe]\x1b[0m Installing \x1b[36m${recipe.label}\x1b[0m...\r\n`);

  const output = await new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
    const proc = spawn('incus', ['exec', inst.instance_name, '--', '/bin/sh', '-c', recipe.script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let combined = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      reject(new Error(`${recipe.label} installer timed out after 4 minutes.`));
    }, 240000);

    const onChunk = (buf: Buffer) => {
      const txt = buf.toString('utf8');
      combined += txt;
      params.onOutput?.(txt.replace(/\n/g, '\r\n'));
    };

    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, output: combined });
    });
  });

  if (output.exitCode !== 0) {
    throw new Error(`${recipe.label} exited with code ${output.exitCode}.`);
  }

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'incus.recipe_install',
    target: inst.instance_name,
    details: `Installed 1-click recipe: ${recipe.label}`,
    ipAddress: params.ipAddress,
  });

  params.onOutput?.(`\x1b[32m[Done]\x1b[0m ${recipe.label} installed successfully.\r\n`);
  return { label: recipe.label, exitCode: output.exitCode, output: output.output.slice(-4000) };
}
