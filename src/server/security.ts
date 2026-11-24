import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { db, getAllSettings, getDbPath } from './db.js';

const JWT_SECRET =
  process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length >= 16
    ? process.env.JWT_SECRET.trim()
    : crypto.randomBytes(32).toString('hex');

export type UserRole = 'owner' | 'admin' | 'user';

export interface AuthUserPayload {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  impersonatedBy?: {
    id: number;
    username: string;
  };
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUserPayload;
}

export const CONTAINER_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,29}[a-zA-Z0-9]$/;
export const VERSION_REGEX = /^[a-zA-Z0-9._-]{1,32}$/;
export const SNAPSHOT_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}[a-zA-Z0-9]?$/;
export const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{3,32}$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const DOMAIN_REGEX = /^(?!-)[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/;
export const FQDN_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9.:_-]{1,118}$/;
export const RCLONE_REMOTE_REGEX = /^[a-zA-Z0-9_-]{1,32}$/;
export const RCLONE_FOLDER_REGEX = /^[a-zA-Z0-9/_.-]{1,100}$/;
export const TELEGRAM_TOKEN_REGEX = /^\d{6,14}:[A-Za-z0-9_-]{25,64}$/;
export const TELEGRAM_CHAT_ID_REGEX = /^-?\d{5,20}$/;
export const MC_PLAYER_REGEX = /^[a-zA-Z0-9_]{3,16}$/;

export const MINECRAFT_SOFTWARE_LIST = [
  'PAPER',
  'PURPUR',
  'SPIGOT',
  'VANILLA',
  'FORGE',
  'FABRIC',
  'VELOCITY',
] as const;

export type MinecraftSoftware = (typeof MINECRAFT_SOFTWARE_LIST)[number];

export const SSH_PUBLIC_KEY_REGEX =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com)\s+[A-Za-z0-9+/=]{16,}(\s+[^\r\n]{0,128})?$/;
export const CHMOD_MODE_REGEX = /^[0-7]{3,4}$/;

export const INCUS_OS_TEMPLATES: Record<string, { label: string; image: string }> = {
  'ubuntu-24.04': { label: 'Ubuntu 24.04 LTS', image: 'images:ubuntu/24.04' },
  'ubuntu-22.04': { label: 'Ubuntu 22.04 LTS', image: 'images:ubuntu/22.04' },
  'debian-12': { label: 'Debian 12 (Bookworm)', image: 'images:debian/12' },
  'almalinux-9': { label: 'AlmaLinux 9', image: 'images:almalinux/9' },
  'alpine-3.20': { label: 'Alpine Linux 3.20', image: 'images:alpine/3.20' },
};

export function isValidContainerName(name: unknown): name is string {
  return typeof name === 'string' && CONTAINER_NAME_REGEX.test(name);
}

export function isValidPort(port: unknown): port is number {
  const num = Number(port);
  return Number.isInteger(num) && num >= 1024 && num <= 65535;
}

export function isValidSnapshotName(name: unknown): name is string {
  return typeof name === 'string' && SNAPSHOT_NAME_REGEX.test(name);
}

export function isValidVersion(ver: unknown): ver is string {
  return typeof ver === 'string' && VERSION_REGEX.test(ver);
}

export function isValidDomain(domain: unknown): domain is string {
  return typeof domain === 'string' && domain.length <= 120 && DOMAIN_REGEX.test(domain.trim());
}

export function sanitizeDisplayName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/[<>]/g, '').slice(0, 64);
}

export function slugifyContainerName(input: string, prefix: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 22);
  const suffix = crypto.randomBytes(2).toString('hex');
  const candidate = `${prefix}-${cleaned || 'node'}-${suffix}`;
  return candidate.slice(0, 31);
}

export function resolveConfinedPath(baseDir: string, relativePath: string): string {
  const normalizedBase = path.resolve(baseDir);
  const safeRel = (relativePath || '').replace(/^\/+/, '');
  if (safeRel.includes('\0')) {
    throw new Error('Invalid null byte in file path');
  }
  const resolved = path.resolve(normalizedBase, safeRel);
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + path.sep)) {
    throw new Error('Directory traversal blocked');
  }
  return resolved;
}

export function sanitizeContainerFilePath(rawPath: unknown, fallback = '/root'): string {
  const str = typeof rawPath === 'string' && rawPath.trim() !== '' ? rawPath.trim() : fallback;
  if (str.includes('\0') || /[\r\n]/.test(str)) {
    throw new Error('Invalid characters in container file path.');
  }
  const prefixed = str.startsWith('/') ? str : `/${str}`;
  const normalized = path.posix.normalize(prefixed);
  if (!normalized.startsWith('/')) {
    throw new Error('Container path must resolve inside root filesystem.');
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

let cachedCipherKey: Buffer | null = null;
function getPanelCipherKey(): Buffer {
  if (cachedCipherKey) return cachedCipherKey;
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length >= 16) {
    cachedCipherKey = crypto.createHash('sha256').update(process.env.JWT_SECRET.trim()).digest();
    return cachedCipherKey;
  }
  const keyFile = path.join(path.dirname(getDbPath()), '.panel-key');
  try {
    if (fs.existsSync(keyFile)) {
      const hex = fs.readFileSync(keyFile, 'utf8').trim();
      if (/^[a-f0-9]{64}$/i.test(hex)) {
        cachedCipherKey = Buffer.from(hex, 'hex');
        return cachedCipherKey;
      }
    }
    const generated = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, generated.toString('hex'), { mode: 0o600 });
    cachedCipherKey = generated;
    return cachedCipherKey;
  } catch {
    cachedCipherKey = crypto.createHash('sha256').update(JWT_SECRET).digest();
    return cachedCipherKey;
  }
}

export function encryptSecret(plaintext: string): string {
  const key = getPanelCipherKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(payload: string | null | undefined): string {
  if (!payload) return '';
  const parts = payload.split(':');
  if (parts.length !== 3) return '';
  try {
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getPanelCipherKey(),
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return dec.toString('utf8');
  } catch {
    return '';
  }
}

export function validateDiscordWebhookUrl(rawUrl: string): boolean {
  if (!rawUrl || rawUrl.trim() === '') return true;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return false;
    const allowedHosts = new Set([
      'discord.com',
      'discordapp.com',
      'ptb.discord.com',
      'canary.discord.com',
    ]);
    if (!allowedHosts.has(parsed.hostname)) return false;
    return parsed.pathname.startsWith('/api/webhooks/');
  } catch {
    return false;
  }
}

export function validateCloudEndpointUrl(rawUrl: string): boolean {
  if (!rawUrl || rawUrl.trim() === '') return true;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '169.254.169.254' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export function signToken(user: AuthUserPayload): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
}

export function verifyToken(token: string): AuthUserPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthUserPayload;
    if (!decoded || typeof decoded.id !== 'number' || typeof decoded.username !== 'string') {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];

  let payload: AuthUserPayload | null = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    payload = verifyToken(authHeader.slice(7).trim());
  } else if (typeof apiKeyHeader === 'string' && apiKeyHeader.startsWith('fbbahi_')) {
    const keyHash = hashApiKey(apiKeyHeader.trim());
    const row = db
      .prepare(
        `SELECT ak.id AS key_id, u.id, u.username, u.email, u.role, u.status, u.is_suspended
         FROM api_keys ak
         JOIN users u ON u.id = ak.user_id
         WHERE ak.key_hash = ?`
      )
      .get(keyHash) as
      | {
          key_id: number;
          id: number;
          username: string;
          email: string;
          role: UserRole;
          status: string;
          is_suspended: number;
        }
      | undefined;

    if (row && !row.is_suspended && row.status === 'active') {
      db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`).run(row.key_id);
      payload = {
        id: row.id,
        username: row.username,
        email: row.email,
        role: row.role,
      };
    }
  }

  if (!payload) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Verify live DB state for suspension, pending approval & role updates
  const liveUser = db
    .prepare('SELECT id, username, email, role, status, is_suspended FROM users WHERE id = ?')
    .get(payload.id) as
    | {
        id: number;
        username: string;
        email: string;
        role: UserRole;
        status: string;
        is_suspended: number;
      }
    | undefined;

  if (!liveUser) {
    res.status(401).json({ error: 'Account no longer exists.' });
    return;
  }

  if (liveUser.status === 'pending' && !payload.impersonatedBy) {
    res.status(403).json({ error: 'Your account is awaiting Owner/Admin approval.' });
    return;
  }

  if ((liveUser.is_suspended || liveUser.status === 'suspended') && !payload.impersonatedBy) {
    res.status(403).json({ error: 'Your account has been suspended by an administrator.' });
    return;
  }

  // Enforce Maintenance Mode for regular 'user' accounts
  const settings = getAllSettings();
  if (
    settings.maintenance_mode === '1' &&
    liveUser.role === 'user' &&
    !payload.impersonatedBy &&
    req.path !== '/api/auth/me'
  ) {
    res.status(503).json({
      error: settings.maintenance_message || 'FB BAHI Panel is under maintenance.',
      maintenance: true,
    });
    return;
  }

  req.user = {
    id: liveUser.id,
    username: liveUser.username,
    email: liveUser.email,
    role: liveUser.role,
    ...(payload.impersonatedBy ? { impersonatedBy: payload.impersonatedBy } : {}),
  };

  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions for this action.' });
      return;
    }
    next();
  };
}

export type SubUserPermission =
  | 'can_start_stop'
  | 'can_use_console'
  | 'can_edit_files'
  | 'can_manage_backups';

export function canAccessMinecraftServer(
  user: AuthUserPayload,
  serverId: number,
  requiredSubPermission?: SubUserPermission
): { allowed: boolean; reason?: string; isOwnerOrAdmin: boolean } {
  const srv = db
    .prepare('SELECT id, owner_id, is_suspended FROM minecraft_servers WHERE id = ?')
    .get(serverId) as { id: number; owner_id: number | null; is_suspended: number } | undefined;

  if (!srv) {
    return { allowed: false, reason: 'Minecraft server not found.', isOwnerOrAdmin: false };
  }

  if (user.role === 'owner' || user.role === 'admin') {
    return { allowed: true, isOwnerOrAdmin: true };
  }

  if (srv.is_suspended) {
    return {
      allowed: false,
      reason: 'This server is currently suspended by an administrator.',
      isOwnerOrAdmin: false,
    };
  }

  if (srv.owner_id === user.id) {
    return { allowed: true, isOwnerOrAdmin: true };
  }

  const sub = db
    .prepare('SELECT * FROM server_subusers WHERE server_id = ? AND user_id = ?')
    .get(serverId, user.id) as Record<string, number> | undefined;

  if (!sub) {
    return { allowed: false, reason: 'You do not have access to this server.', isOwnerOrAdmin: false };
  }

  if (requiredSubPermission && sub[requiredSubPermission] !== 1) {
    return {
      allowed: false,
      reason: `Missing permission: ${requiredSubPermission}`,
      isOwnerOrAdmin: false,
    };
  }

  return { allowed: true, isOwnerOrAdmin: false };
}

export function canAccessIncusInstance(
  user: AuthUserPayload,
  instanceId: number
): { allowed: boolean; reason?: string } {
  const inst = db
    .prepare('SELECT id, owner_id, is_suspended FROM vm_instances WHERE id = ?')
    .get(instanceId) as { id: number; owner_id: number | null; is_suspended: number } | undefined;

  if (!inst) {
    return { allowed: false, reason: 'Instance not found.' };
  }

  if (user.role === 'owner' || user.role === 'admin') {
    return { allowed: true };
  }

  if (inst.is_suspended) {
    return { allowed: false, reason: 'This instance is currently suspended.' };
  }

  if (inst.owner_id !== user.id) {
    return { allowed: false, reason: 'You do not have access to this instance.' };
  }

  return { allowed: true };
}

export interface UserQuotaSummary {
  limits: {
    maxRamMb: number;
    maxCpuPercent: number;
    maxDiskGb: number;
    maxMcServers: number;
    maxVmInstances: number;
  };
  used: {
    ramMb: number;
    cpuPercent: number;
    diskGb: number;
    mcServers: number;
    vmInstances: number;
  };
}

export function getUserQuotaSummary(userId: number): UserQuotaSummary {
  const userRow = db
    .prepare(
      `SELECT max_ram_mb, max_cpu_percent, max_disk_gb, max_mc_servers, max_vm_instances
       FROM users WHERE id = ?`
    )
    .get(userId) as
    | {
        max_ram_mb: number;
        max_cpu_percent: number;
        max_disk_gb: number;
        max_mc_servers: number;
        max_vm_instances: number;
      }
    | undefined;

  const mcAgg = db
    .prepare(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(ram_mb), 0) AS ram, COALESCE(SUM(cpu_percent), 0) AS cpu,
              COALESCE(SUM(disk_mb), 0) AS disk_mb
       FROM minecraft_servers WHERE owner_id = ?`
    )
    .get(userId) as { cnt: number; ram: number; cpu: number; disk_mb: number };

  const vmAgg = db
    .prepare(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(ram_mb), 0) AS ram, COALESCE(SUM(vcpu * 100), 0) AS cpu,
              COALESCE(SUM(disk_gb), 0) AS disk_gb
       FROM vm_instances WHERE owner_id = ?`
    )
    .get(userId) as { cnt: number; ram: number; cpu: number; disk_gb: number };

  return {
    limits: {
      maxRamMb: userRow?.max_ram_mb ?? 8192,
      maxCpuPercent: userRow?.max_cpu_percent ?? 400,
      maxDiskGb: userRow?.max_disk_gb ?? 50,
      maxMcServers: userRow?.max_mc_servers ?? 3,
      maxVmInstances: userRow?.max_vm_instances ?? 2,
    },
    used: {
      ramMb: mcAgg.ram + vmAgg.ram,
      cpuPercent: mcAgg.cpu + vmAgg.cpu,
      diskGb: Math.ceil(mcAgg.disk_mb / 1024) + vmAgg.disk_gb,
      mcServers: mcAgg.cnt,
      vmInstances: vmAgg.cnt,
    },
  };
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
