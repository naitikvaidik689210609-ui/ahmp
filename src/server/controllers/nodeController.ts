import crypto from 'node:crypto';
import type { Socket } from 'socket.io';
import { db, recordAuditLog } from '../db.js';
import {
  FQDN_REGEX,
  hashApiKey,
  isValidPort,
  sanitizeDisplayName,
} from '../security.js';
import type { LiveSystemStats } from './systemController.js';

export interface NodeRow {
  id: number;
  name: string;
  location: string;
  fqdn: string;
  daemon_port: number;
  token_prefix: string;
  token_hash: string;
  is_local: number;
  status: 'online' | 'offline';
  cpu_percent: number;
  ram_percent: number;
  disk_percent: number;
  active_servers: number;
  last_seen_at: string | null;
  created_at: string;
}

export interface NodePublicItem {
  id: number;
  name: string;
  location: string;
  fqdn: string;
  daemon_port: number;
  token_prefix: string;
  is_local: number;
  status: 'online' | 'offline';
  cpu_percent: number;
  ram_percent: number;
  disk_percent: number;
  active_servers: number;
  last_seen_at: string | null;
  created_at: string;
  workload_count: number;
}

const activeNodeSockets = new Map<number, Socket>();

export function getNodeById(nodeId: number): NodeRow | undefined {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId) as NodeRow | undefined;
}

export function verifyNodeToken(rawToken: string): NodeRow | undefined {
  if (!rawToken || !rawToken.startsWith('fbnode_')) return undefined;
  const tokenHash = hashApiKey(rawToken.trim());
  return db.prepare('SELECT * FROM nodes WHERE token_hash = ?').get(tokenHash) as
    | NodeRow
    | undefined;
}

export function listNodesWithCounts(): NodePublicItem[] {
  const rows = db
    .prepare(
      `SELECT n.id, n.name, n.location, n.fqdn, n.daemon_port, n.token_prefix,
              n.is_local, n.status, n.cpu_percent, n.ram_percent, n.disk_percent,
              n.active_servers, n.last_seen_at, n.created_at,
              (SELECT COUNT(*) FROM minecraft_servers ms WHERE ms.node_id = n.id) +
              (SELECT COUNT(*) FROM vm_instances vi WHERE vi.node_id = n.id) AS workload_count
       FROM nodes n
       ORDER BY n.is_local DESC, n.id ASC`
    )
    .all() as NodePublicItem[];

  return rows.map((r) => ({
    ...r,
    status: r.is_local === 1 || activeNodeSockets.has(r.id) ? 'online' : 'offline',
  }));
}

export function createRemoteNode(params: {
  name: string;
  location: string;
  fqdn: string;
  daemonPort: number;
  userId: number;
  username: string;
  ipAddress: string;
}): { node: NodePublicItem; rawToken: string } {
  const cleanName = sanitizeDisplayName(params.name);
  if (!cleanName || cleanName.length < 2) {
    throw new Error('Node name must be at least 2 characters.');
  }

  const cleanLocation = sanitizeDisplayName(params.location) || 'EU · VPS';
  const cleanFqdn = String(params.fqdn || '').trim();
  if (!cleanFqdn || !FQDN_REGEX.test(cleanFqdn)) {
    throw new Error('Valid IPv4, IPv6, or FQDN hostname is required.');
  }

  const port = Number(params.daemonPort || 8443);
  if (!isValidPort(port)) {
    throw new Error('Daemon port must be between 1024 and 65535.');
  }

  const rawToken = `fbnode_${crypto.randomBytes(24).toString('hex')}`;
  const tokenPrefix = rawToken.slice(0, 15);
  const tokenHash = hashApiKey(rawToken);

  const res = db
    .prepare(
      `INSERT INTO nodes (name, location, fqdn, daemon_port, token_prefix, token_hash, is_local, status)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'offline')`
    )
    .run(cleanName, cleanLocation, cleanFqdn, port, tokenPrefix, tokenHash);

  const nodeId = Number(res.lastInsertRowid);
  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'node.create',
    target: cleanName,
    details: `Registered remote node ${cleanFqdn}:${port} (${cleanLocation})`,
    ipAddress: params.ipAddress,
  });

  const created = listNodesWithCounts().find((n) => n.id === nodeId)!;
  return { node: created, rawToken };
}

export function regenerateNodeToken(params: {
  nodeId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): { rawToken: string; tokenPrefix: string } {
  const node = getNodeById(params.nodeId);
  if (!node) throw new Error('Node not found.');
  if (node.is_local === 1) {
    throw new Error('Primary local node does not require an external agent token.');
  }

  const rawToken = `fbnode_${crypto.randomBytes(24).toString('hex')}`;
  const tokenPrefix = rawToken.slice(0, 15);
  const tokenHash = hashApiKey(rawToken);

  db.prepare(
    `UPDATE nodes SET token_prefix = ?, token_hash = ?, status = 'offline' WHERE id = ?`
  ).run(tokenPrefix, tokenHash, node.id);

  const existingSock = activeNodeSockets.get(node.id);
  if (existingSock) {
    existingSock.disconnect(true);
    activeNodeSockets.delete(node.id);
  }

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'node.token_rotate',
    target: node.name,
    details: 'Rotated remote node daemon token',
    ipAddress: params.ipAddress,
  });

  return { rawToken, tokenPrefix };
}

export function deleteRemoteNode(params: {
  nodeId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): void {
  const node = getNodeById(params.nodeId);
  if (!node) throw new Error('Node not found.');
  if (node.is_local === 1) {
    throw new Error('Cannot delete the Primary Local Node.');
  }

  const mcCount = (
    db.prepare('SELECT COUNT(*) AS c FROM minecraft_servers WHERE node_id = ?').get(node.id) as {
      c: number;
    }
  ).c;
  const vmCount = (
    db.prepare('SELECT COUNT(*) AS c FROM vm_instances WHERE node_id = ?').get(node.id) as {
      c: number;
    }
  ).c;

  if (mcCount + vmCount > 0) {
    throw new Error(
      `Cannot delete node '${node.name}' while ${mcCount + vmCount} server(s)/VM(s) remain assigned to it.`
    );
  }

  const sock = activeNodeSockets.get(node.id);
  if (sock) {
    sock.disconnect(true);
    activeNodeSockets.delete(node.id);
  }

  db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'node.delete',
    target: node.name,
    details: `Removed remote node (${node.fqdn})`,
    ipAddress: params.ipAddress,
  });
}

export function registerNodeSocket(nodeId: number, socket: Socket): void {
  const old = activeNodeSockets.get(nodeId);
  if (old && old.id !== socket.id) {
    old.disconnect(true);
  }
  activeNodeSockets.set(nodeId, socket);
  db.prepare(
    `UPDATE nodes SET status = 'online', last_seen_at = datetime('now') WHERE id = ?`
  ).run(nodeId);
}

export function markNodeOffline(nodeId: number, socketId: string): void {
  const current = activeNodeSockets.get(nodeId);
  if (current && current.id === socketId) {
    activeNodeSockets.delete(nodeId);
    db.prepare(`UPDATE nodes SET status = 'offline' WHERE id = ? AND is_local = 0`).run(nodeId);
  }
}

export function updateNodeTelemetry(
  nodeId: number,
  metrics: {
    cpuPercent?: number;
    ramPercent?: number;
    diskPercent?: number;
    activeServers?: number;
  }
): void {
  db.prepare(
    `UPDATE nodes SET
       status = 'online',
       cpu_percent = ?,
       ram_percent = ?,
       disk_percent = ?,
       active_servers = ?,
       last_seen_at = datetime('now')
     WHERE id = ?`
  ).run(
    Number(metrics.cpuPercent || 0),
    Number(metrics.ramPercent || 0),
    Number(metrics.diskPercent || 0),
    Number(metrics.activeServers || 0),
    nodeId
  );
}

export function syncPrimaryNodeMetrics(stats: LiveSystemStats): void {
  db.prepare(
    `UPDATE nodes SET
       status = 'online',
       cpu_percent = ?,
       ram_percent = ?,
       disk_percent = ?,
       active_servers = ?,
       last_seen_at = datetime('now')
     WHERE is_local = 1`
  ).run(
    stats.cpuPercent,
    stats.memory.percent,
    stats.disk.percent,
    stats.counts.activeTotal
  );
}

export function isRemoteNodeConnected(nodeId: number): boolean {
  return activeNodeSockets.has(nodeId);
}

export async function dispatchNodeCommand<T = Record<string, unknown>>(
  nodeId: number,
  event: string,
  payload: Record<string, unknown>,
  timeoutMs = 30000
): Promise<T> {
  const sock = activeNodeSockets.get(nodeId);
  if (!sock || !sock.connected) {
    throw new Error(
      `Remote node #${nodeId} agent is offline. Run the 1-click fbbahi-agent installer on the secondary VPS.`
    );
  }

  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Remote node #${nodeId} timed out executing '${event}'.`));
    }, timeoutMs);

    sock.emit(event, payload, (response: { ok?: boolean; error?: string; data?: T }) => {
      clearTimeout(timer);
      if (!response || response.ok === false) {
        reject(new Error(response?.error || `Remote node command '${event}' failed.`));
        return;
      }
      resolve((response.data ?? (response as unknown as T)) as T);
    });
  });
}

export function getNodeInstallScript(panelUrl: string): string {
  const safeUrl = panelUrl.replace(/[^a-zA-Z0-9:/._-]/g, '');
  return `#!/usr/bin/env bash
set -euo pipefail

TOKEN=""
PANEL_URL="${safeUrl}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)
      TOKEN="$2"
      shift 2
      ;;
    --panel)
      PANEL_URL="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "$TOKEN" ]]; then
  echo "Error: --token <NODE_TOKEN> is required."
  exit 1
fi

echo "==> Installing FB BAHI Node Agent for $PANEL_URL"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

mkdir -p /opt/fbbahi-agent /var/lib/fbbahi-agent/mc
cd /opt/fbbahi-agent

if [[ ! -f package.json ]]; then
  npm init -y >/dev/null 2>&1
  npm install socket.io-client dockerode >/dev/null 2>&1
fi

curl -fsSL "$PANEL_URL/api/nodes/agent-script" -o /opt/fbbahi-agent/agent.mjs

cat >/etc/systemd/system/fbbahi-agent.service <<EOF
[Unit]
Description=FB BAHI Panel Remote Node Agent
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=/opt/fbbahi-agent
Environment=PANEL_URL=$PANEL_URL
Environment=NODE_TOKEN=$TOKEN
Environment=DATA_DIR=/var/lib/fbbahi-agent/mc
ExecStart=/usr/bin/node /opt/fbbahi-agent/agent.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now fbbahi-agent
echo "==> FB BAHI Node Agent installed and connected."
`;
}

export function getNodeAgentSource(): string {
  return `import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Docker from 'dockerode';
import { io } from 'socket.io-client';

const execFileAsync = promisify(execFile);
const PANEL_URL = process.env.PANEL_URL || 'http://localhost:6767';
const NODE_TOKEN = process.env.NODE_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/fbbahi-agent/mc';
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!NODE_TOKEN) {
  console.error('NODE_TOKEN is required.');
  process.exit(1);
}

let prevCpu = os.cpus().map((c) => {
  const t = c.times;
  return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
});

function sampleCpuPercent() {
  const curr = os.cpus().map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
  let idleDiff = 0;
  let totalDiff = 0;
  for (let i = 0; i < curr.length; i++) {
    idleDiff += curr[i].idle - (prevCpu[i]?.idle || 0);
    totalDiff += curr[i].total - (prevCpu[i]?.total || 0);
  }
  prevCpu = curr;
  if (totalDiff <= 0) return 0;
  return Number(Math.max(0, Math.min(100, ((totalDiff - idleDiff) / totalDiff) * 100)).toFixed(1));
}

async function collectMetrics() {
  const totalMem = os.totalmem();
  const ramPercent = Number((((totalMem - os.freemem()) / totalMem) * 100).toFixed(1));
  let diskPercent = 0;
  try {
    const st = fs.statfsSync('/');
    diskPercent = Number((((st.blocks - st.bavail) / st.blocks) * 100).toFixed(1));
  } catch {}
  let activeServers = 0;
  try {
    const containers = await docker.listContainers();
    activeServers += containers.length;
  } catch {}
  return {
    cpuPercent: sampleCpuPercent(),
    ramPercent,
    diskPercent,
    activeServers,
  };
}

const socket = io(\`\${PANEL_URL.replace(/\\/+$/, '')}/node-agent\`, {
  path: '/socket.io',
  auth: { nodeToken: NODE_TOKEN },
  reconnectionDelay: 3000,
});

socket.on('connect', () => {
  console.log('Connected to FB BAHI Panel master at', PANEL_URL);
});

setInterval(async () => {
  if (socket.connected) {
    try {
      socket.emit('node:metrics', await collectMetrics());
    } catch (err) {
      console.error('[FB BAHI Agent] Metrics collection error:', err && err.message ? err.message : err);
    }
  }
}, 3000);

function buildRemotePortConfig(allocations, fallbackPort) {
  const list = Array.isArray(allocations) && allocations.length > 0
    ? allocations
    : [{ ip: '0.0.0.0', port: fallbackPort, protocol: 'TCP/UDP' }];
  const ExposedPorts = {};
  const PortBindings = {};
  for (const alloc of list) {
    const proto = String(alloc.protocol || 'TCP/UDP').toUpperCase();
    const hostIp = alloc.ip === '0.0.0.0' ? '' : alloc.ip;
    const hostPort = String(alloc.port);
    if (proto === 'TCP' || proto === 'TCP/UDP' || proto === 'BOTH') {
      const k = \`\${alloc.port}/tcp\`;
      ExposedPorts[k] = {};
      PortBindings[k] = PortBindings[k] || [];
      PortBindings[k].push({ HostIp: hostIp, HostPort: hostPort });
    }
    if (proto === 'UDP' || proto === 'TCP/UDP' || proto === 'BOTH') {
      const k = \`\${alloc.port}/udp\`;
      ExposedPorts[k] = {};
      PortBindings[k] = PortBindings[k] || [];
      PortBindings[k].push({ HostIp: hostIp, HostPort: hostPort });
    }
  }
  return { ExposedPorts, PortBindings };
}

socket.on('mc:create', async (p, cb) => {
  try {
    const dir = path.join(DATA_DIR, p.containerName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'eula.txt'), \`eula=\${p.eulaAccepted ? 'true' : 'false'}\\n\`);
    const { ExposedPorts, PortBindings } = buildRemotePortConfig(p.allocations, p.port);
    const container = await docker.createContainer({
      Image: 'itzg/minecraft-server:latest',
      name: p.containerName,
      Tty: true,
      OpenStdin: true,
      Env: [
        \`EULA=\${p.eulaAccepted ? 'TRUE' : 'FALSE'}\`,
        \`TYPE=\${p.software}\`,
        \`VERSION=\${p.version}\`,
        \`MEMORY=\${p.ramMb}M\`,
        \`SERVER_PORT=\${p.port}\`,
      ],
      ExposedPorts,
      HostConfig: {
        Binds: [\`\${dir}:/data\`],
        PortBindings,
        Memory: Number(p.ramMb) * 1024 * 1024,
        NanoCpus: Math.round((Number(p.cpuPercent) / 100) * 1_000_000_000),
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    await container.start();
    cb({ ok: true, data: { containerId: container.id, status: 'running' } });
  } catch (err) {
    cb({ ok: false, error: err instanceof Error ? err.message : 'Remote mc:create failed' });
  }
});

socket.on('mc:power', async (p, cb) => {
  try {
    const container = docker.getContainer(p.containerName);
    if (p.action === 'start') await container.start();
    else if (p.action === 'stop') await container.stop({ t: 10 });
    else if (p.action === 'restart') await container.restart({ t: 10 });
    else if (p.action === 'kill') await container.kill();
    else if (p.action === 'delete') {
      await container.stop({ t: 5 }).catch(() => {});
      await container.remove({ force: true }).catch(() => {});
    }
    cb({ ok: true, data: { status: p.action === 'stop' || p.action === 'kill' ? 'stopped' : p.action === 'delete' ? 'deleted' : 'running' } });
  } catch (err) {
    cb({ ok: false, error: err instanceof Error ? err.message : 'Remote mc:power failed' });
  }
});

socket.on('incus:create', async (p, cb) => {
  try {
    const args = [
      'launch',
      p.image,
      p.instanceName,
      ...(p.type === 'vm' ? ['--vm'] : []),
      '-c', \`limits.cpu=\${p.vcpu}\`,
      '-c', \`limits.memory=\${p.ramMb}MB\`,
      '-d', \`root,size=\${p.diskGb}GB\`,
    ];
    await execFileAsync('incus', args, { timeout: 120000 });
    cb({ ok: true, data: { status: 'running' } });
  } catch (err) {
    cb({ ok: false, error: err instanceof Error ? err.message : 'Remote incus:create failed' });
  }
});

socket.on('incus:power', async (p, cb) => {
  try {
    if (p.action === 'delete') {
      await execFileAsync('incus', ['delete', p.instanceName, '--force'], { timeout: 20000 });
    } else {
      await execFileAsync('incus', [p.action, p.instanceName], { timeout: 25000 });
    }
    cb({ ok: true, data: { status: p.action === 'stop' ? 'stopped' : p.action === 'delete' ? 'deleted' : 'running' } });
  } catch (err) {
    cb({ ok: false, error: err instanceof Error ? err.message : 'Remote incus:power failed' });
  }
});
`;
}
