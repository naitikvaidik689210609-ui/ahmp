import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { db, getAllSettings, recordAuditLog } from '../db.js';
import {
  type AuthUserPayload,
  canAccessIncusInstance,
  canAccessMinecraftServer,
  CONTAINER_NAME_REGEX,
  decryptSecret,
  isValidPort,
  resolveConfinedPath,
  sanitizeContainerFilePath,
} from '../security.js';
import {
  controlMinecraftServer,
  getMinecraftLogs,
  getMinecraftPlayers,
  installModrinthProject,
  type MinecraftServerRow,
  searchModrinthProjects,
  sendMinecraftCommand,
  writeServerFile,
} from './dockerController.js';
import {
  addIncusPortForward,
  detectHostPublicIpv4,
  getIncusInstanceTelemetry,
  getNextFreeSharedPort,
  isIncusReady,
  listPortAllocations,
  runIncusAppRecipe,
  type VmInstanceRow,
} from './incusController.js';
import {
  deleteContainerEntry,
  readContainerFile,
  writeContainerFile,
} from './incusFilesController.js';

export type AiAgentType = 'minecraft' | 'vps';
export type AiConfirmationMode = 'ask' | 'auto';

export interface AiToolAction {
  id: string;
  toolName: string;
  title: string;
  description: string;
  args: Record<string, unknown>;
  status: 'pending' | 'executed' | 'rejected' | 'failed';
  riskLevel: 'safe' | 'high';
  summary?: string;
  output?: string;
  error?: string;
  executedAt?: string;
}

export interface AiChatMessage {
  id: number;
  agent_type: AiAgentType;
  resource_id: number;
  user_id: number;
  role: 'user' | 'assistant';
  content: string;
  tool_actions: AiToolAction[];
  pending_actions: AiToolAction[];
  model: string;
  created_at: string;
}

interface RawAiChatRow {
  id: number;
  agent_type: AiAgentType;
  resource_id: number;
  user_id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tool_actions: string;
  pending_actions: string;
  model: string;
  created_at: string;
}

export const ALLOWED_OPENAI_MODEL_REGEX = /^[a-zA-Z0-9._:-]{2,64}$/;

const ALLOWED_MC_TEXT_EXTS = new Set([
  '.properties',
  '.yml',
  '.yaml',
  '.json',
  '.txt',
  '.toml',
  '.conf',
  '.cfg',
  '.sk',
  '.mcmeta',
  '.log',
]);

const PROTECTED_VPS_PATHS = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/usr/bin',
  '/usr/lib',
  '/usr/sbin',
  '/var',
]);

const CATASTROPHIC_SHELL_PATTERNS: RegExp[] = [
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(\*|\s|$)/i,
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/(\*|\s|$)/i,
  /\brm\s+--no-preserve-root\b/i,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bdd\b[^\n]*\bof=\/dev\/(sd|vd|nvme|hd|xvd|mmcblk)/i,
  />\s*\/dev\/(sd|vd|nvme|hd|xvd)/i,
  /\/proc\/sysrq-trigger/i,
];

const HIGH_RISK_SHELL_PATTERNS: RegExp[] = [
  /\b(rm|rmdir|unlink|shred)\b/i,
  /\b(shutdown|reboot|poweroff|halt|init\s+0|init\s+6)\b/i,
  /\b(fdisk|parted|wipefs|lvremove|vgremove|pvremove)\b/i,
  /\bsystemctl\s+(stop|disable|mask|kill)\b/i,
  /\b(ufw\s+disable|iptables\s+-F|nft\s+flush)\b/i,
  /\bkill\s+-9\b/i,
  /\b(chmod|chown)\s+-R\b/i,
  /\bpasswd\b/i,
];

export function resolveOpenAiConfig(): {
  apiKey: string;
  model: string;
  source: 'owner_settings' | 'env' | 'none';
} {
  const settings = getAllSettings();
  const decryptedDbKey = decryptSecret(settings.openai_api_key_enc || '').trim();
  const envKeyRaw = (process.env.OPENAI_API_KEY || '').trim();
  const envKey = envKeyRaw && envKeyRaw !== 'MY_OPENAI_API_KEY' ? envKeyRaw : '';

  const modelCandidate = (settings.openai_model || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const model = ALLOWED_OPENAI_MODEL_REGEX.test(modelCandidate) ? modelCandidate : 'gpt-4o-mini';

  if (decryptedDbKey) {
    return { apiKey: decryptedDbKey, model, source: 'owner_settings' };
  }
  if (envKey) {
    return { apiKey: envKey, model, source: 'env' };
  }
  return { apiKey: '', model, source: 'none' };
}

function formatOpenAiError(err: unknown): Error {
  const anyErr = err as {
    status?: number;
    code?: string;
    name?: string;
    message?: string;
  };
  const status = anyErr?.status;
  const code = anyErr?.code || '';
  const name = anyErr?.name || '';
  const msg = anyErr?.message || (err instanceof Error ? err.message : 'OpenAI API request failed.');

  if (status === 401 || code === 'invalid_api_key') {
    return new Error('Invalid or expired OpenAI API key. Verify OPENAI_API_KEY in Owner Settings or .env.');
  }
  if (status === 429 || code === 'insufficient_quota' || code === 'rate_limit_exceeded') {
    return new Error('OpenAI rate limit or billing quota exceeded. Check usage limits on platform.openai.com.');
  }
  if (status === 404 || code === 'model_not_found') {
    return new Error('Selected OpenAI model is unavailable for this API key. Choose another model in Settings.');
  }
  if (
    name === 'AbortError' ||
    name === 'APIConnectionTimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    msg.toLowerCase().includes('timeout')
  ) {
    return new Error('OpenAI API request timed out or could not reach api.openai.com. Please try again.');
  }
  return new Error(`OpenAI API error: ${msg}`);
}

export async function testOpenAiConnection(params?: {
  apiKey?: string;
  model?: string;
}): Promise<{ ok: boolean; model: string; source: string; latencyMs: number; message: string }> {
  const current = resolveOpenAiConfig();
  const candidateKey =
    params?.apiKey && params.apiKey !== '********' ? params.apiKey.trim() : current.apiKey;
  const candidateModel =
    params?.model && ALLOWED_OPENAI_MODEL_REGEX.test(params.model.trim())
      ? params.model.trim()
      : current.model;

  if (!candidateKey) {
    throw new Error('No OpenAI API key configured. Enter an API key or set OPENAI_API_KEY in .env.');
  }

  const client = new OpenAI({ apiKey: candidateKey, timeout: 15000 });
  const started = Date.now();
  try {
    await client.models.retrieve(candidateModel);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 429) {
      throw formatOpenAiError(err);
    }
    try {
      await client.chat.completions.create({
        model: candidateModel,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }],
      });
    } catch (innerErr) {
      throw formatOpenAiError(innerErr);
    }
  }
  const latencyMs = Date.now() - started;

  return {
    ok: true,
    model: candidateModel,
    source: params?.apiKey && params.apiKey !== '********' ? 'input' : current.source,
    latencyMs,
    message: `OpenAI API verified with model ${candidateModel} (${latencyMs}ms).`,
  };
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function rowToAiMessage(row: RawAiChatRow): AiChatMessage {
  return {
    id: row.id,
    agent_type: row.agent_type,
    resource_id: row.resource_id,
    user_id: row.user_id,
    role: row.role === 'user' ? 'user' : 'assistant',
    content: row.content,
    tool_actions: parseJsonArray<AiToolAction>(row.tool_actions),
    pending_actions: parseJsonArray<AiToolAction>(row.pending_actions),
    model: row.model,
    created_at: row.created_at,
  };
}

export function listAiChatHistory(params: {
  agentType: AiAgentType;
  resourceId: number;
  userId: number;
  limit?: number;
}): AiChatMessage[] {
  const limit = Math.min(Math.max(params.limit || 60, 1), 200);
  const rows = db
    .prepare(
      `SELECT * FROM ai_chat_history
       WHERE agent_type = ? AND resource_id = ? AND user_id = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(params.agentType, params.resourceId, params.userId, limit) as RawAiChatRow[];
  return rows.reverse().map(rowToAiMessage);
}

export function clearAiChatHistory(params: {
  agentType: AiAgentType;
  resourceId: number;
  userId: number;
}): void {
  db.prepare(
    `DELETE FROM ai_chat_history WHERE agent_type = ? AND resource_id = ? AND user_id = ?`
  ).run(params.agentType, params.resourceId, params.userId);
}

function insertAiMessage(params: {
  agentType: AiAgentType;
  resourceId: number;
  userId: number;
  role: 'user' | 'assistant';
  content: string;
  toolActions?: AiToolAction[];
  pendingActions?: AiToolAction[];
  model?: string;
}): AiChatMessage {
  const res = db
    .prepare(
      `INSERT INTO ai_chat_history
       (agent_type, resource_id, user_id, role, content, tool_actions, pending_actions, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.agentType,
      params.resourceId,
      params.userId,
      params.role,
      params.content,
      JSON.stringify(params.toolActions || []),
      JSON.stringify(params.pendingActions || []),
      params.model || ''
    );

  const row = db
    .prepare('SELECT * FROM ai_chat_history WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as RawAiChatRow;
  return rowToAiMessage(row);
}

function listInstalledAddons(dataDir: string): { plugins: string[]; mods: string[] } {
  const readDirJars = (sub: string): string[] => {
    try {
      const target = resolveConfinedPath(dataDir, sub);
      if (!fs.existsSync(target)) return [];
      return fs
        .readdirSync(target, { withFileTypes: true })
        .filter((d) => !d.isDirectory() && (d.name.endsWith('.jar') || d.name.endsWith('.sk')))
        .map((d) => d.name)
        .slice(0, 60);
    } catch {
      return [];
    }
  };
  return {
    plugins: readDirJars('plugins'),
    mods: readDirJars('mods'),
  };
}

function sanitizeMcRelativePath(rawPath: string): string {
  const cleaned = (rawPath || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!cleaned || cleaned.includes('\0') || cleaned.split('/').includes('..')) {
    throw new Error('Invalid Minecraft file path.');
  }
  const ext = path.posix.extname(cleaned).toLowerCase();
  if (!ALLOWED_MC_TEXT_EXTS.has(ext)) {
    throw new Error(
      `Editing '${cleaned}' is blocked. Allowed text/config extensions: ${Array.from(ALLOWED_MC_TEXT_EXTS).join(', ')}`
    );
  }
  return cleaned;
}

function applyPropertiesOrYamlChanges(
  existing: string,
  relPath: string,
  changes: Record<string, string | number | boolean>
): string {
  const ext = path.posix.extname(relPath).toLowerCase();
  if (ext === '.properties') {
    const lines = existing ? existing.split(/\r?\n/) : [];
    const seen = new Set<string>();
    const nextLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return line;
      const key = line.slice(0, eqIdx).trim();
      if (Object.prototype.hasOwnProperty.call(changes, key)) {
        seen.add(key);
        return `${key}=${String(changes[key])}`;
      }
      return line;
    });
    for (const [k, v] of Object.entries(changes)) {
      if (!seen.has(k)) {
        nextLines.push(`${k}=${String(v)}`);
      }
    }
    return nextLines.join('\n').replace(/\n*$/, '\n');
  }

  // Safe line-aware YAML key updater for standard top-level / leaf keys
  let lines = existing ? existing.split(/\r?\n/) : [];
  for (const [rawKey, rawVal] of Object.entries(changes)) {
    const leafKey = rawKey.includes('.') ? rawKey.split('.').pop()! : rawKey;
    const escaped = leafKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^(\\s*)${escaped}:\\s*(.*)$`);
    const formattedVal =
      typeof rawVal === 'string' && /[:#{}[\],&*?|<>=!%@`]/.test(rawVal)
        ? JSON.stringify(rawVal)
        : String(rawVal);

    let replaced = false;
    lines = lines.map((line) => {
      if (replaced || line.trim().startsWith('#')) return line;
      const match = line.match(regex);
      if (match) {
        replaced = true;
        return `${match[1]}${leafKey}: ${formattedVal}`;
      }
      return line;
    });
    if (!replaced && !rawKey.includes('.')) {
      lines.push(`${leafKey}: ${formattedVal}`);
    } else if (!replaced && rawKey.includes('.')) {
      lines.push(`# AI requested ${rawKey}: ${formattedVal}`);
      lines.push(`${rawKey.replace(/\./g, '_')}: ${formattedVal}`);
    }
  }
  return lines.join('\n').replace(/\n*$/, '\n');
}

async function execIncusCommand(
  instanceName: string,
  command: string,
  timeoutMs = 60000
): Promise<{ exitCode: number; output: string }> {
  if (!CONTAINER_NAME_REGEX.test(instanceName)) {
    throw new Error('Invalid instance identifier.');
  }
  for (const pat of CATASTROPHIC_SHELL_PATTERNS) {
    if (pat.test(command)) {
      throw new Error('Blocked potentially catastrophic command against root filesystem or block devices.');
    }
  }

  const wrappedScript = `if command -v bash >/dev/null 2>&1; then exec bash -c "$1"; else exec /bin/sh -c "$1"; fi`;
  return await new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
    const proc = spawn(
      'incus',
      ['exec', instanceName, '--', '/bin/sh', '-c', wrappedScript, '--', command],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let combined = '';
    const maxBytes = 14000;
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    const appendChunk = (buf: Buffer) => {
      combined += buf.toString('utf8');
      if (combined.length > maxBytes) {
        combined = `${combined.slice(0, 3000)}\n... [truncated] ...\n${combined.slice(-9000)}`;
      }
    };
    proc.stdout.on('data', appendChunk);
    proc.stderr.on('data', appendChunk);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, output: combined.trim() });
    });
  });
}

// ==========================================
// TOOL DEFINITIONS FOR OPENAI FUNCTION CALLING
// ==========================================

const MINECRAFT_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_mc_file',
      description:
        'Read a configuration or log file inside the Minecraft server workspace (read-only).',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description:
              'Relative file path inside server directory, e.g. server.properties, bukkit.yml, spigot.yml, logs/latest.log',
          },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_and_install_plugin_or_mod',
      description:
        'Search Modrinth for a compatible plugin or mod matching this server version & loader and download its .jar into /plugins or /mods.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Plugin or mod name to search (e.g. EssentialsX, LuckPerms, Lithium, WorldEdit)',
          },
          project_type: {
            type: 'string',
            enum: ['plugin', 'mod'],
            description: 'Use plugin for Paper/Purpur/Spigot/Velocity or mod for Fabric/Forge',
          },
        },
        required: ['query', 'project_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_server_config',
      description:
        'Modify server.properties, bukkit.yml, spigot.yml, config/paper-world-defaults.yml, or a plugin config.yml safely inside the server workspace.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Relative config file path inside the Minecraft server directory',
          },
          changes: {
            type: 'object',
            additionalProperties: true,
            description:
              'Key-value map of config settings to update (e.g. {"view-distance": 8, "pvp": true})',
          },
          full_content: {
            type: 'string',
            description: 'Optional complete replacement file content for complex nested YAML edits',
          },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_mc_command',
      description:
        'Send a live console/RCON command to the running Minecraft server (e.g. whitelist on, gamerule keepInventory true, op Player).',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Minecraft command string without leading slash or with leading slash',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_skript_or_file',
      description:
        'Create or overwrite a custom Skript (.sk inside plugins/Skript/scripts/) or a custom datapack/text config file inside the server workspace.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description:
              'Filename or relative path (if ending with .sk without a folder, placed in plugins/Skript/scripts/)',
          },
          content: {
            type: 'string',
            description: 'Complete file content',
          },
        },
        required: ['filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'power_action',
      description: 'Start, stop, or restart the Minecraft Docker server.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'restart'],
            description: 'Power state transition',
          },
        },
        required: ['action'],
      },
    },
  },
];

const VPS_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'diagnose_vps_health',
      description:
        'Read-only health check collecting live Incus CPU/RAM/Disk/Net telemetry plus top, free -m, df -h, and failed systemd units inside the VPS.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_vps_command',
      description:
        'Execute a Linux shell command inside the target VPS/LXC container via incus exec and return stdout/stderr output.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Bash/sh command to run inside the VPS instance',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'install_package_or_stack',
      description:
        'Automated 1-click installation of a standard server software stack inside the VPS.',
      parameters: {
        type: 'object',
        properties: {
          stack_name: {
            type: 'string',
            enum: ['docker', 'nodejs', 'python3', 'nginx', 'mysql', 'redis', 'ufw', 'sshx'],
            description: 'Software stack to install inside the VPS',
          },
        },
        required: ['stack_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_vps_file',
      description:
        'Read, create, edit, or delete configuration files inside the VPS filesystem (e.g. Nginx configs, .env files, systemd units).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'create', 'edit', 'delete'],
            description: 'File operation inside the VPS',
          },
          path: {
            type: 'string',
            description: 'Absolute POSIX path inside the VPS, e.g. /etc/nginx/sites-available/app',
          },
          content: {
            type: 'string',
            description: 'File contents (required for create and edit)',
          },
        },
        required: ['action', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_port_forward',
      description:
        'Allocate an available public Shared IPv4 port and bind an Incus NAT proxy device forwarding traffic to an internal VPS port.',
      parameters: {
        type: 'object',
        properties: {
          internal_port: {
            type: 'number',
            description: 'Port inside the VPS/container (1-65535, e.g. 8080, 3000, 25565)',
          },
          protocol: {
            type: 'string',
            enum: ['tcp', 'udp'],
            description: 'Transport protocol (default tcp)',
          },
        },
        required: ['internal_port'],
      },
    },
  },
];

// ==========================================
// METADATA & RISK CLASSIFICATION
// ==========================================

function describeToolAction(
  agentType: AiAgentType,
  toolName: string,
  args: Record<string, unknown>
): { title: string; description: string; riskLevel: 'safe' | 'high'; isReadOnly: boolean } {
  if (agentType === 'minecraft') {
    switch (toolName) {
      case 'read_mc_file':
        return {
          title: `Read ${String(args.file_path || 'file')}`,
          description: `Inspect ${String(args.file_path || 'file')} inside server workspace`,
          riskLevel: 'safe',
          isReadOnly: true,
        };
      case 'search_and_install_plugin_or_mod':
        return {
          title: `Install ${String(args.project_type || 'plugin')}: ${String(args.query || '')}`,
          description: `Search Modrinth and download compatible .jar into /${
            args.project_type === 'mod' ? 'mods' : 'plugins'
          }`,
          riskLevel: 'safe',
          isReadOnly: false,
        };
      case 'edit_server_config':
        return {
          title: `Edit ${String(args.file_path || 'config')}`,
          description: `Update configuration values in ${String(args.file_path || '')}`,
          riskLevel: 'safe',
          isReadOnly: false,
        };
      case 'run_mc_command':
        return {
          title: `Run Console Command: /${String(args.command || '').replace(/^\/+/, '')}`,
          description: 'Execute command via Minecraft RCON inside the running container',
          riskLevel: 'safe',
          isReadOnly: false,
        };
      case 'create_skript_or_file':
        return {
          title: `Write File: ${String(args.filename || 'script')}`,
          description: 'Create or update Skript/config file inside server workspace',
          riskLevel: 'safe',
          isReadOnly: false,
        };
      case 'power_action':
        return {
          title: `Power Action: ${String(args.action || '').toUpperCase()} Server`,
          description: `Send ${String(args.action || 'restart')} power signal to Minecraft container`,
          riskLevel: 'high',
          isReadOnly: false,
        };
    }
  }

  switch (toolName) {
    case 'diagnose_vps_health':
      return {
        title: 'Diagnose VPS Health',
        description: 'Inspect CPU, RAM, Disk, top processes, and systemd unit states',
        riskLevel: 'safe',
        isReadOnly: true,
      };
    case 'execute_vps_command': {
      const cmd = String(args.command || '');
      const isHigh = HIGH_RISK_SHELL_PATTERNS.some((p) => p.test(cmd));
      return {
        title: `Execute: ${cmd.slice(0, 72)}${cmd.length > 72 ? '...' : ''}`,
        description: `Run command inside VPS container via incus exec`,
        riskLevel: isHigh ? 'high' : 'safe',
        isReadOnly: false,
      };
    }
    case 'install_package_or_stack':
      return {
        title: `Install Stack: ${String(args.stack_name || '')}`,
        description: `Install and configure ${String(args.stack_name || '')} inside the VPS`,
        riskLevel: 'safe',
        isReadOnly: false,
      };
    case 'manage_vps_file': {
      const act = String(args.action || 'read');
      const target = String(args.path || '/root');
      if (act === 'read') {
        return {
          title: `Read ${target}`,
          description: 'Read file content from inside the VPS',
          riskLevel: 'safe',
          isReadOnly: true,
        };
      }
      return {
        title: `${act === 'delete' ? 'Delete' : 'Write'} ${target}`,
        description: `${act === 'delete' ? 'Remove' : 'Create/update'} ${target} inside the VPS`,
        riskLevel: act === 'delete' ? 'high' : 'safe',
        isReadOnly: false,
      };
    }
    case 'add_port_forward':
      return {
        title: `Forward Shared IPv4 Port -> :${Number(args.internal_port || 80)}/${String(
          args.protocol || 'tcp'
        ).toUpperCase()}`,
        description: 'Allocate an available Shared IPv4 NAT port and bind Incus proxy rule',
        riskLevel: 'safe',
        isReadOnly: false,
      };
    default:
      return {
        title: toolName,
        description: 'Run assistant tool',
        riskLevel: 'high',
        isReadOnly: false,
      };
  }
}

// ==========================================
// REAL TOOL EXECUTORS
// ==========================================

async function executeMinecraftTool(params: {
  serverId: number;
  toolName: string;
  args: Record<string, unknown>;
  user: AuthUserPayload;
  ipAddress: string;
}): Promise<{ summary: string; output: string }> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(params.serverId) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  // Enforce granular sub-user RBAC for AI actions too
  const requiredPerm =
    params.toolName === 'power_action'
      ? 'can_start_stop'
      : params.toolName === 'run_mc_command'
      ? 'can_use_console'
      : params.toolName === 'read_mc_file'
      ? undefined
      : 'can_edit_files';

  const access = canAccessMinecraftServer(params.user, srv.id, requiredPerm);
  if (!access.allowed) {
    throw new Error(access.reason || 'Permission denied for this server action.');
  }

  switch (params.toolName) {
    case 'read_mc_file': {
      const rel = sanitizeMcRelativePath(String(params.args.file_path || ''));
      const full = resolveConfinedPath(srv.data_dir, rel);
      if (!fs.existsSync(full)) {
        return { summary: `File '${rel}' does not exist yet`, output: 'File not found.' };
      }
      const stat = fs.statSync(full);
      if (stat.isDirectory()) throw new Error(`'${rel}' is a directory.`);
      const text = fs.readFileSync(full, 'utf8').slice(0, 14000);
      return { summary: `Read ${rel} (${stat.size} bytes)`, output: text };
    }

    case 'search_and_install_plugin_or_mod': {
      const query = String(params.args.query || '').trim();
      const projectType = params.args.project_type === 'mod' ? 'mod' : 'plugin';
      if (!query) throw new Error('Search query is required.');

      const swLower = srv.software.toLowerCase();
      const loaderMap: Record<string, string> = {
        paper: 'paper',
        purpur: 'purpur',
        spigot: 'spigot',
        velocity: 'velocity',
        fabric: 'fabric',
        forge: 'forge',
      };
      const loader = loaderMap[swLower];

      let hits = await searchModrinthProjects({
        query,
        projectType,
        loader,
        gameVersion: srv.version,
      });

      if (hits.length === 0) {
        hits = await searchModrinthProjects({ query, projectType });
      }
      if (hits.length === 0) {
        throw new Error(`No Modrinth ${projectType}s found for "${query}".`);
      }

      const best = hits[0];
      const installed = await installModrinthProject({
        serverId: srv.id,
        projectId: best.project_id,
        projectType,
        userId: params.user.id,
        username: params.user.username,
        ipAddress: params.ipAddress,
      });

      recordAuditLog({
        userId: params.user.id,
        username: params.user.username,
        action: 'ai.minecraft.install_addon',
        target: srv.container_name,
        details: `AI installed ${best.title} (${installed.filename})`,
        ipAddress: params.ipAddress,
      });

      return {
        summary: `Installed ${installed.filename} into /${projectType === 'mod' ? 'mods' : 'plugins'}`,
        output: `Project: ${best.title} by ${best.author}\nVersion: ${installed.versionNumber}\nSaved to: ${installed.installedPath}\nRestart the server to load this ${projectType}.`,
      };
    }

    case 'edit_server_config': {
      const rel = sanitizeMcRelativePath(String(params.args.file_path || ''));
      const full = resolveConfinedPath(srv.data_dir, rel);
      const existing = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
      let updated: string;

      if (typeof params.args.full_content === 'string' && params.args.full_content.trim() !== '') {
        updated = params.args.full_content;
      } else {
        const changes =
          params.args.changes && typeof params.args.changes === 'object'
            ? (params.args.changes as Record<string, string | number | boolean>)
            : {};
        if (Object.keys(changes).length === 0) {
          throw new Error('Provide either changes key-value map or full_content.');
        }
        updated = applyPropertiesOrYamlChanges(existing, rel, changes);
      }

      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, updated, 'utf8');

      recordAuditLog({
        userId: params.user.id,
        username: params.user.username,
        action: 'ai.minecraft.edit_config',
        target: srv.container_name,
        details: `AI updated config file: ${rel}`,
        ipAddress: params.ipAddress,
      });

      return {
        summary: `Updated ${rel}`,
        output: updated.slice(0, 2000),
      };
    }

    case 'run_mc_command': {
      const rawCmd = String(params.args.command || '').replace(/[\r\n]/g, '').trim();
      const cmd = rawCmd.replace(/^\/+/, '');
      if (!cmd) throw new Error('Command cannot be empty.');
      const response = await sendMinecraftCommand(srv.id, cmd);

      recordAuditLog({
        userId: params.user.id,
        username: params.user.username,
        action: 'ai.minecraft.command',
        target: srv.container_name,
        details: `AI ran MC command: /${cmd}`,
        ipAddress: params.ipAddress,
      });

      return {
        summary: `Executed: /${cmd}`,
        output: response || '(Command dispatched cleanly with empty RCON reply)',
      };
    }

    case 'create_skript_or_file': {
      let rawFile = String(params.args.filename || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
      if (!rawFile) throw new Error('Filename is required.');
      if (rawFile.endsWith('.sk') && !rawFile.includes('/')) {
        rawFile = `plugins/Skript/scripts/${rawFile}`;
      }
      const cleanRel = sanitizeMcRelativePath(rawFile);
      const content = String(params.args.content ?? '');
      writeServerFile(srv.id, cleanRel, content);

      recordAuditLog({
        userId: params.user.id,
        username: params.user.username,
        action: 'ai.minecraft.write_file',
        target: srv.container_name,
        details: `AI created/wrote ${cleanRel}`,
        ipAddress: params.ipAddress,
      });

      return {
        summary: `Created ${cleanRel}`,
        output: `Saved ${content.length} chars to ${cleanRel}`,
      };
    }

    case 'power_action': {
      const action = String(params.args.action || '');
      if (!['start', 'stop', 'restart'].includes(action)) {
        throw new Error('Invalid power action. Must be start, stop, or restart.');
      }
      const result = await controlMinecraftServer({
        id: srv.id,
        action: action as 'start' | 'stop' | 'restart',
        userId: params.user.id,
        username: params.user.username,
        ipAddress: params.ipAddress,
      });

      return {
        summary: `Server ${action} completed (${result.status})`,
        output: `Container ${srv.container_name} status is now '${result.status}'.`,
      };
    }

    default:
      throw new Error(`Unsupported Minecraft AI tool: ${params.toolName}`);
  }
}

async function installExtendedVpsStack(instanceName: string, stack: 'mysql' | 'redis' | 'ufw' | 'sshx') {
  const scripts: Record<typeof stack, string> = {
    mysql: [
      'set -e',
      'if command -v apt-get >/dev/null 2>&1; then',
      '  export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq mariadb-server',
      '  systemctl enable --now mariadb || service mariadb start || true',
      'elif command -v dnf >/dev/null 2>&1; then',
      '  dnf install -y mariadb-server && systemctl enable --now mariadb',
      'elif command -v apk >/dev/null 2>&1; then',
      '  apk add --no-cache mariadb mariadb-client && rc-service mariadb setup || true && rc-service mariadb start || true',
      'fi',
      'mysql --version || mariadb --version',
    ].join('\n'),
    redis: [
      'set -e',
      'if command -v apt-get >/dev/null 2>&1; then',
      '  export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq redis-server',
      '  systemctl enable --now redis-server || service redis-server start || true',
      'elif command -v dnf >/dev/null 2>&1; then',
      '  dnf install -y redis && systemctl enable --now redis',
      'elif command -v apk >/dev/null 2>&1; then',
      '  apk add --no-cache redis && rc-update add redis default && service redis start || true',
      'fi',
      'redis-server --version',
    ].join('\n'),
    ufw: [
      'set -e',
      'if command -v apt-get >/dev/null 2>&1; then',
      '  export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq ufw',
      'elif command -v dnf >/dev/null 2>&1; then',
      '  dnf install -y ufw',
      'else',
      '  echo "UFW package unavailable on this distro"; exit 1',
      'fi',
      'ufw allow 22/tcp && ufw --force enable && ufw status',
    ].join('\n'),
    sshx: [
      'set -e',
      'if ! command -v curl >/dev/null 2>&1; then',
      '  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq curl ca-certificates; fi',
      '  if command -v apk >/dev/null 2>&1; then apk add --no-cache curl ca-certificates; fi',
      'fi',
      'curl -sSf https://sshx.io/get | sh',
      'sshx --version',
    ].join('\n'),
  };

  const res = await execIncusCommand(instanceName, scripts[stack], 240000);
  if (res.exitCode !== 0) {
    throw new Error(res.output || `${stack} installation failed with exit code ${res.exitCode}`);
  }
  return res.output;
}

async function executeVpsTool(params: {
  instanceId: number;
  toolName: string;
  args: Record<string, unknown>;
  user: AuthUserPayload;
  ipAddress: string;
}): Promise<{ summary: string; output: string }> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(params.instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('VPS/LXC instance not found.');

  const access = canAccessIncusInstance(params.user, inst.id);
  if (!access.allowed) {
    throw new Error(access.reason || 'Permission denied.');
  }

  switch (params.toolName) {
    case 'diagnose_vps_health': {
      const telemetry = await getIncusInstanceTelemetry(inst.id);
      const summaryLines = [
        `Status: ${telemetry.status} (live=${telemetry.live})`,
        `CPU: ${telemetry.cpuPercent}% across ${inst.vcpu} vCPU`,
        `RAM: ${telemetry.ramUsedMb} / ${telemetry.ramLimitMb} MB | Swap: ${telemetry.swapUsedMb} / ${telemetry.swapTotalMb} MB`,
        `Disk: ${telemetry.diskUsedGb} / ${telemetry.diskTotalGb} GB`,
        `Network: RX ${(telemetry.netRxBytesPerSec / 1024).toFixed(1)} KB/s | TX ${(telemetry.netTxBytesPerSec / 1024).toFixed(1)} KB/s`,
        `Uptime: ${Math.floor(telemetry.uptimeSeconds / 60)}m | Kernel: ${telemetry.kernel || 'unknown'}`,
        `Internal IP: ${telemetry.internalIp || 'none'} | Shared IPv4: ${telemetry.hostIpv4}:${telemetry.sshPort || 'n/a'}`,
      ];

      let guestDiag = '';
      if (telemetry.live && (await isIncusReady())) {
        try {
          const diag = await execIncusCommand(
            inst.instance_name,
            [
              'echo "=== MEMORY ===" && free -m',
              'echo "=== DISK ===" && df -h',
              'echo "=== TOP PROCESSES ===" && (ps -eo pid,comm,%mem,%cpu --sort=-%cpu 2>/dev/null | head -n 12 || top -bn1 | head -n 16)',
              'echo "=== FAILED SERVICES ===" && (systemctl --failed --no-pager 2>/dev/null || rc-status 2>/dev/null || echo "n/a")',
            ].join(' && '),
            20000
          );
          guestDiag = diag.output;
        } catch (err) {
          guestDiag = `In-guest diagnostic probe skipped: ${
            err instanceof Error ? err.message : 'unavailable'
          }`;
        }
      }

      return {
        summary: `Collected VPS health metrics (${telemetry.cpuPercent}% CPU, ${telemetry.ramUsedMb}/${telemetry.ramLimitMb} MB RAM)`,
        output: `${summaryLines.join('\n')}${guestDiag ? `\n\n${guestDiag}` : ''}`,
      };
    }

    case 'execute_vps_command': {
      if (!(await isIncusReady())) {
        throw new Error('Incus daemon is unavailable on this host.');
      }
      if (inst.status !== 'running') {
        throw new Error('Instance is stopped. Start the VPS before executing commands.');
      }
      if (inst.node_id && inst.node_id !== 1) {
        throw new Error('Remote node VPS command execution requires SSH/direct node daemon.');
      }
      const command = String(params.args.command || '').trim();
      if (!command) throw new Error('Command cannot be empty.');
      const result = await execIncusCommand(inst.instance_name, command, 60000);

      recordAuditLog({
        userId: params.user.id,
        username: params.user.username,
        action: 'ai.vps.exec',
        target: inst.instance_name,
        details: `AI executed command (exit ${result.exitCode}): ${command.slice(0, 120)}`,
        ipAddress: params.ipAddress,
      });

      if (result.exitCode !== 0) {
        return {
          summary: `Executed with exit code ${result.exitCode}: ${command.slice(0, 56)}`,
          output: result.output || `Process exited with code ${result.exitCode}.`,
        };
      }
      return {
        summary: `Executed: ${command.slice(0, 64)}`,
        output: result.output || '(Command succeeded with no output)',
      };
    }

    case 'install_package_or_stack': {
      const stack = String(params.args.stack_name || '').toLowerCase();
      if (!(await isIncusReady())) {
        throw new Error('Incus daemon is unavailable on this host.');
      }
      if (inst.status !== 'running') {
        throw new Error('Start the VPS before installing packages.');
      }
      if (stack === 'docker' || stack === 'nodejs' || stack === 'nginx' || stack === 'python3') {
        const recipeMap = {
          docker: 'docker',
          nodejs: 'nodejs_pm2',
          nginx: 'nginx_certbot',
          python3: 'python3',
        } as const;
        const res = await runIncusAppRecipe({
          instanceId: inst.id,
          recipeId: recipeMap[stack],
          userId: params.user.id,
          username: params.user.username,
          ipAddress: params.ipAddress,
        });
        return {
          summary: `Installed ${res.label}`,
          output: res.output,
        };
      }
      if (stack === 'mysql' || stack === 'redis' || stack === 'ufw' || stack === 'sshx') {
        const output = await installExtendedVpsStack(inst.instance_name, stack);
        recordAuditLog({
          userId: params.user.id,
          username: params.user.username,
          action: 'ai.vps.install_stack',
          target: inst.instance_name,
          details: `AI installed ${stack}`,
          ipAddress: params.ipAddress,
        });
        return {
          summary: `Installed ${stack} stack inside ${inst.name}`,
          output,
        };
      }
      throw new Error(`Unsupported stack '${stack}'.`);
    }

    case 'manage_vps_file': {
      const action = String(params.args.action || 'read');
      const cleanPath = sanitizeContainerFilePath(String(params.args.path || ''), '/root');
      if (action !== 'read' && PROTECTED_VPS_PATHS.has(cleanPath)) {
        throw new Error(`Refusing to modify or delete protected system directory '${cleanPath}'.`);
      }

      if (action === 'read') {
        const fileData = await readContainerFile(inst.id, cleanPath);
        return {
          summary: `Read ${cleanPath}`,
          output: fileData.content.slice(0, 12000),
        };
      }
      if (action === 'create' || action === 'edit') {
        const content = String(params.args.content ?? '');
        await writeContainerFile({
          instanceId: inst.id,
          filePath: cleanPath,
          content,
          userId: params.user.id,
          username: params.user.username,
          ipAddress: params.ipAddress,
        });
        return {
          summary: `Saved ${cleanPath}`,
          output: `Wrote ${content.length} chars to ${cleanPath}`,
        };
      }
      if (action === 'delete') {
        await deleteContainerEntry({
          instanceId: inst.id,
          targetPath: cleanPath,
          userId: params.user.id,
          username: params.user.username,
          ipAddress: params.ipAddress,
        });
        return {
          summary: `Deleted ${cleanPath}`,
          output: `Removed ${cleanPath} from ${inst.instance_name}`,
        };
      }
      throw new Error(`Unsupported file action '${action}'.`);
    }

    case 'add_port_forward': {
      const internalPort = Number(params.args.internal_port);
      const protocol = params.args.protocol === 'udp' ? 'udp' : 'tcp';
      if (!isValidPort(internalPort) && !(Number.isInteger(internalPort) && internalPort >= 1 && internalPort <= 65535)) {
        throw new Error('internal_port must be between 1 and 65535.');
      }
      const hostPort = getNextFreeSharedPort(protocol);
      const rule = await addIncusPortForward({
        id: inst.id,
        hostPort,
        targetPort: internalPort,
        protocol,
        userId: params.user.id,
        username: params.user.username,
        ipAddress: params.ipAddress,
      });
      const hostIp = inst.host_ipv4 || (await detectHostPublicIpv4());
      return {
        summary: `Forwarded ${hostIp}:${rule.host_port} -> :${rule.target_port}/${protocol.toUpperCase()}`,
        output: `Public Endpoint: ${hostIp}:${rule.host_port}\nInternal Target: :${rule.target_port} (${protocol.toUpperCase()})\nDevice: ${rule.device_name}`,
      };
    }

    default:
      throw new Error(`Unsupported VPS AI tool: ${params.toolName}`);
  }
}

// ==========================================
// SYSTEM PROMPT & CONTEXT BUILDERS
// ==========================================

async function buildMinecraftContext(serverId: number, includeFullCrashLogs: boolean): Promise<string> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(serverId) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const tailLines = includeFullCrashLogs ? 110 : 40;
  const logs = await getMinecraftLogs(srv.id, tailLines).catch(() => []);
  const addons = listInstalledAddons(srv.data_dir);
  let onlineInfo = 'Unavailable (offline)';
  if (srv.status === 'running') {
    try {
      const players = await getMinecraftPlayers(srv.id);
      onlineInfo = `${players.online.length} online (${
        players.online.map((p) => p.name).join(', ') || 'none'
      })`;
    } catch {
      onlineInfo = 'Running (player query unavailable)';
    }
  }

  return [
    `You are "MC AI Assistant", an expert Minecraft server administrator and plugin/Skript/performance engineer embedded inside FB BAHI Panel.`,
    `Respond clearly in English, Hindi, or Hinglish—matching whatever language the user writes in.`,
    `Server Context:`,
    `- Name: ${srv.name} (container: ${srv.container_name})`,
    `- Software: ${srv.software} | Minecraft Version: ${srv.version}`,
    `- Resources: ${srv.ram_mb} MB RAM, ${srv.cpu_percent}% CPU, ${srv.disk_mb} MB Disk, Port ${srv.port}`,
    `- Status: ${srv.status} | Players: ${onlineInfo}`,
    `- Installed Plugins/Scripts (${addons.plugins.length}): ${addons.plugins.join(', ') || 'none'}`,
    `- Installed Mods (${addons.mods.length}): ${addons.mods.join(', ') || 'none'}`,
    `- Recent Console Logs (last ${logs.length} lines):`,
    '```log',
    logs.slice(-tailLines).join('\n').slice(-7000) || '(no logs available)',
    '```',
    `Tool rules:`,
    `- Never claim you executed a tool unless you actually called it and received an executed result.`,
    `- If an action is queued for user approval, clearly tell the user what is pending in the Action Card and instruct them to click Approve.`,
    `- Never tell the user to run dangerous commands outside the container.`,
  ].join('\n');
}

async function buildVpsContext(instanceId: number): Promise<string> {
  const inst = db.prepare('SELECT * FROM vm_instances WHERE id = ?').get(instanceId) as
    | VmInstanceRow
    | undefined;
  if (!inst) throw new Error('Instance not found.');

  const ports = listPortAllocations('incus', inst.id);
  const hostIp = inst.host_ipv4 || (await detectHostPublicIpv4().catch(() => '127.0.0.1'));
  let telemetryText = 'Telemetry unavailable';
  try {
    const t = await getIncusInstanceTelemetry(inst.id);
    telemetryText = `CPU ${t.cpuPercent}%, RAM ${t.ramUsedMb}/${t.ramLimitMb} MB, Swap ${t.swapUsedMb}/${t.swapTotalMb} MB, Disk ${t.diskUsedGb}/${t.diskTotalGb} GB, Uptime ${Math.floor(t.uptimeSeconds / 60)}m, Kernel ${t.kernel || 'unknown'}`;
  } catch {
    // ignore
  }

  return [
    `You are "VPS / VM AI SysAdmin", an expert Linux DevOps & Incus systems engineer embedded inside FB BAHI Panel.`,
    `Respond clearly in English, Hindi, or Hinglish—matching whatever language the user writes in.`,
    `VPS Instance Context:`,
    `- Name: ${inst.name} (Incus instance: ${inst.instance_name}, Type: ${inst.type})`,
    `- OS Template: ${inst.os_template}`,
    `- Specs: ${inst.vcpu} vCPU, ${inst.ram_mb} MB RAM, ${inst.disk_gb} GB Disk`,
    `- Status: ${inst.status} | Telemetry: ${telemetryText}`,
    `- Internal IP: ${inst.ip_address || 'pending'} | Shared Public IPv4: ${hostIp} | SSH Port: ${inst.ssh_port || 'none'}`,
    `- NAT Port Forwards: ${
      ports.map((p) => `${hostIp}:${p.host_port}->:${p.target_port}/${p.protocol}`).join(', ') || 'none'
    }`,
    `Tool rules:`,
    `- Every command runs strictly inside the isolated VPS instance via incus exec (never on the host VPS).`,
    `- Never claim you ran a command, edited a file, or opened a port unless you actually invoked the tool and it succeeded.`,
    `- When an action is queued for confirmation, explain what will run and ask the user to click Approve on the Action Card.`,
  ].join('\n');
}

// ==========================================
// MAIN CHAT & CONFIRMATION ENTRY POINTS
// ==========================================

export async function runAgentChat(params: {
  agentType: AiAgentType;
  resourceId: number;
  user: AuthUserPayload;
  message: string;
  confirmationMode: AiConfirmationMode;
  analyzeLogs?: boolean;
  ipAddress: string;
}): Promise<{ userMessage: AiChatMessage; assistantMessage: AiChatMessage }> {
  const { apiKey, model } = resolveOpenAiConfig();
  if (!apiKey) {
    throw new Error(
      'OpenAI API key is not configured. Ask the Panel Owner to add OPENAI_API_KEY in Owner Settings or .env.'
    );
  }

  if (params.agentType === 'minecraft') {
    const access = canAccessMinecraftServer(params.user, params.resourceId);
    if (!access.allowed) throw new Error(access.reason || 'Access denied.');
  } else {
    const access = canAccessIncusInstance(params.user, params.resourceId);
    if (!access.allowed) throw new Error(access.reason || 'Access denied.');
  }

  const trimmedPrompt = (params.message || '').trim().slice(0, 6000);
  if (!trimmedPrompt) {
    throw new Error('Message cannot be empty.');
  }

  const recentHistory = listAiChatHistory({
    agentType: params.agentType,
    resourceId: params.resourceId,
    userId: params.user.id,
    limit: 14,
  });

  const userMessage = insertAiMessage({
    agentType: params.agentType,
    resourceId: params.resourceId,
    userId: params.user.id,
    role: 'user',
    content: trimmedPrompt,
    model,
  });

  const systemPrompt =
    params.agentType === 'minecraft'
      ? await buildMinecraftContext(params.resourceId, Boolean(params.analyzeLogs))
      : await buildVpsContext(params.resourceId);

  const openai = new OpenAI({ apiKey, timeout: 45000 });
  const tools = params.agentType === 'minecraft' ? MINECRAFT_TOOLS : VPS_TOOLS;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...recentHistory.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: 'user', content: trimmedPrompt },
  ];

  const executedActions: AiToolAction[] = [];
  const pendingActions: AiToolAction[] = [];
  let finalReply = '';

  try {
    for (let round = 0; round < 4; round += 1) {
      const completion = await openai.chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.35,
      });

      const choice = completion.choices[0]?.message;
      if (!choice) break;

      const toolCalls = choice.tool_calls || [];
      if (toolCalls.length === 0) {
        finalReply = (choice.content || '').trim();
        break;
      }

      messages.push({
        role: 'assistant',
        content: choice.content || null,
        tool_calls: toolCalls,
      });

      let deferredToUserApproval = false;

      for (const tc of toolCalls) {
        if (tc.type !== 'function') continue;
        const toolName = tc.function.name;
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
        } catch {
          parsedArgs = {};
        }

        const meta = describeToolAction(params.agentType, toolName, parsedArgs);
        const actionId = `act_${crypto.randomBytes(5).toString('hex')}`;
        const canAutoRun =
          meta.isReadOnly || (params.confirmationMode === 'auto' && meta.riskLevel === 'safe');

        if (!canAutoRun) {
          pendingActions.push({
            id: actionId,
            toolName,
            title: meta.title,
            description: meta.description,
            args: parsedArgs,
            status: 'pending',
            riskLevel: meta.riskLevel,
          });
          deferredToUserApproval = true;
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({
              queued_for_approval: true,
              actionId,
              title: meta.title,
              reason:
                meta.riskLevel === 'high'
                  ? 'High-impact action always requires explicit user approval.'
                  : 'Confirmation Mode is set to Ask Before Running.',
            }),
          });
          continue;
        }

        try {
          const res =
            params.agentType === 'minecraft'
              ? await executeMinecraftTool({
                  serverId: params.resourceId,
                  toolName,
                  args: parsedArgs,
                  user: params.user,
                  ipAddress: params.ipAddress,
                })
              : await executeVpsTool({
                  instanceId: params.resourceId,
                  toolName,
                  args: parsedArgs,
                  user: params.user,
                  ipAddress: params.ipAddress,
                });

          executedActions.push({
            id: actionId,
            toolName,
            title: meta.title,
            description: meta.description,
            args: parsedArgs,
            status: 'executed',
            riskLevel: meta.riskLevel,
            summary: res.summary,
            output: res.output,
            executedAt: new Date().toISOString(),
          });

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: true, summary: res.summary, output: res.output.slice(0, 6000) }),
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Tool execution failed.';
          executedActions.push({
            id: actionId,
            toolName,
            title: meta.title,
            description: meta.description,
            args: parsedArgs,
            status: 'failed',
            riskLevel: meta.riskLevel,
            error: errMsg,
            executedAt: new Date().toISOString(),
          });

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, error: errMsg }),
          });
        }
      }

      if (deferredToUserApproval) {
        // Ask model for a crisp final explanation referencing the pending action cards
        const follow = await openai.chat.completions.create({
          model,
          messages,
          temperature: 0.35,
        });
        finalReply =
          (follow.choices[0]?.message?.content || '').trim() ||
          'I prepared the requested action(s) below. Click **Approve** to execute or **Reject** to cancel.';
        break;
      }
    }
  } catch (err) {
    if (executedActions.length === 0 && pendingActions.length === 0) {
      db.prepare('DELETE FROM ai_chat_history WHERE id = ?').run(userMessage.id);
    }
    throw formatOpenAiError(err);
  }

  if (!finalReply) {
    finalReply =
      executedActions.length > 0
        ? 'Completed the requested operation(s). Review the action cards below for details.'
        : 'Done.';
  }

  const assistantMessage = insertAiMessage({
    agentType: params.agentType,
    resourceId: params.resourceId,
    userId: params.user.id,
    role: 'assistant',
    content: finalReply,
    toolActions: executedActions,
    pendingActions,
    model,
  });

  return { userMessage, assistantMessage };
}

export async function resolvePendingAiAction(params: {
  agentType: AiAgentType;
  resourceId: number;
  messageId: number;
  actionId: string;
  decision: 'approve' | 'reject';
  user: AuthUserPayload;
  ipAddress: string;
}): Promise<AiChatMessage> {
  if (params.agentType === 'minecraft') {
    const access = canAccessMinecraftServer(params.user, params.resourceId);
    if (!access.allowed) throw new Error(access.reason || 'Access denied.');
  } else {
    const access = canAccessIncusInstance(params.user, params.resourceId);
    if (!access.allowed) throw new Error(access.reason || 'Access denied.');
  }

  const row = db
    .prepare(
      `SELECT * FROM ai_chat_history
       WHERE id = ? AND agent_type = ? AND resource_id = ? AND user_id = ?`
    )
    .get(params.messageId, params.agentType, params.resourceId, params.user.id) as
    | RawAiChatRow
    | undefined;

  if (!row) {
    throw new Error('Chat message not found.');
  }

  const msg = rowToAiMessage(row);
  const idx = msg.pending_actions.findIndex((a) => a.id === params.actionId);
  if (idx === -1) {
    throw new Error('Pending action not found or already resolved.');
  }

  const target = msg.pending_actions[idx];
  if (target.status !== 'pending') {
    return msg;
  }

  let updatedAction: AiToolAction;
  if (params.decision === 'reject') {
    updatedAction = {
      ...target,
      status: 'rejected',
      summary: 'Rejected by user',
      executedAt: new Date().toISOString(),
    };
  } else {
    try {
      const res =
        params.agentType === 'minecraft'
          ? await executeMinecraftTool({
              serverId: params.resourceId,
              toolName: target.toolName,
              args: target.args,
              user: params.user,
              ipAddress: params.ipAddress,
            })
          : await executeVpsTool({
              instanceId: params.resourceId,
              toolName: target.toolName,
              args: target.args,
              user: params.user,
              ipAddress: params.ipAddress,
            });
      updatedAction = {
        ...target,
        status: 'executed',
        summary: res.summary,
        output: res.output,
        executedAt: new Date().toISOString(),
      };
    } catch (err) {
      updatedAction = {
        ...target,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Execution failed',
        executedAt: new Date().toISOString(),
      };
    }
  }

  const nextPending = msg.pending_actions.map((a) => (a.id === target.id ? updatedAction : a));
  db.prepare(`UPDATE ai_chat_history SET pending_actions = ? WHERE id = ?`).run(
    JSON.stringify(nextPending),
    msg.id
  );

  const refreshed = db.prepare('SELECT * FROM ai_chat_history WHERE id = ?').get(msg.id) as RawAiChatRow;
  return rowToAiMessage(refreshed);
}
