import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cron from 'node-cron';
import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import { Server as SocketIOServer } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import { testCloudConnection } from './src/server/cloudStorage.js';
import {
  type AiAgentType,
  type AiConfirmationMode,
  ALLOWED_OPENAI_MODEL_REGEX,
  clearAiChatHistory,
  listAiChatHistory,
  resolveOpenAiConfig,
  resolvePendingAiAction,
  runAgentChat,
  testOpenAiConnection,
} from './src/server/controllers/aiAgentController.js';
import {
  assignNextAllocationToServer,
  bulkDeleteNodeAllocations,
  createNodeAllocations,
  deleteNodeAllocation,
  getSuggestedNodeIp,
  listAvailableNodeAllocations,
  listNodeAllocations,
  listServerAllocations,
  setServerPrimaryAllocation,
  unassignServerAllocation,
  updateNodeAllocation,
  updateServerAllocationNotes,
} from './src/server/controllers/allocationController.js';
import {
  controlMinecraftServer,
  createMinecraftBackup,
  createMinecraftServer,
  createServerEntry,
  deleteMinecraftBackup,
  deleteServerEntry,
  docker,
  downloadMinecraftBackupFile,
  getMinecraftContainerMetrics,
  getMinecraftLogs,
  getMinecraftPlayers,
  getMinecraftProperties,
  installModrinthProject,
  isDockerReady,
  listMinecraftBackups,
  listServerFiles,
  type MinecraftServerRow,
  readServerFile,
  restoreMinecraftBackup,
  runPlayerAction,
  searchModrinthProjects,
  sendMinecraftCommand,
  streamServerBackupZip,
  syncMinecraftStatuses,
  updateMinecraftProperties,
  uploadMinecraftBackupToCloud,
  writeServerFile,
} from './src/server/controllers/dockerController.js';
import {
  addIncusPortForward,
  addVmSshKey,
  controlIncusInstance,
  createIncusBackupOrSnapshot,
  createIncusInstance,
  createInstanceSnapshot,
  createReverseProxy,
  deleteIncusBackup,
  deleteInstanceSnapshot,
  deleteReverseProxy,
  detectHostPublicIpv4,
  getIncusBackupArchivePath,
  getIncusInstanceMetrics,
  getIncusInstanceTelemetry,
  getIncusSshDetails,
  getNextFreeSharedPort,
  type IncusRecipeId,
  isIncusReady,
  launchIncusSshx,
  listIncusBackupsAndSnapshots,
  listInstanceSnapshots,
  listPortAllocations,
  listReverseProxies,
  reinstallIncusInstance,
  removeIncusPortForward,
  removeVmSshKey,
  renameIncusInstance,
  resetIncusRootPassword,
  restoreIncusBackup,
  restoreInstanceSnapshot,
  runIncusAppRecipe,
  stopIncusSshx,
  syncIncusInstances,
  uploadIncusBackupToCloud,
  type VmInstanceRow,
} from './src/server/controllers/incusController.js';
import {
  chmodContainerEntry,
  createContainerEntry,
  deleteContainerEntry,
  listContainerFiles,
  prepareContainerDownload,
  readContainerFile,
  renameOrMoveContainerEntry,
  uploadContainerFiles,
  writeContainerFile,
} from './src/server/controllers/incusFilesController.js';
import {
  createRemoteNode,
  deleteRemoteNode,
  getNodeAgentSource,
  getNodeInstallScript,
  listNodesWithCounts,
  markNodeOffline,
  regenerateNodeToken,
  registerNodeSocket,
  syncPrimaryNodeMetrics,
  updateNodeTelemetry,
  verifyNodeToken,
} from './src/server/controllers/nodeController.js';
import {
  type IncusScheduleRow,
  initializeAllSchedules,
  registerIncusScheduleTask,
  registerScheduleTask,
  type ScheduleRow,
  unregisterIncusScheduleTask,
  unregisterInstanceSchedules,
  unregisterScheduleTask,
  unregisterServerSchedules,
} from './src/server/controllers/scheduleController.js';
import {
  checkHostCapabilities,
  collectSystemStats,
} from './src/server/controllers/systemController.js';
import { db, getAllSettings, getBackgroundsDir, recordAuditLog, setSetting } from './src/server/db.js';
import {
  type AuthenticatedRequest,
  canAccessIncusInstance,
  canAccessMinecraftServer,
  EMAIL_REGEX,
  encryptSecret,
  getClientIp,
  getUserQuotaSummary,
  hashApiKey,
  isValidPort,
  RCLONE_FOLDER_REGEX,
  RCLONE_REMOTE_REGEX,
  requireAuth,
  requireRole,
  resolveConfinedPath,
  sanitizeDisplayName,
  signToken,
  TELEGRAM_CHAT_ID_REGEX,
  TELEGRAM_TOKEN_REGEX,
  USERNAME_REGEX,
  type UserRole,
  validateCloudEndpointUrl,
  validateDiscordWebhookUrl,
  verifyToken,
} from './src/server/security.js';
import { sendDiscordAlert, sendTelegramAlert } from './src/server/webhook.js';

process.on('unhandledRejection', (reason) => {
  console.error('[FB BAHI Panel] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[FB BAHI Panel] Uncaught exception:', err);
});

const PORT = Number(process.env.PORT) || 6767;
const isProd = process.env.NODE_ENV === 'production';

const VALID_UI_THEMES = [
  'cyber-purple',
  'emerald-matrix',
  'crimson-core',
  'ocean-cyan',
  'amber-gold',
] as const;

let ioRef: SocketIOServer | null = null;

function getDaemonErrorStatus(err: unknown, fallback = 400): number {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err || '').toLowerCase();
  if (
    msg.includes('daemon is unavailable') ||
    msg.includes('daemon is not available') ||
    msg.includes('docker daemon') ||
    msg.includes('incus daemon') ||
    msg.includes('econnrefused') ||
    msg.includes('/var/run/docker.sock')
  ) {
    return 503;
  }
  return fallback;
}

function parseBoundedInt(value: unknown, min: number, max?: number): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  let bounded = Math.max(min, Math.round(num));
  if (max !== undefined) bounded = Math.min(max, bounded);
  return bounded;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));

// Validate positive integer resource IDs across all panel API routes
const NUMERIC_ID_PARAMS = ['id', 'allocId', 'backupId', 'scheduleId', 'subId', 'keyId', 'proxyId'] as const;
for (const paramName of NUMERIC_ID_PARAMS) {
  app.param(paramName, (_req, res, next, value: string) => {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      res.status(400).json({ error: `Invalid numeric ${paramName} parameter.` });
      return;
    }
    next();
  });
}

// Serve uploaded custom background media safely (never serve scripts/HTML/SVG)
app.use(
  '/uploads/backgrounds',
  (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  },
  express.static(getBackgroundsDir(), { maxAge: '1h', fallthrough: true })
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
});

const backgroundUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

// ==========================================
// AUTHENTICATION, 2FA & INITIAL SETUP ROUTES
// ==========================================
app.get('/api/auth/status', (_req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  const settings = getAllSettings();
  res.json({
    needsSetup: row.count === 0,
    allowPublicRegistration: settings.allow_public_registration !== '0',
    registrationMode: settings.registration_mode === 'instant' ? 'instant' : 'approval',
    maintenanceMode: settings.maintenance_mode === '1',
    maintenanceMessage:
      settings.maintenance_message || 'FB BAHI Panel is currently undergoing maintenance.',
    announcement: {
      enabled: settings.announcement_enabled === '1',
      level: (settings.announcement_level as 'info' | 'warning' | 'critical') || 'info',
      text: settings.announcement_text || '',
    },
    branding: {
      panelName: settings.panel_name || 'FB BAHI Panel',
      panelSubtitle: settings.panel_subtitle || 'Game Server & Cloud VM Control',
    },
    appearance: {
      theme: (VALID_UI_THEMES as readonly string[]).includes(settings.ui_theme)
        ? settings.ui_theme
        : 'cyber-purple',
      bgUrl: settings.custom_bg_url || '',
      bgType: (['none', 'image', 'gif', 'video'].includes(settings.custom_bg_type)
        ? settings.custom_bg_type
        : 'none') as 'none' | 'image' | 'gif' | 'video',
      bgOpacity: Math.min(0.9, Math.max(0.05, Number(settings.custom_bg_opacity || '0.35') || 0.35)),
    },
    vpsRebootWarning: settings.vps_reboot_warning || '',
  });
});

app.post('/api/auth/setup', (req, res) => {
  const { username, email, password } = req.body as {
    username?: string;
    email?: string;
    password?: string;
  };

  if (!username || !USERNAME_REGEX.test(username)) {
    res.status(400).json({ error: 'Username must be 3-32 characters (letters, numbers, _, ., -).' });
    return;
  }
  if (!email || !EMAIL_REGEX.test(email)) {
    res.status(400).json({ error: 'Valid email address is required.' });
    return;
  }
  if (!password || password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters.' });
    return;
  }

  const passwordHash = bcrypt.hashSync(password, 12);

  try {
    const user = db.transaction(() => {
      const countRow = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
      if (countRow.count > 0) {
        throw new Error('SETUP_ALREADY_CLAIMED');
      }
      const result = db
        .prepare(
          `INSERT INTO users (username, email, password_hash, role, last_login, max_ram_mb, max_cpu_percent, max_disk_gb, max_mc_servers, max_vm_instances)
           VALUES (?, ?, ?, 'owner', datetime('now'), 65536, 1600, 500, 50, 50)`
        )
        .run(username.trim(), email.trim().toLowerCase(), passwordHash);

      return db
        .prepare('SELECT id, username, email, role, totp_enabled, created_at FROM users WHERE id = ?')
        .get(Number(result.lastInsertRowid)) as {
        id: number;
        username: string;
        email: string;
        role: UserRole;
        totp_enabled: number;
        created_at: string;
      };
    })();

    const token = signToken({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    });

    recordAuditLog({
      userId: user.id,
      username: user.username,
      action: 'auth.initial_setup',
      target: user.username,
      details: 'Initial owner account created',
      ipAddress: getClientIp(req),
    });

    res.status(201).json({ token, user });
  } catch (err) {
    if (err instanceof Error && err.message === 'SETUP_ALREADY_CLAIMED') {
      res.status(403).json({ error: 'Panel already initialized. Please sign in.' });
      return;
    }
    res.status(500).json({ error: 'Failed to initialize owner account.' });
  }
});

app.post('/api/auth/register', (req, res) => {
  const settings = getAllSettings();
  if (settings.allow_public_registration !== '1') {
    res.status(403).json({ error: 'Public registration is currently disabled by the administrator.' });
    return;
  }

  const userCount = (db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
  if (userCount === 0) {
    res.status(400).json({ error: 'Initial Owner account setup must be completed first.' });
    return;
  }

  const { username, email, password, confirmPassword } = req.body as {
    username?: string;
    email?: string;
    password?: string;
    confirmPassword?: string;
  };

  if (!username || !USERNAME_REGEX.test(username.trim())) {
    res.status(400).json({ error: 'Username must be 3-32 characters (letters, numbers, _, ., -).' });
    return;
  }
  if (!email || !EMAIL_REGEX.test(email.trim())) {
    res.status(400).json({ error: 'Valid email address is required.' });
    return;
  }
  if (!password || password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters.' });
    return;
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    res.status(400).json({ error: 'Password confirmation does not match.' });
    return;
  }

  const cleanUsername = username.trim();
  const cleanEmail = email.trim().toLowerCase();

  const existing = db
    .prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)')
    .get(cleanUsername, cleanEmail);
  if (existing) {
    res.status(409).json({ error: 'Username or email address is already registered.' });
    return;
  }

  const mode = settings.registration_mode === 'instant' ? 'instant' : 'approval';
  const accountStatus = mode === 'instant' ? 'active' : 'pending';
  const registrationIp = getClientIp(req);
  const passwordHash = bcrypt.hashSync(password, 12);

  const result = db
    .prepare(
      `INSERT INTO users
       (username, email, password_hash, role, status, is_suspended, registration_ip,
        max_ram_mb, max_cpu_percent, max_disk_gb, max_mc_servers, max_vm_instances, last_login)
       VALUES (?, ?, ?, 'user', ?, 0, ?, 8192, 400, 50, 3, 2, ?)`
    )
    .run(
      cleanUsername,
      cleanEmail,
      passwordHash,
      accountStatus,
      registrationIp,
      accountStatus === 'active' ? new Date().toISOString() : null
    );

  const user = db
    .prepare('SELECT id, username, email, role, status, totp_enabled, created_at FROM users WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as {
    id: number;
    username: string;
    email: string;
    role: UserRole;
    status: string;
    totp_enabled: number;
    created_at: string;
  };

  recordAuditLog({
    userId: user.id,
    username: user.username,
    action: 'auth.register',
    target: user.username,
    details: `Public signup (${accountStatus}) from ${registrationIp}`,
    ipAddress: registrationIp,
  });

  void sendDiscordAlert({
    event: 'register',
    title: `New Member Registered: ${user.username}`,
    description:
      accountStatus === 'pending'
        ? `Account \`${user.username}\` is **pending Owner/Admin approval**.`
        : `Account \`${user.username}\` activated instantly with starter quota.`,
    fields: [
      { name: 'Email', value: user.email, inline: true },
      { name: 'Status', value: accountStatus.toUpperCase(), inline: true },
      { name: 'IP Address', value: registrationIp, inline: true },
    ],
  });

  if (accountStatus === 'pending') {
    res.status(201).json({
      pendingApproval: true,
      message: 'Account created successfully and is awaiting Owner/Admin approval.',
    });
    return;
  }

  const token = signToken({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
  });

  res.status(201).json({ pendingApproval: false, token, user });
});

app.post('/api/auth/login', (req, res) => {
  const { identifier, password, totpCode } = req.body as {
    identifier?: string;
    password?: string;
    totpCode?: string;
  };
  if (!identifier || !password) {
    res.status(400).json({ error: 'Username/email and password are required.' });
    return;
  }

  const cleanIdentifier = identifier.trim();
  const user = db
    .prepare(
      `SELECT id, username, email, password_hash, role, status, is_suspended, totp_secret, totp_enabled
       FROM users WHERE username = ? OR email = ?`
    )
    .get(cleanIdentifier, cleanIdentifier.toLowerCase()) as
    | {
        id: number;
        username: string;
        email: string;
        password_hash: string;
        role: UserRole;
        status: string;
        is_suspended: number;
        totp_secret: string | null;
        totp_enabled: number;
      }
    | undefined;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid credentials.' });
    return;
  }

  if (user.status === 'pending') {
    res.status(403).json({ error: 'Your account is pending Owner/Admin approval.' });
    return;
  }

  if (user.is_suspended || user.status === 'suspended') {
    res.status(403).json({ error: 'This account has been suspended by an administrator.' });
    return;
  }

  const settings = getAllSettings();
  if (settings.maintenance_mode === '1' && user.role === 'user') {
    res.status(503).json({
      error: settings.maintenance_message || 'FB BAHI Panel is currently under maintenance.',
      maintenance: true,
    });
    return;
  }

  if (user.totp_enabled && user.totp_secret) {
    if (!totpCode || totpCode.trim() === '') {
      res.json({ requires2fa: true });
      return;
    }
    const verification = verifySync({
      secret: user.totp_secret,
      token: totpCode.trim(),
      epochTolerance: 30,
    });
    if (!verification.valid) {
      res.status(401).json({ error: 'Invalid 2FA authenticator code.' });
      return;
    }
  }

  db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(user.id);

  const token = signToken({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
  });

  recordAuditLog({
    userId: user.id,
    username: user.username,
    action: 'auth.login',
    target: user.username,
    details: user.totp_enabled ? 'Signed in with 2FA' : 'Signed into control panel',
    ipAddress: getClientIp(req),
  });

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      totp_enabled: user.totp_enabled,
    },
  });
});

app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT id, username, email, role, totp_enabled, is_suspended FROM users WHERE id = ?')
    .get(req.user!.id) as Record<string, unknown> | undefined;

  res.json({
    user: {
      ...req.user,
      totp_enabled: row?.totp_enabled || 0,
    },
    quota: getUserQuotaSummary(req.user!.id),
  });
});

app.post('/api/auth/2fa/setup', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const secret = generateSecret();
    const settings = getAllSettings();
    const issuer = settings.panel_name || 'FB BAHI Panel';
    const otpauthUri = generateURI({
      issuer,
      label: req.user!.email || req.user!.username,
      secret,
    });
    const qrDataUrl = await QRCode.toDataURL(otpauthUri);
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, req.user!.id);
    res.json({ secret, otpauthUri, qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to initialize 2FA setup.' });
  }
});

app.post('/api/auth/2fa/enable', requireAuth, (req: AuthenticatedRequest, res) => {
  const code = String(req.body?.code || '').trim();
  const row = db
    .prepare('SELECT totp_secret FROM users WHERE id = ?')
    .get(req.user!.id) as { totp_secret: string | null } | undefined;

  if (!row?.totp_secret) {
    res.status(400).json({ error: 'Initialize 2FA setup first.' });
    return;
  }

  const check = verifySync({ secret: row.totp_secret, token: code, epochTolerance: 30 });
  if (!check.valid) {
    res.status(400).json({ error: 'Invalid 6-digit authenticator code.' });
    return;
  }

  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.user!.id);
  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'auth.2fa_enable',
    target: req.user!.username,
    details: 'Enabled TOTP Two-Factor Authentication',
    ipAddress: getClientIp(req),
  });
  res.json({ enabled: true });
});

app.post('/api/auth/2fa/disable', requireAuth, (req: AuthenticatedRequest, res) => {
  const password = String(req.body?.password || '');
  const row = db
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(req.user!.id) as { password_hash: string } | undefined;

  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    res.status(401).json({ error: 'Current password required to disable 2FA.' });
    return;
  }

  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.user!.id);
  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'auth.2fa_disable',
    target: req.user!.username,
    details: 'Disabled TOTP Two-Factor Authentication',
    ipAddress: getClientIp(req),
  });
  res.json({ disabled: true });
});

app.post('/api/auth/change-password', requireAuth, (req: AuthenticatedRequest, res) => {
  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
  };
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    res.status(400).json({ error: 'Current password and new password (min 8 chars) required.' });
    return;
  }

  const user = db
    .prepare('SELECT id, password_hash FROM users WHERE id = ?')
    .get(req.user!.id) as { id: number; password_hash: string } | undefined;

  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    res.status(401).json({ error: 'Current password is incorrect.' });
    return;
  }

  const nextHash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(nextHash, user.id);

  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'auth.password_change',
    target: req.user!.username,
    details: 'Updated account password',
    ipAddress: getClientIp(req),
  });

  res.json({ updated: true });
});

// ==========================================
// RBAC USER, QUOTA & OWNER IMPERSONATION ROUTES
// ==========================================
app.get('/api/users', requireAuth, requireRole('owner', 'admin'), (_req, res) => {
  const users = db
    .prepare(
      `SELECT id, username, email, role, status, is_suspended, registration_ip, totp_enabled,
              max_ram_mb, max_cpu_percent, max_disk_gb, max_mc_servers, max_vm_instances,
              created_at, last_login
       FROM users ORDER BY id ASC`
    )
    .all() as Array<{ id: number } & Record<string, unknown>>;

  const enriched = users.map((u) => ({
    ...u,
    quota: getUserQuotaSummary(u.id),
  }));
  res.json({ users: enriched });
});

app.get('/api/users/new-members', requireAuth, requireRole('owner', 'admin'), (_req, res) => {
  const members = db
    .prepare(
      `SELECT id, username, email, role, status, is_suspended, registration_ip, totp_enabled,
              max_ram_mb, max_cpu_percent, max_disk_gb, max_mc_servers, max_vm_instances,
              created_at, last_login
       FROM users
       ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC`
    )
    .all() as Array<{ id: number; status: string } & Record<string, unknown>>;

  const pendingCount = members.filter((m) => m.status === 'pending').length;
  res.json({
    members: members.map((m) => ({
      ...m,
      quota: getUserQuotaSummary(m.id),
    })),
    pendingCount,
  });
});

app.post('/api/users/:id/approve', requireAuth, requireRole('owner', 'admin'), (req: AuthenticatedRequest, res) => {
  const targetId = Number(req.params.id);
  const target = db
    .prepare('SELECT id, username, role, status FROM users WHERE id = ?')
    .get(targetId) as { id: number; username: string; role: UserRole; status: string } | undefined;

  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const body = req.body as {
    max_ram_mb?: number;
    max_cpu_percent?: number;
    max_disk_gb?: number;
    max_mc_servers?: number;
    max_vm_instances?: number;
  };

  db.prepare(
    `UPDATE users SET
       status = 'active',
       is_suspended = 0,
       max_ram_mb = COALESCE(?, max_ram_mb),
       max_cpu_percent = COALESCE(?, max_cpu_percent),
       max_disk_gb = COALESCE(?, max_disk_gb),
       max_mc_servers = COALESCE(?, max_mc_servers),
       max_vm_instances = COALESCE(?, max_vm_instances)
     WHERE id = ?`
  ).run(
    parseBoundedInt(body.max_ram_mb, 512),
    parseBoundedInt(body.max_cpu_percent, 100),
    parseBoundedInt(body.max_disk_gb, 5),
    parseBoundedInt(body.max_mc_servers, 0),
    parseBoundedInt(body.max_vm_instances, 0),
    target.id
  );

  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'users.approve',
    target: target.username,
    details: 'Approved member account and activated panel access',
    ipAddress: getClientIp(req),
  });

  res.json({ approved: true });
});

app.post('/api/users/:id/reject', requireAuth, requireRole('owner', 'admin'), (req: AuthenticatedRequest, res) => {
  const targetId = Number(req.params.id);
  const target = db
    .prepare('SELECT id, username, role FROM users WHERE id = ?')
    .get(targetId) as { id: number; username: string; role: UserRole } | undefined;

  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  if (target.role === 'owner' || target.id === req.user!.id) {
    res.status(403).json({ error: 'Owner accounts or active session cannot be rejected/deleted.' });
    return;
  }
  if (req.user!.role === 'admin' && target.role === 'admin') {
    res.status(403).json({ error: 'Admins cannot delete other Admin accounts.' });
    return;
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'users.reject',
    target: target.username,
    details: 'Rejected and removed member account',
    ipAddress: getClientIp(req),
  });

  res.json({ deleted: true });
});

app.post('/api/users', requireAuth, requireRole('owner', 'admin'), (req: AuthenticatedRequest, res) => {
  const {
    username,
    email,
    password,
    role = 'user',
    maxRamMb = 8192,
    maxCpuPercent = 400,
    maxDiskGb = 50,
    maxMcServers = 3,
    maxVmInstances = 2,
  } = req.body as {
    username?: string;
    email?: string;
    password?: string;
    role?: UserRole;
    maxRamMb?: number;
    maxCpuPercent?: number;
    maxDiskGb?: number;
    maxMcServers?: number;
    maxVmInstances?: number;
  };

  if (!username || !USERNAME_REGEX.test(username)) {
    res.status(400).json({ error: 'Username must be 3-32 valid characters.' });
    return;
  }
  if (!email || !EMAIL_REGEX.test(email)) {
    res.status(400).json({ error: 'Valid email is required.' });
    return;
  }
  if (!password || password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters.' });
    return;
  }

  let targetRole: UserRole = 'user';
  if (role === 'admin' || role === 'owner') {
    if (req.user!.role !== 'owner') {
      res.status(403).json({ error: 'Only panel owners can create admin accounts.' });
      return;
    }
    targetRole = role === 'owner' ? 'admin' : 'admin';
  }

  const existing = db
    .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .get(username.trim(), email.trim().toLowerCase());
  if (existing) {
    res.status(409).json({ error: 'Username or email already exists.' });
    return;
  }

  const hash = bcrypt.hashSync(password, 12);
  const result = db
    .prepare(
      `INSERT INTO users
       (username, email, password_hash, role, max_ram_mb, max_cpu_percent, max_disk_gb, max_mc_servers, max_vm_instances)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      username.trim(),
      email.trim().toLowerCase(),
      hash,
      targetRole,
      Math.max(512, Number(maxRamMb) || 8192),
      Math.max(100, Number(maxCpuPercent) || 400),
      Math.max(5, Number(maxDiskGb) || 50),
      Math.max(0, Number(maxMcServers) || 3),
      Math.max(0, Number(maxVmInstances) || 2)
    );

  const created = db
    .prepare(
      `SELECT id, username, email, role, is_suspended, max_ram_mb, max_cpu_percent, max_disk_gb, max_mc_servers, max_vm_instances, created_at
       FROM users WHERE id = ?`
    )
    .get(Number(result.lastInsertRowid));

  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'users.create',
    target: username.trim(),
    details: `Created ${targetRole} account (${email.trim().toLowerCase()})`,
    ipAddress: getClientIp(req),
  });

  res.status(201).json({ user: created });
});

app.put('/api/users/:id', requireAuth, requireRole('owner', 'admin'), (req: AuthenticatedRequest, res) => {
  const targetId = Number(req.params.id);
  const target = db
    .prepare('SELECT id, username, role FROM users WHERE id = ?')
    .get(targetId) as { id: number; username: string; role: UserRole } | undefined;

  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  // Regular Admins cannot modify Owners or other Admins
  if (req.user!.role === 'admin' && target.role !== 'user') {
    res.status(403).json({ error: 'Admins cannot modify Owner or other Admin accounts.' });
    return;
  }

  // Nobody can demote or suspend an Owner via API
  const {
    role,
    is_suspended,
    max_ram_mb,
    max_cpu_percent,
    max_disk_gb,
    max_mc_servers,
    max_vm_instances,
  } = req.body as {
    role?: UserRole;
    is_suspended?: boolean;
    max_ram_mb?: number;
    max_cpu_percent?: number;
    max_disk_gb?: number;
    max_mc_servers?: number;
    max_vm_instances?: number;
  };

  if (target.role === 'owner' && (role && role !== 'owner' || is_suspended === true)) {
    res.status(403).json({ error: 'Owner accounts cannot be demoted or suspended.' });
    return;
  }

  let nextRole = target.role;
  if (role && role !== target.role) {
    if (req.user!.role !== 'owner') {
      res.status(403).json({ error: 'Only panel owners can promote or demote roles.' });
      return;
    }
    if (role === 'admin' || role === 'user') {
      nextRole = role;
    }
  }

  const nextSuspended =
    target.role === 'owner' ? 0 : is_suspended === true ? 1 : is_suspended === false ? 0 : undefined;

  if (nextSuspended !== undefined) {
    db.prepare('UPDATE users SET is_suspended = ?, status = ? WHERE id = ?').run(
      nextSuspended,
      nextSuspended === 1 ? 'suspended' : 'active',
      target.id
    );
  }

  db.prepare(
    `UPDATE users SET
       role = ?,
       max_ram_mb = COALESCE(?, max_ram_mb),
       max_cpu_percent = COALESCE(?, max_cpu_percent),
       max_disk_gb = COALESCE(?, max_disk_gb),
       max_mc_servers = COALESCE(?, max_mc_servers),
       max_vm_instances = COALESCE(?, max_vm_instances)
     WHERE id = ?`
  ).run(
    nextRole,
    parseBoundedInt(max_ram_mb, 512),
    parseBoundedInt(max_cpu_percent, 100),
    parseBoundedInt(max_disk_gb, 5),
    parseBoundedInt(max_mc_servers, 0),
    parseBoundedInt(max_vm_instances, 0),
    target.id
  );

  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'users.update',
    target: target.username,
    details: `Role=${nextRole}${nextSuspended !== undefined ? `, suspended=${nextSuspended}` : ''}`,
    ipAddress: getClientIp(req),
  });

  res.json({ updated: true });
});

app.delete('/api/users/:id', requireAuth, requireRole('owner'), (req: AuthenticatedRequest, res) => {
  const targetId = Number(req.params.id);
  const target = db
    .prepare('SELECT id, username, role FROM users WHERE id = ?')
    .get(targetId) as { id: number; username: string; role: UserRole } | undefined;

  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  if (target.role === 'owner' || target.id === req.user!.id) {
    res.status(403).json({ error: 'Owner accounts cannot be deleted.' });
    return;
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'users.delete',
    target: target.username,
    details: 'Removed account',
    ipAddress: getClientIp(req),
  });

  res.json({ deleted: true });
});

app.post('/api/owner/impersonate/:id', requireAuth, requireRole('owner'), (req: AuthenticatedRequest, res) => {
  const targetId = Number(req.params.id);
  const target = db
    .prepare('SELECT id, username, email, role FROM users WHERE id = ?')
    .get(targetId) as { id: number; username: string; email: string; role: UserRole } | undefined;

  if (!target) {
    res.status(404).json({ error: 'Target user not found.' });
    return;
  }

  const token = signToken({
    id: target.id,
    username: target.username,
    email: target.email,
    role: target.role,
    impersonatedBy: {
      id: req.user!.id,
      username: req.user!.username,
    },
  });

  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'owner.impersonate',
    target: target.username,
    details: `Started impersonation session as ${target.username}`,
    ipAddress: getClientIp(req),
  });

  res.json({
    token,
    user: {
      ...target,
      impersonatedBy: { id: req.user!.id, username: req.user!.username },
    },
  });
});

app.post('/api/owner/exit-impersonation', requireAuth, (req: AuthenticatedRequest, res) => {
  const orig = req.user?.impersonatedBy;
  if (!orig) {
    res.status(400).json({ error: 'Not currently impersonating another user.' });
    return;
  }

  const owner = db
    .prepare('SELECT id, username, email, role FROM users WHERE id = ?')
    .get(orig.id) as { id: number; username: string; email: string; role: UserRole } | undefined;

  if (!owner || owner.role !== 'owner') {
    res.status(403).json({ error: 'Original owner account unavailable.' });
    return;
  }

  const token = signToken({
    id: owner.id,
    username: owner.username,
    email: owner.email,
    role: owner.role,
  });

  res.json({ token, user: owner });
});

// ==========================================
// OWNER API KEYS & GLOBAL PORT POOLS
// ==========================================
app.get('/api/owner/api-keys', requireAuth, requireRole('owner'), (req: AuthenticatedRequest, res) => {
  const keys = db
    .prepare(
      `SELECT ak.id, ak.name, ak.key_prefix, ak.last_used_at, ak.created_at, u.username
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       ORDER BY ak.id DESC`
    )
    .all();
  res.json({ keys });
});

app.post('/api/owner/api-keys', requireAuth, requireRole('owner'), (req: AuthenticatedRequest, res) => {
  const name = sanitizeDisplayName(req.body?.name);
  if (!name || name.length < 2) {
    res.status(400).json({ error: 'API key label must be at least 2 characters.' });
    return;
  }

  const rawSecret = `fbbahi_${crypto.randomBytes(24).toString('hex')}`;
  const keyPrefix = rawSecret.slice(0, 14);
  const keyHash = hashApiKey(rawSecret);

  const result = db
    .prepare(`INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)`)
    .run(req.user!.id, name, keyPrefix, keyHash);

  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'owner.api_key_create',
    target: name,
    details: `Created API key ${keyPrefix}...`,
    ipAddress: getClientIp(req),
  });

  res.status(201).json({
    id: Number(result.lastInsertRowid),
    name,
    keyPrefix,
    rawKey: rawSecret,
  });
});

app.delete('/api/owner/api-keys/:id', requireAuth, requireRole('owner'), (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'owner.api_key_delete',
    target: `key#${id}`,
    details: 'Revoked API key',
    ipAddress: getClientIp(req),
  });
  res.json({ deleted: true });
});

app.get('/api/owner/port-pools', requireAuth, requireRole('owner', 'admin'), (_req, res) => {
  const pools = db.prepare('SELECT * FROM port_pools ORDER BY start_port ASC').all();
  const allocated = db
    .prepare('SELECT * FROM port_allocations ORDER BY host_port ASC')
    .all();
  res.json({ pools, allocated });
});

app.post('/api/owner/port-pools', requireAuth, requireRole('owner'), (req: AuthenticatedRequest, res) => {
  const { label, startPort, endPort, protocol = 'tcp' } = req.body as {
    label?: string;
    startPort?: number;
    endPort?: number;
    protocol?: 'tcp' | 'udp' | 'both';
  };
  const cleanLabel = sanitizeDisplayName(label);
  const start = Number(startPort);
  const end = Number(endPort);

  if (!cleanLabel) {
    res.status(400).json({ error: 'Pool label is required.' });
    return;
  }
  if (!isValidPort(start) || !isValidPort(end) || start > end) {
    res.status(400).json({ error: 'Ports must be between 1024 and 65535 with start <= end.' });
    return;
  }
  if (!['tcp', 'udp', 'both'].includes(protocol)) {
    res.status(400).json({ error: 'Protocol must be tcp, udp, or both.' });
    return;
  }

  const result = db
    .prepare('INSERT INTO port_pools (label, start_port, end_port, protocol) VALUES (?, ?, ?, ?)')
    .run(cleanLabel, start, end, protocol);

  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'owner.port_pool_add',
    target: `${start}-${end}/${protocol}`,
    details: cleanLabel,
    ipAddress: getClientIp(req),
  });

  const pool = db.prepare('SELECT * FROM port_pools WHERE id = ?').get(Number(result.lastInsertRowid));
  res.status(201).json({ pool });
});

app.delete('/api/owner/port-pools/:id', requireAuth, requireRole('owner'), (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM port_pools WHERE id = ?').run(id);
  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'owner.port_pool_delete',
    target: `pool#${id}`,
    details: 'Removed global port pool',
    ipAddress: getClientIp(req),
  });
  res.json({ deleted: true });
});

// ==========================================
// SYSTEM, GLOBAL SEARCH, AUDIT & SETTINGS ROUTES
// ==========================================
app.get('/api/system/capabilities', requireAuth, async (_req, res) => {
  const caps = await checkHostCapabilities();
  res.json(caps);
});

app.get('/api/system/stats', requireAuth, (_req, res) => {
  res.json(collectSystemStats());
});

app.get('/api/search', requireAuth, (req: AuthenticatedRequest, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const like = `%${q}%`;
  const isStaff = req.user!.role === 'owner' || req.user!.role === 'admin';

  const servers = isStaff
    ? db
        .prepare(
          `SELECT id, name, software, version, port, status FROM minecraft_servers
           WHERE name LIKE ? OR container_name LIKE ? OR software LIKE ?
           ORDER BY id DESC LIMIT 10`
        )
        .all(like, like, like)
    : db
        .prepare(
          `SELECT DISTINCT ms.id, ms.name, ms.software, ms.version, ms.port, ms.status
           FROM minecraft_servers ms
           LEFT JOIN server_subusers ss ON ss.server_id = ms.id
           WHERE (ms.owner_id = ? OR ss.user_id = ?)
             AND (ms.name LIKE ? OR ms.container_name LIKE ? OR ms.software LIKE ?)
           ORDER BY ms.id DESC LIMIT 10`
        )
        .all(req.user!.id, req.user!.id, like, like, like);

  const instances = isStaff
    ? db
        .prepare(
          `SELECT id, name, instance_name, type, os_template, status FROM vm_instances
           WHERE name LIKE ? OR instance_name LIKE ? OR os_template LIKE ?
           ORDER BY id DESC LIMIT 10`
        )
        .all(like, like, like)
    : db
        .prepare(
          `SELECT id, name, instance_name, type, os_template, status FROM vm_instances
           WHERE owner_id = ? AND (name LIKE ? OR instance_name LIKE ? OR os_template LIKE ?)
           ORDER BY id DESC LIMIT 10`
        )
        .all(req.user!.id, like, like, like);

  const users = isStaff
    ? db
        .prepare(
          `SELECT id, username, email, role FROM users
           WHERE username LIKE ? OR email LIKE ?
           ORDER BY id ASC LIMIT 10`
        )
        .all(like, like)
    : [];

  res.json({ servers, instances, users });
});

app.get('/api/audit-logs', requireAuth, requireRole('owner', 'admin'), (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q) {
    const like = `%${q}%`;
    const logs = db
      .prepare(
        `SELECT * FROM audit_logs
         WHERE username LIKE ? OR action LIKE ? OR target LIKE ? OR details LIKE ?
         ORDER BY id DESC LIMIT 200`
      )
      .all(like, like, like, like);
    res.json({ logs });
    return;
  }
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200').all();
  res.json({ logs });
});

// ==========================================
// MULTI-NODE VPS MANAGEMENT & AGENT ENDPOINTS
// ==========================================
app.get('/api/nodes', requireAuth, (_req, res) => {
  res.json({ nodes: listNodesWithCounts() });
});

app.post('/api/nodes', requireAuth, requireRole('owner', 'admin'), (req: AuthenticatedRequest, res) => {
  try {
    const { name, location, fqdn, daemonPort } = req.body as {
      name: string;
      location: string;
      fqdn: string;
      daemonPort?: number;
    };
    const result = createRemoteNode({
      name,
      location,
      fqdn,
      daemonPort: Number(daemonPort || 8443),
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create remote node.' });
  }
});

app.post('/api/nodes/:id/token', requireAuth, requireRole('owner', 'admin'), (req: AuthenticatedRequest, res) => {
  try {
    const nodeId = Number(req.params.id);
    const result = regenerateNodeToken({
      nodeId,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to rotate node token.' });
  }
});

app.delete('/api/nodes/:id', requireAuth, requireRole('owner', 'admin'), (req: AuthenticatedRequest, res) => {
  try {
    const nodeId = Number(req.params.id);
    deleteRemoteNode({
      nodeId,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.json({ deleted: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to delete remote node.' });
  }
});

app.get('/api/nodes/install-script', (req, res) => {
  const hostHeader = req.get('host') || `localhost:${PORT}`;
  const defaultOrigin = `${req.protocol}://${hostHeader}`;
  const panelUrl =
    process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL'
      ? process.env.APP_URL
      : defaultOrigin;
  res.type('text/plain').send(getNodeInstallScript(panelUrl));
});

app.get('/api/nodes/agent-script', (_req, res) => {
  res.type('text/javascript').send(getNodeAgentSource());
});

app.get(
  '/api/nodes/:id/suggested-ip',
  requireAuth,
  requireRole('owner', 'admin'),
  async (req, res) => {
    try {
      const result = await getSuggestedNodeIp(Number(req.params.id));
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Node not found.' });
    }
  }
);

app.get(
  '/api/nodes/:id/allocations',
  requireAuth,
  requireRole('owner', 'admin'),
  (req, res) => {
    try {
      const allocations = listNodeAllocations(Number(req.params.id));
      res.json({ allocations });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Failed to list allocations.' });
    }
  }
);

app.get('/api/nodes/:id/allocations/available', requireAuth, (req, res) => {
  try {
    const allocations = listAvailableNodeAllocations(Number(req.params.id));
    res.json({ allocations });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Failed to list available allocations.' });
  }
});

app.post(
  '/api/nodes/:id/allocations',
  requireAuth,
  requireRole('owner', 'admin'),
  (req: AuthenticatedRequest, res) => {
    try {
      const { ip, ipAlias, ports, protocol, notes } = req.body as {
        ip: string;
        ipAlias?: string;
        ports: string;
        protocol?: string;
        notes?: string;
      };
      const result = createNodeAllocations({
        nodeId: Number(req.params.id),
        ip,
        ipAlias,
        portsInput: ports,
        protocol,
        notes,
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create allocations.' });
    }
  }
);

app.patch(
  '/api/nodes/:id/allocations/:allocId',
  requireAuth,
  requireRole('owner', 'admin'),
  (req: AuthenticatedRequest, res) => {
    try {
      const { ipAlias, notes } = req.body as { ipAlias?: string | null; notes?: string | null };
      const allocation = updateNodeAllocation({
        nodeId: Number(req.params.id),
        allocationId: Number(req.params.allocId),
        ipAlias,
        notes,
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json({ allocation });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update allocation.' });
    }
  }
);

app.delete(
  '/api/nodes/:id/allocations/:allocId',
  requireAuth,
  requireRole('owner', 'admin'),
  (req: AuthenticatedRequest, res) => {
    try {
      deleteNodeAllocation({
        nodeId: Number(req.params.id),
        allocationId: Number(req.params.allocId),
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json({ deleted: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to delete allocation.' });
    }
  }
);

app.post(
  '/api/nodes/:id/allocations/bulk-delete',
  requireAuth,
  requireRole('owner', 'admin'),
  (req: AuthenticatedRequest, res) => {
    try {
      const { ids } = req.body as { ids: number[] };
      const result = bulkDeleteNodeAllocations({
        nodeId: Number(req.params.id),
        allocationIds: Array.isArray(ids) ? ids : [],
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Bulk delete failed.' });
    }
  }
);

function maskSettingsForResponse(all: Record<string, string>, role: UserRole): Record<string, string> {
  const aiCfg = resolveOpenAiConfig();
  const {
    smtp_pass: _smtp,
    cloud_secret_key: _csec,
    cloud_access_key: _cacc,
    telegram_bot_token: _tg,
    openai_api_key_enc: _openaiEnc,
    ...rest
  } = all;

  if (role !== 'owner') {
    return {
      ...rest,
      openai_model: aiCfg.model,
      openai_configured: aiCfg.apiKey ? '1' : '0',
    };
  }
  return {
    ...rest,
    smtp_pass: all.smtp_pass ? '********' : '',
    cloud_secret_key: all.cloud_secret_key ? '********' : '',
    cloud_access_key: all.cloud_access_key || '',
    telegram_bot_token: all.telegram_bot_token ? '********' : '',
    openai_api_key: all.openai_api_key_enc ? '********' : '',
    openai_model: aiCfg.model,
    openai_configured: aiCfg.apiKey ? '1' : '0',
    openai_source: aiCfg.source,
  };
}

app.get('/api/settings', requireAuth, (req: AuthenticatedRequest, res) => {
  const all = getAllSettings();
  res.json({ settings: maskSettingsForResponse(all, req.user!.role) });
});

app.put('/api/settings', requireAuth, requireRole('owner', 'admin'), (req: AuthenticatedRequest, res) => {
  const body = req.body as Record<string, string | boolean>;

  const webhookStr =
    typeof body.discord_webhook_url === 'string' ? body.discord_webhook_url.trim() : '';
  if (!validateDiscordWebhookUrl(webhookStr)) {
    res.status(400).json({
      error: 'Discord Webhook URL must be a valid https://discord.com/api/webhooks/... endpoint.',
    });
    return;
  }

  const cleanName = sanitizeDisplayName(body.panel_name) || 'FB BAHI Panel';
  const cleanSub = sanitizeDisplayName(body.panel_subtitle) || 'Game Server & Cloud VM Control';

  setSetting('panel_name', cleanName);
  setSetting('panel_subtitle', cleanSub);
  setSetting('discord_webhook_url', webhookStr);
  setSetting(
    'webhook_on_start',
    body.webhook_on_start === true || body.webhook_on_start === '1' ? '1' : '0'
  );
  setSetting(
    'webhook_on_stop',
    body.webhook_on_stop === true || body.webhook_on_stop === '1' ? '1' : '0'
  );
  setSetting(
    'webhook_on_crash',
    body.webhook_on_crash === true || body.webhook_on_crash === '1' ? '1' : '0'
  );

  // Owner-only global controls (Registration, Telegram, Cloud Backup, Maintenance, SMTP)
  if (req.user!.role === 'owner') {
    if (body.allow_public_registration !== undefined) {
      setSetting(
        'allow_public_registration',
        body.allow_public_registration === true || body.allow_public_registration === '1'
          ? '1'
          : '0'
      );
    }
    if (
      typeof body.registration_mode === 'string' &&
      ['instant', 'approval'].includes(body.registration_mode)
    ) {
      setSetting('registration_mode', body.registration_mode);
    }

    if (typeof body.telegram_bot_token === 'string' && body.telegram_bot_token !== '********') {
      const tgToken = body.telegram_bot_token.trim();
      if (tgToken && !TELEGRAM_TOKEN_REGEX.test(tgToken)) {
        res.status(400).json({ error: 'Invalid Telegram Bot Token format (e.g. 123456789:ABC...).' });
        return;
      }
      setSetting('telegram_bot_token', tgToken);
    }
    if (typeof body.telegram_chat_id === 'string') {
      const tgChat = body.telegram_chat_id.trim();
      if (tgChat && !TELEGRAM_CHAT_ID_REGEX.test(tgChat)) {
        res.status(400).json({ error: 'Invalid Telegram Chat ID format.' });
        return;
      }
      setSetting('telegram_chat_id', tgChat);
    }

    if (
      typeof body.cloud_provider === 'string' &&
      ['none', 's3', 'r2', 'b2', 'gdrive'].includes(body.cloud_provider)
    ) {
      setSetting('cloud_provider', body.cloud_provider);
    }
    if (typeof body.cloud_endpoint === 'string') {
      const ep = body.cloud_endpoint.trim();
      if (ep && !validateCloudEndpointUrl(ep)) {
        res.status(400).json({ error: 'Cloud S3 endpoint must be a public HTTPS URL.' });
        return;
      }
      setSetting('cloud_endpoint', ep.slice(0, 240));
    }
    if (typeof body.cloud_region === 'string') {
      setSetting('cloud_region', body.cloud_region.trim().slice(0, 64) || 'auto');
    }
    if (typeof body.cloud_bucket === 'string') {
      setSetting('cloud_bucket', body.cloud_bucket.trim().slice(0, 128));
    }
    if (typeof body.cloud_access_key === 'string') {
      setSetting('cloud_access_key', body.cloud_access_key.trim().slice(0, 128));
    }
    if (typeof body.cloud_secret_key === 'string' && body.cloud_secret_key !== '********') {
      setSetting('cloud_secret_key', body.cloud_secret_key.trim().slice(0, 256));
    }
    if (typeof body.cloud_rclone_remote === 'string') {
      const rr = body.cloud_rclone_remote.trim();
      if (rr && !RCLONE_REMOTE_REGEX.test(rr)) {
        res.status(400).json({ error: 'Invalid rclone remote name (letters, numbers, _, -).' });
        return;
      }
      setSetting('cloud_rclone_remote', rr);
    }
    if (typeof body.cloud_rclone_folder === 'string') {
      const rf = body.cloud_rclone_folder.trim() || 'fbbahi-backups';
      if (!RCLONE_FOLDER_REGEX.test(rf)) {
        res.status(400).json({ error: 'Invalid rclone destination folder path.' });
        return;
      }
      setSetting('cloud_rclone_folder', rf);
    }
    if (body.cloud_auto_upload !== undefined) {
      setSetting(
        'cloud_auto_upload',
        body.cloud_auto_upload === true || body.cloud_auto_upload === '1' ? '1' : '0'
      );
    }

    if (body.maintenance_mode !== undefined) {
      setSetting(
        'maintenance_mode',
        body.maintenance_mode === true || body.maintenance_mode === '1' ? '1' : '0'
      );
    }
    if (typeof body.maintenance_message === 'string') {
      setSetting('maintenance_message', body.maintenance_message.trim().slice(0, 240));
    }
    if (body.announcement_enabled !== undefined) {
      setSetting(
        'announcement_enabled',
        body.announcement_enabled === true || body.announcement_enabled === '1' ? '1' : '0'
      );
    }
    if (
      typeof body.announcement_level === 'string' &&
      ['info', 'warning', 'critical'].includes(body.announcement_level)
    ) {
      setSetting('announcement_level', body.announcement_level);
    }
    if (typeof body.announcement_text === 'string') {
      setSetting('announcement_text', body.announcement_text.trim().slice(0, 240));
    }
    if (typeof body.smtp_host === 'string') setSetting('smtp_host', body.smtp_host.trim().slice(0, 120));
    if (typeof body.smtp_port === 'string' || typeof body.smtp_port === 'number') {
      setSetting('smtp_port', String(body.smtp_port).slice(0, 10));
    }
    if (typeof body.smtp_user === 'string') setSetting('smtp_user', body.smtp_user.trim().slice(0, 120));
    if (typeof body.smtp_pass === 'string' && body.smtp_pass !== '********') {
      setSetting('smtp_pass', body.smtp_pass);
    }
    if (typeof body.smtp_from === 'string') setSetting('smtp_from', body.smtp_from.trim().slice(0, 120));
    if (typeof body.vps_reboot_warning === 'string') {
      setSetting('vps_reboot_warning', body.vps_reboot_warning.trim().slice(0, 240));
    }
    if (typeof body.openai_model === 'string') {
      const m = body.openai_model.trim();
      if (!ALLOWED_OPENAI_MODEL_REGEX.test(m)) {
        res.status(400).json({ error: 'Invalid OpenAI model identifier.' });
        return;
      }
      setSetting('openai_model', m);
    }
    if (typeof body.openai_api_key === 'string' && body.openai_api_key !== '********') {
      const rawOpenAiKey = body.openai_api_key.trim();
      if (!rawOpenAiKey) {
        setSetting('openai_api_key_enc', '');
      } else {
        if (/[\r\n\s]/.test(rawOpenAiKey) || rawOpenAiKey.length < 12 || rawOpenAiKey.length > 256) {
          res.status(400).json({ error: 'Invalid OpenAI API key format.' });
          return;
        }
        setSetting('openai_api_key_enc', encryptSecret(rawOpenAiKey));
      }
    }
  }

  // Appearance & Custom Theme (Owner & Admin)
  if (
    typeof body.ui_theme === 'string' &&
    (VALID_UI_THEMES as readonly string[]).includes(body.ui_theme)
  ) {
    setSetting('ui_theme', body.ui_theme);
  }
  if (body.custom_bg_opacity !== undefined) {
    const op = Math.min(0.9, Math.max(0.05, Number(body.custom_bg_opacity) || 0.35));
    setSetting('custom_bg_opacity', op.toFixed(2));
  }
  if (typeof body.custom_bg_url === 'string') {
    const rawBg = body.custom_bg_url.trim();
    if (!rawBg) {
      setSetting('custom_bg_url', '');
      setSetting('custom_bg_type', 'none');
    } else if (
      rawBg.startsWith('/uploads/backgrounds/') ||
      rawBg.startsWith('https://') ||
      rawBg.startsWith('http://')
    ) {
      setSetting('custom_bg_url', rawBg.slice(0, 500));
      if (
        typeof body.custom_bg_type === 'string' &&
        ['image', 'gif', 'video'].includes(body.custom_bg_type)
      ) {
        setSetting('custom_bg_type', body.custom_bg_type);
      } else {
        const lower = rawBg.toLowerCase();
        const inferred =
          lower.endsWith('.mp4') || lower.endsWith('.webm')
            ? 'video'
            : lower.endsWith('.gif')
            ? 'gif'
            : 'image';
        setSetting('custom_bg_type', inferred);
      }
    } else {
      res.status(400).json({ error: 'Custom background URL must start with /uploads/backgrounds/, https://, or http://.' });
      return;
    }
  }

  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'settings.update',
    target: 'panel_settings',
    details: 'Updated panel configuration',
    ipAddress: getClientIp(req),
  });

  res.json({ settings: maskSettingsForResponse(getAllSettings(), req.user!.role) });
});

app.post(
  '/api/settings/background',
  requireAuth,
  requireRole('owner', 'admin'),
  backgroundUpload.single('background'),
  (req: AuthenticatedRequest, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'Please select an image, GIF, or MP4/WebM video file.' });
        return;
      }

      const ext = path.extname(file.originalname || '').toLowerCase();
      const allowedExts: Record<string, 'image' | 'gif' | 'video'> = {
        '.png': 'image',
        '.jpg': 'image',
        '.jpeg': 'image',
        '.webp': 'image',
        '.gif': 'gif',
        '.mp4': 'video',
        '.webm': 'video',
      };
      const bgType = allowedExts[ext];
      if (!bgType) {
        res.status(400).json({
          error: 'Unsupported media format. Allowed: PNG, JPG, WEBP, GIF, MP4, WEBM.',
        });
        return;
      }

      const bgDir = getBackgroundsDir();
      fs.mkdirSync(bgDir, { recursive: true });

      // Remove prior uploaded background file to avoid disk bloat
      const prevUrl = getAllSettings().custom_bg_url || '';
      if (prevUrl.startsWith('/uploads/backgrounds/')) {
        const prevFilename = path.basename(prevUrl);
        const prevPath = resolveConfinedPath(bgDir, prevFilename);
        if (fs.existsSync(prevPath)) {
          fs.rmSync(prevPath, { force: true });
        }
      }

      const filename = `bg-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
      const destPath = resolveConfinedPath(bgDir, filename);
      fs.writeFileSync(destPath, file.buffer);

      const publicUrl = `/uploads/backgrounds/${filename}`;
      setSetting('custom_bg_url', publicUrl);
      setSetting('custom_bg_type', bgType);

      recordAuditLog({
        userId: req.user!.id,
        username: req.user!.username,
        action: 'settings.background_upload',
        target: filename,
        details: `Uploaded ${bgType} background (${(file.size / 1024).toFixed(1)} KB)`,
        ipAddress: getClientIp(req),
      });

      res.json({
        bgUrl: publicUrl,
        bgType,
        settings: maskSettingsForResponse(getAllSettings(), req.user!.role),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Background upload failed.' });
    }
  }
);

app.delete(
  '/api/settings/background',
  requireAuth,
  requireRole('owner', 'admin'),
  (req: AuthenticatedRequest, res) => {
    const bgDir = getBackgroundsDir();
    const prevUrl = getAllSettings().custom_bg_url || '';
    if (prevUrl.startsWith('/uploads/backgrounds/')) {
      const prevFilename = path.basename(prevUrl);
      const prevPath = resolveConfinedPath(bgDir, prevFilename);
      if (fs.existsSync(prevPath)) {
        fs.rmSync(prevPath, { force: true });
      }
    }
    setSetting('custom_bg_url', '');
    setSetting('custom_bg_type', 'none');
    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'settings.background_reset',
      target: 'panel_background',
      details: 'Removed custom panel background media',
      ipAddress: getClientIp(req),
    });
    res.json({ settings: maskSettingsForResponse(getAllSettings(), req.user!.role) });
  }
);

app.post('/api/settings/test-webhook', requireAuth, requireRole('owner', 'admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const result = await sendDiscordAlert({
      event: 'test',
      title: 'FB BAHI Panel Webhook Test',
      description: `Webhook integration verified by **${req.user!.username}**.`,
    });
    if (!result.sent) {
      res.status(400).json({ error: result.reason || 'Webhook delivery failed.' });
      return;
    }
    res.json({ sent: true, telegramSent: Boolean(result.telegramSent) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Webhook test failed.' });
  }
});

app.post('/api/settings/test-telegram', requireAuth, requireRole('owner'), async (req: AuthenticatedRequest, res) => {
  try {
    const result = await sendTelegramAlert({
      title: 'Telegram Bot Test',
      description: `Telegram alert channel verified by ${req.user!.username}.`,
    });
    if (!result.sent) {
      res.status(400).json({ error: result.reason || 'Telegram delivery failed.' });
      return;
    }
    res.json({ sent: true });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Telegram test failed.' });
  }
});

app.post('/api/settings/test-cloud', requireAuth, requireRole('owner'), async (_req, res) => {
  try {
    const result = await testCloudConnection();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Cloud connection check failed.' });
  }
});

app.post('/api/settings/test-openai', requireAuth, requireRole('owner'), async (req: AuthenticatedRequest, res) => {
  try {
    const { apiKey, model } = (req.body || {}) as { apiKey?: string; model?: string };
    const result = await testOpenAiConnection({ apiKey, model });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'OpenAI connection test failed.' });
  }
});

// ==========================================
// MINECRAFT SERVER ROUTES
// ==========================================
app.get('/api/minecraft/servers', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const servers = await syncMinecraftStatuses({ id: req.user!.id, role: req.user!.role });
    res.json({ servers });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list servers.' });
  }
});

app.post('/api/minecraft/servers', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const {
      name,
      software,
      version,
      ramMb,
      cpuPercent,
      diskMb,
      port,
      primaryAllocationId,
      additionalAllocationIds,
      eulaAccepted,
      ownerId,
      nodeId,
    } = req.body as {
      name: string;
      software: string;
      version: string;
      ramMb: number;
      cpuPercent: number;
      diskMb?: number;
      port?: number;
      primaryAllocationId?: number | 'auto';
      additionalAllocationIds?: number[];
      eulaAccepted: boolean;
      ownerId?: number;
      nodeId?: number;
    };

    const isStaff = req.user!.role === 'owner' || req.user!.role === 'admin';
    const targetOwnerId = isStaff && ownerId ? Number(ownerId) : req.user!.id;
    const ownerRow = db
      .prepare('SELECT id, role FROM users WHERE id = ?')
      .get(targetOwnerId) as { id: number; role: UserRole } | undefined;

    if (!ownerRow) {
      res.status(400).json({ error: 'Target owner user does not exist.' });
      return;
    }

    const enforceQuota = req.user!.role === 'user' || ownerRow.role === 'user';

    const result = await createMinecraftServer({
      name,
      software,
      version,
      ramMb,
      cpuPercent,
      diskMb,
      port,
      primaryAllocationId,
      additionalAllocationIds,
      eulaAccepted,
      ownerId: ownerRow.id,
      nodeId,
      enforceQuota,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });

    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to deploy server.' });
  }
});

app.put(
  '/api/minecraft/servers/:id/admin',
  requireAuth,
  requireRole('owner', 'admin'),
  (req: AuthenticatedRequest, res) => {
    const id = Number(req.params.id);
    const { ownerId, ramMb, cpuPercent, diskMb, maxAllocations, isSuspended } = req.body as {
      ownerId?: number;
      ramMb?: number;
      cpuPercent?: number;
      diskMb?: number;
      maxAllocations?: number;
      isSuspended?: boolean;
    };

    const srv = db.prepare('SELECT id, container_name FROM minecraft_servers WHERE id = ?').get(id) as
      | { id: number; container_name: string }
      | undefined;
    if (!srv) {
      res.status(404).json({ error: 'Minecraft server not found.' });
      return;
    }

    db.prepare(
      `UPDATE minecraft_servers SET
         owner_id = COALESCE(?, owner_id),
         ram_mb = COALESCE(?, ram_mb),
         cpu_percent = COALESCE(?, cpu_percent),
         disk_mb = COALESCE(?, disk_mb),
         max_allocations = COALESCE(?, max_allocations),
         is_suspended = COALESCE(?, is_suspended)
       WHERE id = ?`
    ).run(
      parseBoundedInt(ownerId, 1),
      parseBoundedInt(ramMb, 512),
      parseBoundedInt(cpuPercent, 25),
      parseBoundedInt(diskMb, 1024),
      parseBoundedInt(maxAllocations, 1, 50),
      isSuspended !== undefined ? (isSuspended ? 1 : 0) : null,
      id
    );

    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'minecraft.admin_update',
      target: srv.container_name,
      details: `Updated server limits/owner/allocations/suspension`,
      ipAddress: getClientIp(req),
    });

    res.json({ updated: true });
  }
);

app.get('/api/minecraft/servers/:id/allocations', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  const access = canAccessMinecraftServer(req.user!, id);
  if (!access.allowed) {
    res.status(403).json({ error: access.reason || 'Permission denied.' });
    return;
  }
  const srv = db
    .prepare('SELECT max_allocations FROM minecraft_servers WHERE id = ?')
    .get(id) as { max_allocations: number } | undefined;
  res.json({
    allocations: listServerAllocations(id),
    maxAllocations: srv?.max_allocations ?? 3,
  });
});

app.post('/api/minecraft/servers/:id/allocations', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  const access = canAccessMinecraftServer(req.user!, id);
  if (!access.allowed || !access.isOwnerOrAdmin) {
    res.status(403).json({ error: access.reason || 'Only the server owner or staff can manage allocations.' });
    return;
  }
  try {
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : undefined;
    const isStaff = req.user!.role === 'owner' || req.user!.role === 'admin';
    const result = assignNextAllocationToServer({
      serverId: id,
      notes,
      isStaff,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to assign allocation.' });
  }
});

app.patch(
  '/api/minecraft/servers/:id/allocations/:allocId',
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id);
    if (!access.allowed || !access.isOwnerOrAdmin) {
      res.status(403).json({ error: access.reason || 'Only the server owner or staff can edit allocation notes.' });
      return;
    }
    try {
      const notes = typeof req.body?.notes === 'string' ? req.body.notes : null;
      const allocations = updateServerAllocationNotes({
        serverId: id,
        allocationId: Number(req.params.allocId),
        notes,
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json({ allocations });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update allocation notes.' });
    }
  }
);

app.post(
  '/api/minecraft/servers/:id/allocations/:allocId/primary',
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id);
    if (!access.allowed || !access.isOwnerOrAdmin) {
      res.status(403).json({ error: access.reason || 'Only the server owner or staff can switch primary port.' });
      return;
    }
    try {
      const result = setServerPrimaryAllocation({
        serverId: id,
        allocationId: Number(req.params.allocId),
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to set primary allocation.' });
    }
  }
);

app.delete(
  '/api/minecraft/servers/:id/allocations/:allocId',
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id);
    if (!access.allowed || !access.isOwnerOrAdmin) {
      res.status(403).json({ error: access.reason || 'Only the server owner or staff can unassign allocations.' });
      return;
    }
    try {
      const result = unassignServerAllocation({
        serverId: id,
        allocationId: Number(req.params.allocId),
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to unassign allocation.' });
    }
  }
);

app.post('/api/minecraft/servers/:id/power', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const action = req.body?.action as 'start' | 'stop' | 'restart' | 'kill' | 'delete';
    if (!['start', 'stop', 'restart', 'kill', 'delete'].includes(action)) {
      res.status(400).json({ error: 'Invalid power action.' });
      return;
    }

    const access = canAccessMinecraftServer(
      req.user!,
      id,
      action === 'delete' ? undefined : 'can_start_stop'
    );
    if (!access.allowed || (action === 'delete' && !access.isOwnerOrAdmin)) {
      res.status(403).json({ error: access.reason || 'Permission denied.' });
      return;
    }

    if (action === 'delete') {
      unregisterServerSchedules(id);
    }
    const result = await controlMinecraftServer({
      id,
      action,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.json(result);
  } catch (err) {
    res.status(getDaemonErrorStatus(err)).json({ error: err instanceof Error ? err.message : 'Power action failed.' });
  }
});

app.get('/api/minecraft/servers/:id/metrics', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const metrics = await getMinecraftContainerMetrics(id);
    res.json(metrics);
  } catch (err) {
    res.status(getDaemonErrorStatus(err)).json({ error: err instanceof Error ? err.message : 'Failed to fetch metrics.' });
  }
});

app.get('/api/minecraft/servers/:id/logs', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id, 'can_use_console');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const lines = await getMinecraftLogs(id);
    res.json({ lines });
  } catch (err) {
    res.status(getDaemonErrorStatus(err)).json({ error: err instanceof Error ? err.message : 'Failed to fetch logs.' });
  }
});

app.post('/api/minecraft/servers/:id/command', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id, 'can_use_console');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const command = String(req.body?.command || '');
    await sendMinecraftCommand(id, command);
    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'minecraft.command',
      target: `server#${id}`,
      details: command.slice(0, 120),
      ipAddress: getClientIp(req),
    });
    res.json({ sent: true });
  } catch (err) {
    res.status(getDaemonErrorStatus(err)).json({ error: err instanceof Error ? err.message : 'Failed to send command.' });
  }
});

// Minecraft Properties Visual Editor
app.get('/api/minecraft/servers/:id/properties', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id, 'can_edit_files');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const properties = getMinecraftProperties(id);
    res.json({ properties });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to read properties.' });
  }
});

app.put('/api/minecraft/servers/:id/properties', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id, 'can_edit_files');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const properties = updateMinecraftProperties(
      id,
      (req.body?.properties || {}) as Record<string, string | number | boolean>
    );
    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'minecraft.properties_update',
      target: `server#${id}`,
      details: 'Updated server.properties via visual editor',
      ipAddress: getClientIp(req),
    });
    res.json({ properties });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update properties.' });
  }
});

// Minecraft Player Manager
app.get('/api/minecraft/servers/:id/players', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id, 'can_use_console');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const data = await getMinecraftPlayers(id);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to list players.' });
  }
});

app.post(
  '/api/minecraft/servers/:id/players/action',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const access = canAccessMinecraftServer(req.user!, id, 'can_use_console');
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      const { playerName, action } = req.body as {
        playerName: string;
        action: 'kick' | 'ban' | 'pardon' | 'op' | 'deop';
      };
      if (!['kick', 'ban', 'pardon', 'op', 'deop'].includes(action)) {
        res.status(400).json({ error: 'Invalid player action.' });
        return;
      }
      const result = await runPlayerAction({
        serverId: id,
        playerName: String(playerName || '').trim(),
        action,
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Player action failed.' });
    }
  }
);

// Minecraft Cron Schedules
app.get('/api/minecraft/servers/:id/schedules', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  const access = canAccessMinecraftServer(req.user!, id);
  if (!access.allowed) {
    res.status(403).json({ error: access.reason });
    return;
  }
  const schedules = db
    .prepare('SELECT * FROM minecraft_schedules WHERE server_id = ? ORDER BY id DESC')
    .all(id);
  res.json({ schedules });
});

app.post('/api/minecraft/servers/:id/schedules', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  const access = canAccessMinecraftServer(req.user!, id, 'can_start_stop');
  if (!access.allowed) {
    res.status(403).json({ error: access.reason });
    return;
  }

  const { name, cronExpr, action, payload = '', retentionCount = 7 } = req.body as {
    name?: string;
    cronExpr?: string;
    action?: 'restart' | 'backup' | 'command';
    payload?: string;
    retentionCount?: number;
  };

  const cleanName = sanitizeDisplayName(name);
  if (!cleanName) {
    res.status(400).json({ error: 'Schedule name is required.' });
    return;
  }
  if (!cronExpr || !cron.validate(cronExpr.trim())) {
    res.status(400).json({ error: 'Invalid cron expression (e.g. 0 */6 * * *).' });
    return;
  }
  if (!action || !['restart', 'backup', 'command'].includes(action)) {
    res.status(400).json({ error: 'Action must be restart, backup, or command.' });
    return;
  }

  const cleanRetention = Math.min(50, Math.max(1, Number(retentionCount) || 7));
  const result = db
    .prepare(
      `INSERT INTO minecraft_schedules (server_id, name, cron_expr, action, payload, retention_count, enabled)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      id,
      cleanName,
      cronExpr.trim(),
      action,
      String(payload || '').slice(0, 200),
      cleanRetention
    );

  const row = db
    .prepare('SELECT * FROM minecraft_schedules WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as ScheduleRow;
  registerScheduleTask(row);

  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'minecraft.schedule_create',
    target: `server#${id}`,
    details: `${cleanName} (${cronExpr.trim()} -> ${action})`,
    ipAddress: getClientIp(req),
  });

  res.status(201).json({ schedule: row });
});

app.patch(
  '/api/minecraft/servers/:id/schedules/:scheduleId',
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const id = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    const access = canAccessMinecraftServer(req.user!, id, 'can_start_stop');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const enabled = req.body?.enabled ? 1 : 0;
    db.prepare('UPDATE minecraft_schedules SET enabled = ? WHERE id = ? AND server_id = ?').run(
      enabled,
      scheduleId,
      id
    );
    const row = db
      .prepare('SELECT * FROM minecraft_schedules WHERE id = ? AND server_id = ?')
      .get(scheduleId, id) as ScheduleRow | undefined;
    if (row) {
      if (enabled) registerScheduleTask(row);
      else unregisterScheduleTask(row.id);
    }
    res.json({ schedule: row });
  }
);

app.delete(
  '/api/minecraft/servers/:id/schedules/:scheduleId',
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const id = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    const access = canAccessMinecraftServer(req.user!, id, 'can_start_stop');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    unregisterScheduleTask(scheduleId);
    db.prepare('DELETE FROM minecraft_schedules WHERE id = ? AND server_id = ?').run(scheduleId, id);
    res.json({ deleted: true });
  }
);

// Minecraft Sub-Users / Staff Permissions
app.get('/api/minecraft/servers/:id/subusers', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  const access = canAccessMinecraftServer(req.user!, id);
  if (!access.allowed) {
    res.status(403).json({ error: access.reason });
    return;
  }

  const subusers = db
    .prepare(
      `SELECT ss.*, u.username, u.email
       FROM server_subusers ss
       JOIN users u ON u.id = ss.user_id
       WHERE ss.server_id = ?
       ORDER BY ss.id DESC`
    )
    .all(id);
  res.json({ subusers });
});

app.post('/api/minecraft/servers/:id/subusers', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  const access = canAccessMinecraftServer(req.user!, id);
  if (!access.allowed || !access.isOwnerOrAdmin) {
    res.status(403).json({ error: 'Only server owners or administrators can invite sub-users.' });
    return;
  }

  const {
    identifier,
    canStartStop = true,
    canUseConsole = true,
    canEditFiles = false,
    canManageBackups = false,
  } = req.body as {
    identifier?: string;
    canStartStop?: boolean;
    canUseConsole?: boolean;
    canEditFiles?: boolean;
    canManageBackups?: boolean;
  };

  const clean = String(identifier || '').trim();
  const targetUser = db
    .prepare('SELECT id, username, email FROM users WHERE username = ? OR email = ?')
    .get(clean, clean.toLowerCase()) as { id: number; username: string; email: string } | undefined;

  if (!targetUser) {
    res.status(404).json({ error: 'No panel user found with that username or email.' });
    return;
  }

  db.prepare(
    `INSERT INTO server_subusers (server_id, user_id, can_start_stop, can_use_console, can_edit_files, can_manage_backups)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, user_id) DO UPDATE SET
       can_start_stop = excluded.can_start_stop,
       can_use_console = excluded.can_use_console,
       can_edit_files = excluded.can_edit_files,
       can_manage_backups = excluded.can_manage_backups`
  ).run(
    id,
    targetUser.id,
    canStartStop ? 1 : 0,
    canUseConsole ? 1 : 0,
    canEditFiles ? 1 : 0,
    canManageBackups ? 1 : 0
  );

  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'minecraft.subuser_invite',
    target: `server#${id}`,
    details: `Granted access to ${targetUser.username}`,
    ipAddress: getClientIp(req),
  });

  res.status(201).json({ saved: true });
});

app.delete(
  '/api/minecraft/servers/:id/subusers/:subId',
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const id = Number(req.params.id);
    const subId = Number(req.params.subId);
    const access = canAccessMinecraftServer(req.user!, id);
    if (!access.allowed || !access.isOwnerOrAdmin) {
      res.status(403).json({ error: 'Only server owners or administrators can remove sub-users.' });
      return;
    }
    db.prepare('DELETE FROM server_subusers WHERE id = ? AND server_id = ?').run(subId, id);
    res.json({ deleted: true });
  }
);

// Files & Modrinth Routes
app.get('/api/minecraft/servers/:id/files', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id, 'can_edit_files');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    const entries = listServerFiles(id, relPath);
    res.json({ entries, currentPath: relPath });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to list files.' });
  }
});

app.get('/api/minecraft/servers/:id/files/content', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id, 'can_edit_files');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    const content = readServerFile(id, relPath);
    res.json({ content, path: relPath });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to read file.' });
  }
});

app.put('/api/minecraft/servers/:id/files/content', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id, 'can_edit_files');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const { path: relPath, content } = req.body as { path: string; content: string };
    if (typeof relPath !== 'string' || typeof content !== 'string') {
      res.status(400).json({ error: 'File path and content are required.' });
      return;
    }
    writeServerFile(id, relPath, content);
    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'minecraft.file_edit',
      target: `server#${id}`,
      details: `Saved ${relPath}`,
      ipAddress: getClientIp(req),
    });
    res.json({ saved: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save file.' });
  }
});

app.post('/api/minecraft/servers/:id/files/entry', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id, 'can_edit_files');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const { path: relPath, type } = req.body as { path: string; type: 'file' | 'folder' };
    if (typeof relPath !== 'string' || (type !== 'file' && type !== 'folder')) {
      res.status(400).json({ error: 'Valid path and entry type required.' });
      return;
    }
    createServerEntry(id, relPath, type);
    res.status(201).json({ created: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create item.' });
  }
});

app.delete('/api/minecraft/servers/:id/files/entry', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id, 'can_edit_files');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    deleteServerEntry(id, relPath);
    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'minecraft.file_delete',
      target: `server#${id}`,
      details: `Deleted ${relPath}`,
      ipAddress: getClientIp(req),
    });
    res.json({ deleted: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to delete item.' });
  }
});

app.post(
  '/api/minecraft/servers/:id/files/upload',
  requireAuth,
  upload.array('files', 10),
  (req: AuthenticatedRequest, res) => {
    try {
      const serverId = Number(req.params.id);
      const access = canAccessMinecraftServer(req.user!, serverId, 'can_edit_files');
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(serverId) as
        | MinecraftServerRow
        | undefined;
      if (!srv) {
        res.status(404).json({ error: 'Minecraft server not found.' });
        return;
      }

      const targetRelDir = typeof req.body?.dir === 'string' ? req.body.dir : '';
      const destDir = resolveConfinedPath(srv.data_dir, targetRelDir);
      fs.mkdirSync(destDir, { recursive: true });

      const uploadedFiles = (req.files as Express.Multer.File[]) || [];
      const savedNames: string[] = [];

      for (const file of uploadedFiles) {
        const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!safeName) continue;
        const fullDest = resolveConfinedPath(destDir, safeName);
        fs.writeFileSync(fullDest, file.buffer);
        savedNames.push(safeName);
      }

      recordAuditLog({
        userId: req.user!.id,
        username: req.user!.username,
        action: 'minecraft.file_upload',
        target: srv.container_name,
        details: `Uploaded ${savedNames.join(', ')}`,
        ipAddress: getClientIp(req),
      });

      res.json({ uploaded: savedNames });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'File upload failed.' });
    }
  }
);

app.get('/api/minecraft/servers/:id/backup', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  const access = canAccessMinecraftServer(req.user!, id, 'can_manage_backups');
  if (!access.allowed) {
    res.status(403).json({ error: access.reason });
    return;
  }
  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'minecraft.backup',
    target: `server#${id}`,
    details: 'Downloaded full .zip server backup',
    ipAddress: getClientIp(req),
  });
  streamServerBackupZip(id, res);
});

app.get('/api/minecraft/servers/:id/backups', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const backups = listMinecraftBackups(id);
    res.json({ backups });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to list backups.' });
  }
});

app.post('/api/minecraft/servers/:id/backups', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id, 'can_manage_backups');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const backup = await createMinecraftBackup({
      serverId: id,
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      backupType: 'manual',
      createdBy: req.user!.username,
      userId: req.user!.id,
      ipAddress: getClientIp(req),
    });
    res.status(201).json({ backup });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create backup.' });
  }
});

app.post(
  '/api/minecraft/servers/:id/backups/:backupId/restore',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const backupId = Number(req.params.backupId);
      const access = canAccessMinecraftServer(req.user!, id, 'can_manage_backups');
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      const createPreRestore = req.body?.createPreRestore !== false;
      const result = await restoreMinecraftBackup({
        serverId: id,
        backupId,
        createPreRestore,
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to restore backup.' });
    }
  }
);

app.post(
  '/api/minecraft/servers/:id/backups/:backupId/cloud',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const backupId = Number(req.params.backupId);
      const access = canAccessMinecraftServer(req.user!, id, 'can_manage_backups');
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      const backup = await uploadMinecraftBackupToCloud({
        serverId: id,
        backupId,
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json({ backup });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Cloud upload failed.' });
    }
  }
);

app.get(
  '/api/minecraft/servers/:id/backups/:backupId/download',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const backupId = Number(req.params.backupId);
      const access = canAccessMinecraftServer(req.user!, id, 'can_manage_backups');
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      await downloadMinecraftBackupFile(id, backupId, res);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to download backup.' });
    }
  }
);

app.delete(
  '/api/minecraft/servers/:id/backups/:backupId',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const backupId = Number(req.params.backupId);
      const access = canAccessMinecraftServer(req.user!, id, 'can_manage_backups');
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      await deleteMinecraftBackup({
        serverId: id,
        backupId,
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json({ deleted: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to delete backup.' });
    }
  }
);

app.get('/api/modrinth/search', requireAuth, async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const projectType = req.query.type === 'mod' ? 'mod' : 'plugin';
    const loader = typeof req.query.loader === 'string' ? req.query.loader : undefined;
    const gameVersion = typeof req.query.version === 'string' ? req.query.version : undefined;

    const hits = await searchModrinthProjects({ query, projectType, loader, gameVersion });
    res.json({ hits });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Modrinth search failed.' });
  }
});

app.post('/api/minecraft/servers/:id/modrinth/install', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessMinecraftServer(req.user!, id, 'can_edit_files');
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const { projectId, projectType } = req.body as {
      projectId: string;
      projectType: 'plugin' | 'mod';
    };
    const result = await installModrinthProject({
      serverId: id,
      projectId,
      projectType: projectType === 'mod' ? 'mod' : 'plugin',
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Modrinth install failed.' });
  }
});

// ==========================================
// INCUS VM & LXC ROUTES
// ==========================================
app.get('/api/incus/instances', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const instances = await syncIncusInstances({ id: req.user!.id, role: req.user!.role });
    res.json({ instances });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list instances.' });
  }
});

app.get('/api/incus/host-ipv4', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const force = req.query.refresh === '1';
    const ipv4 = await detectHostPublicIpv4(force);
    res.json({ ipv4 });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to detect host IPv4.' });
  }
});

app.get('/api/incus/ports/next-free', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const protocol = req.query.protocol === 'udp' ? 'udp' : 'tcp';
    const port = getNextFreeSharedPort(protocol);
    res.json({ port, protocol });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'No free ports available.' });
  }
});

app.post('/api/incus/instances', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { name, type, osTemplate, vcpu, ramMb, diskGb, rootPassword, ownerId, nodeId, operationId } =
    req.body as {
      name: string;
      type: 'container' | 'vm';
      osTemplate: string;
      vcpu: number;
      ramMb: number;
      diskGb: number;
      rootPassword: string;
      ownerId?: number;
      nodeId?: number;
      operationId?: string;
    };

  const opRoom =
    typeof operationId === 'string' && /^[a-zA-Z0-9_-]{4,64}$/.test(operationId)
      ? `op:${operationId}`
      : null;

  try {
    const isStaff = req.user!.role === 'owner' || req.user!.role === 'admin';
    const targetOwnerId = isStaff && ownerId ? Number(ownerId) : req.user!.id;
    const ownerRow = db
      .prepare('SELECT id, role FROM users WHERE id = ?')
      .get(targetOwnerId) as { id: number; role: UserRole } | undefined;

    if (!ownerRow) {
      res.status(400).json({ error: 'Target owner user does not exist.' });
      return;
    }

    const enforceQuota = req.user!.role === 'user' || ownerRow.role === 'user';

    const result = await createIncusInstance({
      name,
      type,
      osTemplate,
      vcpu,
      ramMb,
      diskGb,
      rootPassword,
      ownerId: ownerRow.id,
      nodeId,
      enforceQuota,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
      onProgress: opRoom
        ? (ev) => {
            ioRef?.to(opRoom).emit('incus:progress', { operationId, ...ev });
          }
        : undefined,
    });

    res.status(201).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create instance.';
    if (opRoom && operationId) {
      ioRef?.to(opRoom).emit('incus:progress', {
        operationId,
        step: 5,
        totalSteps: 5,
        label: 'Provisioning failed',
        status: 'error',
        detail: message,
      });
    }
    res.status(400).json({ error: message });
  }
});

app.put(
  '/api/incus/instances/:id/admin',
  requireAuth,
  requireRole('owner', 'admin'),
  (req: AuthenticatedRequest, res) => {
    const id = Number(req.params.id);
    const { ownerId, vcpu, ramMb, diskGb, isSuspended } = req.body as {
      ownerId?: number;
      vcpu?: number;
      ramMb?: number;
      diskGb?: number;
      isSuspended?: boolean;
    };

    const inst = db.prepare('SELECT id, instance_name FROM vm_instances WHERE id = ?').get(id) as
      | { id: number; instance_name: string }
      | undefined;
    if (!inst) {
      res.status(404).json({ error: 'Instance not found.' });
      return;
    }

    db.prepare(
      `UPDATE vm_instances SET
         owner_id = COALESCE(?, owner_id),
         vcpu = COALESCE(?, vcpu),
         ram_mb = COALESCE(?, ram_mb),
         disk_gb = COALESCE(?, disk_gb),
         is_suspended = COALESCE(?, is_suspended)
       WHERE id = ?`
    ).run(
      parseBoundedInt(ownerId, 1),
      parseBoundedInt(vcpu, 1),
      parseBoundedInt(ramMb, 256),
      parseBoundedInt(diskGb, 5),
      isSuspended !== undefined ? (isSuspended ? 1 : 0) : null,
      id
    );

    recordAuditLog({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'incus.admin_update',
      target: inst.instance_name,
      details: 'Updated instance limits/owner/suspension',
      ipAddress: getClientIp(req),
    });

    res.json({ updated: true });
  }
);

app.post('/api/incus/instances/:id/power', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const action = req.body?.action as 'start' | 'stop' | 'restart' | 'kill' | 'delete';
    if (!['start', 'stop', 'restart', 'kill', 'delete'].includes(action)) {
      res.status(400).json({ error: 'Invalid instance action.' });
      return;
    }

    if (action === 'delete') {
      unregisterInstanceSchedules(id);
    }

    const result = await controlIncusInstance({
      id,
      action,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.json(result);
  } catch (err) {
    res.status(getDaemonErrorStatus(err)).json({ error: err instanceof Error ? err.message : 'Instance action failed.' });
  }
});

app.post('/api/incus/instances/:id/rename', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const { newName, newHostname } = req.body as { newName?: string; newHostname?: string };
    const instance = await renameIncusInstance({
      id,
      newName: String(newName || ''),
      newHostname: typeof newHostname === 'string' ? newHostname : undefined,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.json({ instance });
  } catch (err) {
    res.status(getDaemonErrorStatus(err)).json({ error: err instanceof Error ? err.message : 'Rename failed.' });
  }
});

app.post('/api/incus/instances/:id/reinstall', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { osTemplate, rootPassword, operationId } = req.body as {
    osTemplate: string;
    rootPassword: string;
    operationId?: string;
  };
  const opRoom =
    typeof operationId === 'string' && /^[a-zA-Z0-9_-]{4,64}$/.test(operationId)
      ? `op:${operationId}`
      : null;

  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const result = await reinstallIncusInstance({
      id,
      osTemplate,
      rootPassword,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
      onProgress: opRoom
        ? (ev) => {
            ioRef?.to(opRoom).emit('incus:progress', { operationId, ...ev });
          }
        : undefined,
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OS reinstall failed.';
    if (opRoom && operationId) {
      ioRef?.to(opRoom).emit('incus:progress', {
        operationId,
        step: 5,
        totalSteps: 5,
        label: 'OS Reinstall failed',
        status: 'error',
        detail: message,
      });
    }
    res.status(getDaemonErrorStatus(err)).json({ error: message });
  }
});

app.get('/api/incus/instances/:id/metrics', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const metrics = await getIncusInstanceTelemetry(id);
    res.json(metrics);
  } catch (err) {
    res.status(getDaemonErrorStatus(err)).json({ error: err instanceof Error ? err.message : 'Failed to fetch metrics.' });
  }
});

// SSH Details, Root Password Reset, Authorized Keys & SSHX
app.get('/api/incus/instances/:id/ssh', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const details = await getIncusSshDetails(id);
    res.json(details);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to load SSH details.' });
  }
});

app.post('/api/incus/instances/:id/ssh/password', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const newPassword = String(req.body?.password || '');
    const result = await resetIncusRootPassword({
      id,
      newPassword,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Password reset failed.' });
  }
});

app.post('/api/incus/instances/:id/ssh/keys', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const { label, publicKey } = req.body as { label?: string; publicKey?: string };
    const result = await addVmSshKey({
      instanceId: id,
      label: String(label || ''),
      publicKey: String(publicKey || ''),
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to add SSH key.' });
  }
});

app.delete('/api/incus/instances/:id/ssh/keys/:keyId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const keyId = Number(req.params.keyId);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    await removeVmSshKey({
      instanceId: id,
      keyId,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.json({ deleted: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to delete SSH key.' });
  }
});

app.post('/api/incus/instances/:id/sshx', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const session = await launchIncusSshx({
      instanceId: id,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.json(session);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to launch sshx.' });
  }
});

app.delete('/api/incus/instances/:id/sshx', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  const access = canAccessIncusInstance(req.user!, id);
  if (!access.allowed) {
    res.status(403).json({ error: access.reason });
    return;
  }
  const stopped = stopIncusSshx(id);
  res.json({ stopped });
});

app.post('/api/incus/instances/:id/recipes', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const recipeId = String(req.body?.recipeId || '') as IncusRecipeId;
    const operationId = typeof req.body?.operationId === 'string' ? req.body.operationId : '';
    const opRoom = /^[a-zA-Z0-9_-]{4,64}$/.test(operationId) ? `op:${operationId}` : null;

    const result = await runIncusAppRecipe({
      instanceId: id,
      recipeId,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
      onOutput: opRoom
        ? (chunk) => {
            ioRef?.to(opRoom).emit('incus:recipe:output', { operationId, chunk });
          }
        : undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Recipe installation failed.' });
  }
});

// VPS File Manager Routes (incus file push/pull + exec)
app.get('/api/incus/instances/:id/files', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const dir = typeof req.query.path === 'string' ? req.query.path : '/root';
    const data = await listContainerFiles(id, dir);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to list VPS files.' });
  }
});

app.get('/api/incus/instances/:id/files/content', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    const data = await readContainerFile(id, filePath);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to read file.' });
  }
});

app.put('/api/incus/instances/:id/files/content', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const { path: filePath, content } = req.body as { path?: string; content?: string };
    if (typeof filePath !== 'string' || typeof content !== 'string') {
      res.status(400).json({ error: 'File path and content are required.' });
      return;
    }
    await writeContainerFile({
      instanceId: id,
      filePath,
      content,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.json({ saved: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save file.' });
  }
});

app.post('/api/incus/instances/:id/files/entry', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const { path: targetPath, type } = req.body as { path?: string; type?: 'file' | 'folder' };
    if (typeof targetPath !== 'string' || (type !== 'file' && type !== 'folder')) {
      res.status(400).json({ error: 'Valid path and entry type are required.' });
      return;
    }
    const createdPath = await createContainerEntry({
      instanceId: id,
      targetPath,
      type,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.status(201).json({ created: true, path: createdPath });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create entry.' });
  }
});

app.post('/api/incus/instances/:id/files/move', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const { sourcePath, destPath } = req.body as { sourcePath?: string; destPath?: string };
    await renameOrMoveContainerEntry({
      instanceId: id,
      sourcePath: String(sourcePath || ''),
      destPath: String(destPath || ''),
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.json({ moved: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Rename/move failed.' });
  }
});

app.post('/api/incus/instances/:id/files/chmod', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const { path: targetPath, mode } = req.body as { path?: string; mode?: string };
    await chmodContainerEntry({
      instanceId: id,
      targetPath: String(targetPath || ''),
      mode: String(mode || ''),
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.json({ updated: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to change permissions.' });
  }
});

app.delete('/api/incus/instances/:id/files/entry', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const targetPath = typeof req.query.path === 'string' ? req.query.path : '';
    await deleteContainerEntry({
      instanceId: id,
      targetPath,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.json({ deleted: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Delete failed.' });
  }
});

app.post(
  '/api/incus/instances/:id/files/upload',
  requireAuth,
  upload.array('files', 10),
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const access = canAccessIncusInstance(req.user!, id);
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      const targetDir = typeof req.body?.dir === 'string' ? req.body.dir : '/root';
      const files = (req.files as Express.Multer.File[]) || [];
      const uploaded = await uploadContainerFiles({
        instanceId: id,
        targetDir,
        files,
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json({ uploaded });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Upload failed.' });
    }
  }
);

app.get('/api/incus/instances/:id/files/download', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const targetPath = typeof req.query.path === 'string' ? req.query.path : '';
    const format = req.query.format === 'zip' ? 'zip' : 'tar.gz';
    const { filePath, filename, cleanupDir } = await prepareContainerDownload({
      instanceId: id,
      targetPath,
      archiveFormat: format,
    });
    res.download(filePath, filename, (err) => {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'File download failed.' });
      }
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Download failed.' });
    }
  }
});

app.get('/api/incus/instances/:id/snapshots', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const snapshots = await listInstanceSnapshots(id);
    res.json({ snapshots });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to list snapshots.' });
  }
});

app.post('/api/incus/instances/:id/snapshots', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const snapshotName = String(req.body?.snapshotName || '');
    await createInstanceSnapshot({
      id,
      snapshotName,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.status(201).json({ created: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create snapshot.' });
  }
});

app.post(
  '/api/incus/instances/:id/snapshots/:snapName/restore',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const access = canAccessIncusInstance(req.user!, id);
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      await restoreInstanceSnapshot({
        id,
        snapshotName: String(req.params.snapName),
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json({ restored: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to restore snapshot.' });
    }
  }
);

app.delete(
  '/api/incus/instances/:id/snapshots/:snapName',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const access = canAccessIncusInstance(req.user!, id);
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      await deleteInstanceSnapshot({
        id,
        snapshotName: String(req.params.snapName),
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json({ deleted: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to delete snapshot.' });
    }
  }
);

// Incus Unified Backups, Point-in-Time Restore & Automated Schedules
app.get('/api/incus/instances/:id/backups', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const backups = await listIncusBackupsAndSnapshots(id);
    res.json({ backups });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to list backups.' });
  }
});

app.post('/api/incus/instances/:id/backups', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const kind = req.body?.kind === 'archive' ? 'archive' : 'snapshot';
    const backup = await createIncusBackupOrSnapshot({
      instanceId: id,
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      kind,
      backupType: 'manual',
      createdBy: req.user!.username,
      userId: req.user!.id,
      ipAddress: getClientIp(req),
    });
    res.status(201).json({ backup });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create snapshot/backup.' });
  }
});

app.post(
  '/api/incus/instances/:id/backups/:backupId/restore',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const backupId = Number(req.params.backupId);
      const access = canAccessIncusInstance(req.user!, id);
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      const createPreRestore = req.body?.createPreRestore !== false;
      const result = await restoreIncusBackup({
        instanceId: id,
        backupId,
        createPreRestore,
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Restore failed.' });
    }
  }
);

app.post(
  '/api/incus/instances/:id/backups/:backupId/cloud',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const backupId = Number(req.params.backupId);
      const access = canAccessIncusInstance(req.user!, id);
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      const backup = await uploadIncusBackupToCloud({
        instanceId: id,
        backupId,
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json({ backup });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Cloud upload failed.' });
    }
  }
);

app.get(
  '/api/incus/instances/:id/backups/:backupId/download',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const backupId = Number(req.params.backupId);
      const access = canAccessIncusInstance(req.user!, id);
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      const { filePath, filename } = await getIncusBackupArchivePath(id, backupId);
      res.download(filePath, filename, (err) => {
        if (err && !res.headersSent) {
          res.status(500).json({ error: 'Backup archive download failed.' });
        }
      });
    } catch (err) {
      if (!res.headersSent) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Download failed.' });
      }
    }
  }
);

app.delete(
  '/api/incus/instances/:id/backups/:backupId',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const backupId = Number(req.params.backupId);
      const access = canAccessIncusInstance(req.user!, id);
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      await deleteIncusBackup({
        instanceId: id,
        backupId,
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json({ deleted: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Delete failed.' });
    }
  }
);

app.get('/api/incus/instances/:id/schedules', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  const access = canAccessIncusInstance(req.user!, id);
  if (!access.allowed) {
    res.status(403).json({ error: access.reason });
    return;
  }
  const schedules = db
    .prepare('SELECT * FROM incus_schedules WHERE instance_id = ? ORDER BY id DESC')
    .all(id);
  res.json({ schedules });
});

app.post('/api/incus/instances/:id/schedules', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  const access = canAccessIncusInstance(req.user!, id);
  if (!access.allowed) {
    res.status(403).json({ error: access.reason });
    return;
  }

  const { name, cronExpr, action = 'snapshot', retentionCount = 7 } = req.body as {
    name?: string;
    cronExpr?: string;
    action?: 'snapshot' | 'local_backup';
    retentionCount?: number;
  };

  const cleanName = sanitizeDisplayName(name);
  if (!cleanName) {
    res.status(400).json({ error: 'Schedule name is required.' });
    return;
  }
  if (!cronExpr || !cron.validate(cronExpr.trim())) {
    res.status(400).json({ error: 'Invalid cron expression (e.g. 0 3 * * *).' });
    return;
  }
  if (action !== 'snapshot' && action !== 'local_backup') {
    res.status(400).json({ error: 'Action must be snapshot or local_backup.' });
    return;
  }

  const cleanRetention = Math.min(50, Math.max(1, Number(retentionCount) || 7));
  const result = db
    .prepare(
      `INSERT INTO incus_schedules (instance_id, name, cron_expr, action, retention_count, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`
    )
    .run(id, cleanName, cronExpr.trim(), action, cleanRetention);

  const row = db
    .prepare('SELECT * FROM incus_schedules WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as IncusScheduleRow;
  registerIncusScheduleTask(row);

  recordAuditLog({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'incus.schedule_create',
    target: `instance#${id}`,
    details: `${cleanName} (${cronExpr.trim()} -> ${action}, keep ${cleanRetention})`,
    ipAddress: getClientIp(req),
  });

  res.status(201).json({ schedule: row });
});

app.patch(
  '/api/incus/instances/:id/schedules/:scheduleId',
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const id = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const enabled = req.body?.enabled ? 1 : 0;
    db.prepare('UPDATE incus_schedules SET enabled = ? WHERE id = ? AND instance_id = ?').run(
      enabled,
      scheduleId,
      id
    );
    const row = db
      .prepare('SELECT * FROM incus_schedules WHERE id = ? AND instance_id = ?')
      .get(scheduleId, id) as IncusScheduleRow | undefined;
    if (row) {
      if (enabled) registerIncusScheduleTask(row);
      else unregisterIncusScheduleTask(row.id);
    }
    res.json({ schedule: row });
  }
);

app.delete(
  '/api/incus/instances/:id/schedules/:scheduleId',
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const id = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    unregisterIncusScheduleTask(scheduleId);
    db.prepare('DELETE FROM incus_schedules WHERE id = ? AND instance_id = ?').run(scheduleId, id);
    res.json({ deleted: true });
  }
);

// Unified Backups & Snapshots Overview (RBAC-filtered)
app.get('/api/backups/summary', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const isStaff = req.user!.role === 'owner' || req.user!.role === 'admin';
    const servers = isStaff
      ? (db.prepare('SELECT id, name, container_name, status FROM minecraft_servers ORDER BY id DESC').all() as Array<{
          id: number;
          name: string;
          container_name: string;
          status: string;
        }>)
      : (db
          .prepare(
            `SELECT DISTINCT ms.id, ms.name, ms.container_name, ms.status
             FROM minecraft_servers ms
             LEFT JOIN server_subusers ss ON ss.server_id = ms.id
             WHERE ms.owner_id = ? OR ss.user_id = ?
             ORDER BY ms.id DESC`
          )
          .all(req.user!.id, req.user!.id) as Array<{
          id: number;
          name: string;
          container_name: string;
          status: string;
        }>);

    const instances = isStaff
      ? (db
          .prepare('SELECT id, name, instance_name, type, status FROM vm_instances ORDER BY id DESC')
          .all() as Array<{
          id: number;
          name: string;
          instance_name: string;
          type: 'container' | 'vm';
          status: string;
        }>)
      : (db
          .prepare(
            'SELECT id, name, instance_name, type, status FROM vm_instances WHERE owner_id = ? ORDER BY id DESC'
          )
          .all(req.user!.id) as Array<{
          id: number;
          name: string;
          instance_name: string;
          type: 'container' | 'vm';
          status: string;
        }>);

    const mcBackups = servers.flatMap((srv) =>
      listMinecraftBackups(srv.id).map((b) => ({
        ...b,
        server_name: srv.name,
        container_name: srv.container_name,
      }))
    );

    const incusBackupsNested = await Promise.all(
      instances.map(async (inst) => {
        const list = await listIncusBackupsAndSnapshots(inst.id);
        return list.map((b) => ({
          ...b,
          instance_display_name: inst.name,
          instance_name: inst.instance_name,
          instance_type: inst.type,
        }));
      })
    );
    const incusBackups = incusBackupsNested.flat();

    const mcServerIds = servers.map((s) => s.id);
    const mcSchedules =
      mcServerIds.length > 0
        ? db
            .prepare(
              `SELECT ms.*, s.name AS server_name
               FROM minecraft_schedules ms
               JOIN minecraft_servers s ON s.id = ms.server_id
               WHERE ms.action = 'backup' AND ms.server_id IN (${mcServerIds.map(() => '?').join(',')})
               ORDER BY ms.id DESC`
            )
            .all(...mcServerIds)
        : [];

    const instIds = instances.map((i) => i.id);
    const incusSchedules =
      instIds.length > 0
        ? db
            .prepare(
              `SELECT isch.*, vi.name AS instance_display_name, vi.type AS instance_type
               FROM incus_schedules isch
               JOIN vm_instances vi ON vi.id = isch.instance_id
               WHERE isch.instance_id IN (${instIds.map(() => '?').join(',')})
               ORDER BY isch.id DESC`
            )
            .all(...instIds)
        : [];

    res.json({ mcBackups, incusBackups, mcSchedules, incusSchedules });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load backup summary.' });
  }
});

app.get('/api/incus/instances/:id/ports', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  const access = canAccessIncusInstance(req.user!, id);
  if (!access.allowed) {
    res.status(403).json({ error: access.reason });
    return;
  }
  const ports = listPortAllocations('incus', id);
  res.json({ ports });
});

app.post('/api/incus/instances/:id/ports', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const { hostPort, targetPort, protocol } = req.body as {
      hostPort: number;
      targetPort: number;
      protocol: 'tcp' | 'udp';
    };
    const allocation = await addIncusPortForward({
      id,
      hostPort,
      targetPort,
      protocol,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.status(201).json({ allocation });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to add port rule.' });
  }
});

app.delete(
  '/api/incus/instances/:id/ports/:allocId',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const access = canAccessIncusInstance(req.user!, id);
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      await removeIncusPortForward({
        id,
        allocationId: Number(req.params.allocId),
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json({ deleted: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to remove port rule.' });
    }
  }
);

// Incus Reverse Proxy / Subdomain Router
app.get('/api/incus/instances/:id/proxies', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  const access = canAccessIncusInstance(req.user!, id);
  if (!access.allowed) {
    res.status(403).json({ error: access.reason });
    return;
  }
  const proxies = listReverseProxies(id);
  res.json({ proxies });
});

app.post('/api/incus/instances/:id/proxies', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = Number(req.params.id);
    const access = canAccessIncusInstance(req.user!, id);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason });
      return;
    }
    const { domain, targetPort, sslEnabled = true, engine = 'caddy' } = req.body as {
      domain: string;
      targetPort: number;
      sslEnabled?: boolean;
      engine?: 'caddy' | 'nginx';
    };
    const proxy = await createReverseProxy({
      instanceId: id,
      domain,
      targetPort,
      sslEnabled,
      engine,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });
    res.status(201).json({ proxy });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create reverse proxy.' });
  }
});

app.delete(
  '/api/incus/instances/:id/proxies/:proxyId',
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    try {
      const id = Number(req.params.id);
      const access = canAccessIncusInstance(req.user!, id);
      if (!access.allowed) {
        res.status(403).json({ error: access.reason });
        return;
      }
      deleteReverseProxy({
        instanceId: id,
        proxyId: Number(req.params.proxyId),
        userId: req.user!.id,
        username: req.user!.username,
        ipAddress: getClientIp(req),
      });
      res.json({ deleted: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to remove proxy rule.' });
    }
  }
);

// ==========================================
// AI AGENT ROUTES (MINECRAFT & VPS SYSADMIN)
// ==========================================
app.get('/api/ai/status', requireAuth, (_req, res) => {
  const cfg = resolveOpenAiConfig();
  res.json({
    configured: Boolean(cfg.apiKey),
    model: cfg.model,
    source: cfg.source,
  });
});

app.get('/api/ai/:agentType/:resourceId/history', requireAuth, (req: AuthenticatedRequest, res) => {
  const agentType = req.params.agentType as AiAgentType;
  const resourceId = Number(req.params.resourceId);
  if (agentType !== 'minecraft' && agentType !== 'vps') {
    res.status(400).json({ error: 'Invalid AI agent type.' });
    return;
  }
  if (!Number.isInteger(resourceId) || resourceId <= 0) {
    res.status(400).json({ error: 'Invalid resource ID.' });
    return;
  }

  const access =
    agentType === 'minecraft'
      ? canAccessMinecraftServer(req.user!, resourceId)
      : canAccessIncusInstance(req.user!, resourceId);
  if (!access.allowed) {
    res.status(403).json({ error: access.reason });
    return;
  }

  const messages = listAiChatHistory({
    agentType,
    resourceId,
    userId: req.user!.id,
  });
  const cfg = resolveOpenAiConfig();
  res.json({
    messages,
    configured: Boolean(cfg.apiKey),
    model: cfg.model,
  });
});

app.delete('/api/ai/:agentType/:resourceId/history', requireAuth, (req: AuthenticatedRequest, res) => {
  const agentType = req.params.agentType as AiAgentType;
  const resourceId = Number(req.params.resourceId);
  if (agentType !== 'minecraft' && agentType !== 'vps') {
    res.status(400).json({ error: 'Invalid AI agent type.' });
    return;
  }
  if (!Number.isInteger(resourceId) || resourceId <= 0) {
    res.status(400).json({ error: 'Invalid resource ID.' });
    return;
  }

  const access =
    agentType === 'minecraft'
      ? canAccessMinecraftServer(req.user!, resourceId)
      : canAccessIncusInstance(req.user!, resourceId);
  if (!access.allowed) {
    res.status(403).json({ error: access.reason });
    return;
  }

  clearAiChatHistory({
    agentType,
    resourceId,
    userId: req.user!.id,
  });
  res.json({ cleared: true });
});

app.post('/api/ai/:agentType/:resourceId/chat', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const agentType = req.params.agentType as AiAgentType;
    const resourceId = Number(req.params.resourceId);
    if (agentType !== 'minecraft' && agentType !== 'vps') {
      res.status(400).json({ error: 'Invalid AI agent type.' });
      return;
    }
    if (!Number.isInteger(resourceId) || resourceId <= 0) {
      res.status(400).json({ error: 'Invalid resource ID.' });
      return;
    }

    const { message, confirmationMode = 'ask', analyzeLogs = false } = (req.body || {}) as {
      message?: string;
      confirmationMode?: AiConfirmationMode;
      analyzeLogs?: boolean;
    };
    const mode: AiConfirmationMode = confirmationMode === 'auto' ? 'auto' : 'ask';

    const result = await runAgentChat({
      agentType,
      resourceId,
      user: req.user!,
      message: String(message || ''),
      confirmationMode: mode,
      analyzeLogs: Boolean(analyzeLogs),
      ipAddress: getClientIp(req),
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'AI agent request failed.' });
  }
});

app.post(
  '/api/ai/:agentType/:resourceId/actions/:messageId/:actionId',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const agentType = req.params.agentType as AiAgentType;
      const resourceId = Number(req.params.resourceId);
      const messageId = Number(req.params.messageId);
      const actionId = String(req.params.actionId || '');
      if (agentType !== 'minecraft' && agentType !== 'vps') {
        res.status(400).json({ error: 'Invalid AI agent type.' });
        return;
      }
      if (!Number.isInteger(resourceId) || !Number.isInteger(messageId) || !actionId) {
        res.status(400).json({ error: 'Invalid action reference.' });
        return;
      }

      const { decision } = (req.body || {}) as { decision?: string };
      if (decision !== 'approve' && decision !== 'reject') {
        res.status(400).json({ error: 'decision must be approve or reject.' });
        return;
      }

      const updatedMessage = await resolvePendingAiAction({
        agentType,
        resourceId,
        messageId,
        actionId,
        decision,
        user: req.user!,
        ipAddress: getClientIp(req),
      });

      res.json({ message: updatedMessage });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Action resolution failed.' });
    }
  }
);

// ==========================================
// HTTP SERVER, SOCKET.IO & VITE / STATIC SETUP
// ==========================================
async function startServer() {
  initializeAllSchedules();

  const httpServer = http.createServer(app);

  const io = new SocketIOServer(httpServer, {
    path: '/socket.io',
    cors: { origin: false },
  });
  ioRef = io;

  io.use((socket, next) => {
    const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
    const user = verifyToken(token);
    if (!user) {
      next(new Error('Unauthorized'));
      return;
    }
    socket.data.user = user;
    next();
  });

  const nodeAgentNs = io.of('/node-agent');
  nodeAgentNs.use((socket, next) => {
    const nodeToken =
      typeof socket.handshake.auth?.nodeToken === 'string' ? socket.handshake.auth.nodeToken : '';
    const node = verifyNodeToken(nodeToken);
    if (!node) {
      next(new Error('Invalid node agent token'));
      return;
    }
    socket.data.nodeId = node.id;
    socket.data.nodeName = node.name;
    next();
  });

  nodeAgentNs.on('connection', (socket) => {
    const nodeId = Number(socket.data.nodeId);
    registerNodeSocket(nodeId, socket);
    io.emit('nodes:update', listNodesWithCounts());

    socket.on(
      'node:metrics',
      (metrics: { cpuPercent?: number; ramPercent?: number; diskPercent?: number; activeServers?: number }) => {
        updateNodeTelemetry(nodeId, metrics || {});
        io.emit('nodes:update', listNodesWithCounts());
      }
    );

    socket.on('disconnect', () => {
      markNodeOffline(nodeId, socket.id);
      io.emit('nodes:update', listNodesWithCounts());
    });
  });

  setInterval(() => {
    const stats = collectSystemStats();
    syncPrimaryNodeMetrics(stats);
    if (io.engine.clientsCount > 0) {
      io.emit('system:stats', stats);
    }
  }, 2000);

  io.on('connection', (socket) => {
    socket.emit('system:stats', collectSystemStats());

    let logStream: NodeJS.ReadableStream | null = null;
    let shellProc: ReturnType<typeof spawn> | null = null;
    let shellPty: { write: (data: string) => void; resize: (cols: number, rows: number) => void; kill: () => void } | null = null;
    let metricsTimer: ReturnType<typeof setInterval> | null = null;

    const cleanupLogStream = () => {
      if (logStream) {
        try {
          (logStream as unknown as { destroy?: () => void }).destroy?.();
        } catch {
          // ignore
        }
        logStream = null;
      }
    };

    const cleanupShellProc = () => {
      if (shellPty) {
        try {
          shellPty.kill();
        } catch {
          // ignore
        }
        shellPty = null;
      }
      if (shellProc) {
        try {
          shellProc.kill('SIGTERM');
        } catch {
          // ignore
        }
        shellProc = null;
      }
    };

    const cleanupMetricsTimer = () => {
      if (metricsTimer) {
        clearInterval(metricsTimer);
        metricsTimer = null;
      }
    };

    socket.on('incus:op:subscribe', (payload: { operationId?: string }) => {
      const opId = typeof payload?.operationId === 'string' ? payload.operationId.trim() : '';
      if (/^[a-zA-Z0-9_-]{4,64}$/.test(opId)) {
        void socket.join(`op:${opId}`);
      }
    });

    socket.on('incus:metrics:subscribe', async (payload: { instanceId?: number }) => {
      cleanupMetricsTimer();
      const instanceId = Number(payload?.instanceId);
      const access = canAccessIncusInstance(socket.data.user, instanceId);
      if (!access.allowed) return;

      const pushTelemetry = async () => {
        try {
          const telemetry = await getIncusInstanceTelemetry(instanceId);
          socket.emit('incus:metrics:data', telemetry);
        } catch {
          // ignore transient poll errors
        }
      };

      void pushTelemetry();
      metricsTimer = setInterval(() => {
        void pushTelemetry();
      }, 1500);
    });

    socket.on('incus:metrics:unsubscribe', () => {
      cleanupMetricsTimer();
    });

    socket.on('mc:attach', async (payload: { serverId?: number }) => {
      cleanupLogStream();
      const serverId = Number(payload?.serverId);
      const access = canAccessMinecraftServer(socket.data.user, serverId, 'can_use_console');
      if (!access.allowed) {
        socket.emit('mc:console:data', `\x1b[31m[Access Denied] ${access.reason}\x1b[0m\r\n`);
        return;
      }

      const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(serverId) as
        | MinecraftServerRow
        | undefined;
      if (!srv) {
        socket.emit('mc:console:data', '\x1b[31m[Error] Minecraft server not found.\x1b[0m\r\n');
        return;
      }

      const dockerUp = await isDockerReady();
      if (!dockerUp) {
        socket.emit(
          'mc:console:data',
          `\x1b[35m[FB BAHI Panel]\x1b[0m Server workspace: \x1b[36m${srv.data_dir}\x1b[0m\r\n` +
            `\x1b[33m[Notice]\x1b[0m Docker daemon (/var/run/docker.sock) is not running on this host.\r\n` +
            `Deploy on Ubuntu 22.04/24.04 or Debian VPS via \x1b[36minstall.sh\x1b[0m to stream live \x1b[32mitzg/minecraft-server\x1b[0m console output.\r\n`
        );
        return;
      }

      try {
        const container = docker.getContainer(srv.container_name);
        const stream = (await container.logs({
          follow: true,
          stdout: true,
          stderr: true,
          tail: 120,
        })) as unknown as NodeJS.ReadableStream;

        logStream = stream;
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8').replace(/[\x00-\x08\x0b-\x1a]/g, '');
          socket.emit('mc:console:data', text.replace(/\n/g, '\r\n'));
        });
        stream.on('error', (err: Error) => {
          socket.emit('mc:console:data', `\r\n\x1b[31m[Stream Error] ${err.message}\x1b[0m\r\n`);
        });
      } catch (err) {
        socket.emit(
          'mc:console:data',
          `\x1b[31m[Docker Attach Error] ${err instanceof Error ? err.message : 'Unable to attach'}\x1b[0m\r\n`
        );
      }
    });

    socket.on('mc:detach', () => {
      cleanupLogStream();
    });

    socket.on('mc:command', async (payload: { serverId?: number; command?: string }) => {
      try {
        const serverId = Number(payload?.serverId);
        const access = canAccessMinecraftServer(socket.data.user, serverId, 'can_use_console');
        if (!access.allowed) {
          socket.emit('mc:console:data', `\x1b[31m[Access Denied] ${access.reason}\x1b[0m\r\n`);
          return;
        }
        const command = String(payload?.command || '').trim();
        if (!command) return;
        const out = await sendMinecraftCommand(serverId, command);
        socket.emit('mc:console:data', `\x1b[35m> ${command}\x1b[0m\r\n`);
        if (out) {
          socket.emit('mc:console:data', `${out.replace(/\n/g, '\r\n')}\r\n`);
        }
      } catch (err) {
        socket.emit(
          'mc:console:data',
          `\x1b[31m[Command Error] ${err instanceof Error ? err.message : 'Failed'}\x1b[0m\r\n`
        );
      }
    });

    socket.on(
      'incus:shell:start',
      async (payload: { instanceId?: number; cols?: number; rows?: number; rescue?: boolean }) => {
        cleanupShellProc();
        const instanceId = Number(payload?.instanceId);
        const access = canAccessIncusInstance(socket.data.user, instanceId);
        if (!access.allowed) {
          socket.emit('incus:shell:data', `\x1b[31m[Access Denied] ${access.reason}\x1b[0m\r\n`);
          return;
        }

        const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(instanceId) as
          | VmInstanceRow
          | undefined;
        if (!inst) {
          socket.emit('incus:shell:data', '\x1b[31m[Error] Instance not found.\x1b[0m\r\n');
          return;
        }

        const incusUp = await isIncusReady();
        if (!incusUp) {
          socket.emit(
            'incus:shell:data',
            `\x1b[35m[FB BAHI Web Console]\x1b[0m Instance: \x1b[36m${inst.instance_name}\x1b[0m (${inst.os_template})\r\n` +
              `\x1b[33m[Notice]\x1b[0m Incus CLI/daemon is not available on this host.\r\n` +
              `Run \x1b[36msudo bash install.sh\x1b[0m on Ubuntu/Debian VPS to attach a live node-pty root shell.\r\n`
          );
          return;
        }

        const cols = Math.min(240, Math.max(20, Number(payload?.cols) || 100));
        const rows = Math.min(80, Math.max(10, Number(payload?.rows) || 28));
        const isRescue = Boolean(payload?.rescue);

        const execScript = isRescue
          ? 'export TERM=xterm-256color; echo "[RESCUE SHELL] Root emergency shell active on $(hostname)"; exec /bin/sh -i'
          : 'export TERM=xterm-256color; command -v bash >/dev/null && exec bash -i || exec sh -i';

        const args = ['exec', inst.instance_name, '--', '/bin/sh', '-c', execScript];

        try {
          const ptyMod = await import('node-pty');
          const ptySpawn = ptyMod.spawn || ptyMod.default?.spawn;
          if (typeof ptySpawn === 'function') {
            const term = ptySpawn('incus', args, {
              name: 'xterm-256color',
              cols,
              rows,
              env: { ...process.env, TERM: 'xterm-256color' },
            });
            shellPty = term;
            term.onData((chunk) => {
              socket.emit('incus:shell:data', chunk);
            });
            term.onExit(({ exitCode }) => {
              socket.emit(
                'incus:shell:data',
                `\r\n\x1b[33m[PTY Shell exited with code ${exitCode}]\x1b[0m\r\n`
              );
            });
            return;
          }
        } catch {
          // Fallback cleanly to standard child_process spawn if native pty fails
        }

        const proc = spawn('incus', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        shellProc = proc;
        proc.on('error', (err) => {
          socket.emit('incus:shell:data', `\r\n\x1b[31m[Shell Spawn Error] ${err.message}\x1b[0m\r\n`);
        });
        proc.stdout?.on('data', (chunk: Buffer) => {
          socket.emit('incus:shell:data', chunk.toString('utf8').replace(/\n/g, '\r\n'));
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
          socket.emit('incus:shell:data', chunk.toString('utf8').replace(/\n/g, '\r\n'));
        });
        proc.on('close', (code) => {
          socket.emit(
            'incus:shell:data',
            `\r\n\x1b[33m[Shell exited with code ${code ?? 0}]\x1b[0m\r\n`
          );
        });
      }
    );

    socket.on('incus:shell:stop', () => {
      cleanupShellProc();
    });

    socket.on('incus:shell:resize', (payload: { cols?: number; rows?: number }) => {
      if (!shellPty) return;
      const cols = Math.min(240, Math.max(20, Number(payload?.cols) || 100));
      const rows = Math.min(80, Math.max(10, Number(payload?.rows) || 28));
      try {
        shellPty.resize(cols, rows);
      } catch {
        // ignore invalid resize
      }
    });

    socket.on('incus:shell:input', (data: string) => {
      if (typeof data !== 'string') return;
      if (shellPty) {
        shellPty.write(data);
      } else if (shellProc && shellProc.stdin && !shellProc.stdin.destroyed) {
        shellProc.stdin.write(data);
      }
    });

    socket.on('incus:shell:macro', (payload: { macro?: string }) => {
      const macros: Record<string, string> = {
        update:
          'if command -v apt-get >/dev/null; then apt-get update && apt-get upgrade -y; elif command -v dnf >/dev/null; then dnf upgrade -y; elif command -v apk >/dev/null; then apk update && apk upgrade; fi\r',
        docker: 'curl -fsSL https://get.docker.com | sh\r',
        htop: 'command -v htop >/dev/null && htop || top\r',
      };
      const cmd = macros[String(payload?.macro || '')];
      if (!cmd) return;
      if (shellPty) {
        shellPty.write(cmd);
      } else if (shellProc && shellProc.stdin && !shellProc.stdin.destroyed) {
        shellProc.stdin.write(cmd);
      }
    });

    socket.on('disconnect', () => {
      cleanupLogStream();
      cleanupShellProc();
      cleanupMetricsTimer();
    });
  });

  // Global Express error handler (Multer / JSON parse / unexpected route errors)
  app.use(
    (
      err: Error & { status?: number; code?: string },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      if (err instanceof multer.MulterError) {
        const msg =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Uploaded file exceeds the maximum allowed size limit.'
            : `Upload error: ${err.message}`;
        res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: msg });
        return;
      }
      const status = typeof err.status === 'number' && err.status >= 400 ? err.status : 500;
      res.status(status).json({ error: err.message || 'Internal server error.' });
    }
  );

  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[FB BAHI Panel] Port ${PORT} is already in use. Stop the conflicting process or set a different PORT in .env.`
      );
      process.exit(1);
    }
    if (err.code === 'EACCES') {
      console.error(`[FB BAHI Panel] Permission denied binding to port ${PORT}.`);
      process.exit(1);
    }
    console.error('[FB BAHI Panel] HTTP server error:', err);
    process.exit(1);
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`FB BAHI Panel listening on http://0.0.0.0:${PORT}`);
  });

  const gracefulShutdown = (signal: string) => {
    console.log(`[FB BAHI Panel] Received ${signal}. Shutting down cleanly...`);
    io.close();
    httpServer.close(() => {
      try {
        db.close();
      } catch {
        // ignore if already closed
      }
      process.exit(0);
    });
    setTimeout(() => {
      try {
        db.close();
      } catch {
        // ignore
      }
      process.exit(0);
    }, 5000).unref();
  };

  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
}

void startServer().catch((err) => {
  console.error('[FB BAHI Panel] Fatal startup error:', err);
  process.exit(1);
});
