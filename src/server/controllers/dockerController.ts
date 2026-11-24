import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as AdmZipNs from 'adm-zip';
import type * as ArchiverNs from 'archiver';
import Docker from 'dockerode';
import type { Response } from 'express';
import * as tar from 'tar';
import {
  deleteBackupFromCloud,
  downloadBackupFromCloud,
  getCloudConfig,
  isCloudConfigured,
  uploadBackupToCloud,
} from '../cloudStorage.js';
import { db, getDataDir, recordAuditLog } from '../db.js';
import {
  getUserQuotaSummary,
  isValidPort,
  isValidVersion,
  MC_PLAYER_REGEX,
  MINECRAFT_SOFTWARE_LIST,
  resolveConfinedPath,
  sanitizeDisplayName,
  slugifyContainerName,
  type UserRole,
} from '../security.js';
import { sendDiscordAlert } from '../webhook.js';
import {
  buildDockerPortConfig,
  listServerAllocations,
  resolvePrimaryAllocationCandidate,
  syncServerPropertiesPort,
  type AllocationRow,
} from './allocationController.js';
import { dispatchNodeCommand, getNodeById } from './nodeController.js';

const require = createRequire(import.meta.url);
const archiver = require('archiver') as (
  format: 'zip',
  options?: ArchiverNs.ArchiverOptions
) => ArchiverNs.Archiver;
const AdmZip = require('adm-zip') as new (
  fileNameOrRawData?: string | Buffer
) => AdmZipNs;

export const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
});

export interface MinecraftServerRow {
  id: number;
  name: string;
  container_name: string;
  container_id: string | null;
  software: string;
  version: string;
  ram_mb: number;
  cpu_percent: number;
  disk_mb: number;
  port: number;
  max_allocations?: number;
  primary_ip?: string | null;
  primary_ip_alias?: string | null;
  allocations_count?: number;
  eula_accepted: number;
  status: string;
  is_suspended: number;
  owner_id: number | null;
  owner_username?: string;
  node_id?: number;
  node_name?: string;
  node_location?: string;
  data_dir: string;
  created_at: string;
}

export async function isDockerReady(): Promise<boolean> {
  try {
    await Promise.race([
      docker.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function syncMinecraftStatuses(viewer?: {
  id: number;
  role: UserRole;
}): Promise<MinecraftServerRow[]> {
  let servers: MinecraftServerRow[];

  if (!viewer || viewer.role === 'owner' || viewer.role === 'admin') {
    servers = db
      .prepare(
        `SELECT ms.*, u.username AS owner_username,
                n.name AS node_name, n.location AS node_location,
                pa.ip AS primary_ip, pa.ip_alias AS primary_ip_alias,
                (SELECT COUNT(*) FROM allocations al WHERE al.server_id = ms.id) AS allocations_count
         FROM minecraft_servers ms
         LEFT JOIN users u ON u.id = ms.owner_id
         LEFT JOIN nodes n ON n.id = ms.node_id
         LEFT JOIN allocations pa ON pa.server_id = ms.id AND pa.is_primary = 1
         ORDER BY ms.created_at DESC`
      )
      .all() as MinecraftServerRow[];
  } else {
    servers = db
      .prepare(
        `SELECT DISTINCT ms.*, u.username AS owner_username,
                n.name AS node_name, n.location AS node_location,
                pa.ip AS primary_ip, pa.ip_alias AS primary_ip_alias,
                (SELECT COUNT(*) FROM allocations al WHERE al.server_id = ms.id) AS allocations_count
         FROM minecraft_servers ms
         LEFT JOIN users u ON u.id = ms.owner_id
         LEFT JOIN nodes n ON n.id = ms.node_id
         LEFT JOIN allocations pa ON pa.server_id = ms.id AND pa.is_primary = 1
         LEFT JOIN server_subusers ss ON ss.server_id = ms.id
         WHERE ms.owner_id = ? OR ss.user_id = ?
         ORDER BY ms.created_at DESC`
      )
      .all(viewer.id, viewer.id) as MinecraftServerRow[];
  }

  const dockerUp = await isDockerReady();
  if (!dockerUp) {
    return servers;
  }

  for (const srv of servers) {
    if (srv.node_id && srv.node_id !== 1) continue;
    try {
      const container = docker.getContainer(srv.container_name);
      const info = await container.inspect();
      const nextStatus = info.State.Running
        ? 'running'
        : info.State.Restarting
        ? 'restarting'
        : 'stopped';
      if (nextStatus !== srv.status || info.Id !== srv.container_id) {
        db.prepare('UPDATE minecraft_servers SET status = ?, container_id = ? WHERE id = ?').run(
          nextStatus,
          info.Id,
          srv.id
        );
        srv.status = nextStatus;
        srv.container_id = info.Id;
      }
    } catch {
      if (srv.status === 'running') {
        db.prepare('UPDATE minecraft_servers SET status = ? WHERE id = ?').run('stopped', srv.id);
        srv.status = 'stopped';
      }
    }
  }

  return servers;
}

function initializeServerDirectory(
  serverDir: string,
  software: string,
  name: string,
  eulaAccepted: boolean,
  primaryPort = 25565
): void {
  fs.mkdirSync(serverDir, { recursive: true });
  const addonFolder = software === 'FABRIC' || software === 'FORGE' ? 'mods' : 'plugins';
  fs.mkdirSync(path.join(serverDir, addonFolder), { recursive: true });

  const eulaPath = path.join(serverDir, 'eula.txt');
  if (!fs.existsSync(eulaPath)) {
    fs.writeFileSync(
      eulaPath,
      `# Generated by FB BAHI Panel\neula=${eulaAccepted ? 'true' : 'false'}\n`,
      'utf8'
    );
  }

  const propsPath = path.join(serverDir, 'server.properties');
  if (!fs.existsSync(propsPath)) {
    fs.writeFileSync(
      propsPath,
      [
        '# Minecraft server properties',
        `motd=${name}`,
        `server-port=${primaryPort}`,
        'max-players=20',
        'online-mode=true',
        'difficulty=normal',
        'gamemode=survival',
        'view-distance=10',
        'pvp=true',
        'allow-flight=false',
        'enable-command-block=false',
        'white-list=false',
        'spawn-protection=16',
        'enable-rcon=false',
        '',
      ].join('\n'),
      'utf8'
    );
  } else {
    syncServerPropertiesPort(serverDir, primaryPort);
  }
}

async function pullImageIfNeeded(image: string): Promise<void> {
  const images = await docker.listImages({ filters: { reference: [image] } });
  if (images.length > 0) return;

  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (progressErr: Error | null) => {
        if (progressErr) return reject(progressErr);
        resolve();
      });
    });
  });
}

export async function createMinecraftServer(params: {
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
  ownerId: number;
  nodeId?: number;
  enforceQuota: boolean;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ server: MinecraftServerRow; dockerProvisioned: boolean; note?: string }> {
  const displayName = sanitizeDisplayName(params.name);
  if (!displayName || displayName.length < 2) {
    throw new Error('Server name must be at least 2 characters.');
  }

  const software = String(params.software || '').toUpperCase();
  if (!MINECRAFT_SOFTWARE_LIST.includes(software as (typeof MINECRAFT_SOFTWARE_LIST)[number])) {
    throw new Error('Unsupported Minecraft server software.');
  }

  if (!isValidVersion(params.version)) {
    throw new Error('Invalid Minecraft version format.');
  }

  const ramMb = Number(params.ramMb);
  if (!Number.isInteger(ramMb) || ramMb < 512 || ramMb > 65536) {
    throw new Error('RAM limit must be between 512 MB and 65536 MB.');
  }

  const cpuPercent = Number(params.cpuPercent);
  if (!Number.isInteger(cpuPercent) || cpuPercent < 25 || cpuPercent > 1600) {
    throw new Error('CPU limit must be between 25% and 1600%.');
  }

  const diskMb = Number(params.diskMb ?? 10240);
  if (!Number.isInteger(diskMb) || diskMb < 1024 || diskMb > 512000) {
    throw new Error('Disk limit must be between 1024 MB and 512000 MB.');
  }

  if (!params.eulaAccepted) {
    throw new Error('You must accept the Minecraft EULA to deploy a server.');
  }

  // Enforce Resource Quota for user accounts
  if (params.enforceQuota) {
    const quota = getUserQuotaSummary(params.ownerId);
    if (quota.used.mcServers + 1 > quota.limits.maxMcServers) {
      throw new Error(
        `Quota exceeded: Maximum Minecraft servers (${quota.limits.maxMcServers}) reached.`
      );
    }
    if (quota.used.ramMb + ramMb > quota.limits.maxRamMb) {
      throw new Error(
        `Quota exceeded: Requested ${ramMb} MB RAM exceeds remaining budget (${Math.max(
          0,
          quota.limits.maxRamMb - quota.used.ramMb
        )} MB free of ${quota.limits.maxRamMb} MB).`
      );
    }
    if (quota.used.cpuPercent + cpuPercent > quota.limits.maxCpuPercent) {
      throw new Error(
        `Quota exceeded: Requested ${cpuPercent}% CPU exceeds remaining budget (${Math.max(
          0,
          quota.limits.maxCpuPercent - quota.used.cpuPercent
        )}% free).`
      );
    }
    const addDiskGb = Math.ceil(diskMb / 1024);
    if (quota.used.diskGb + addDiskGb > quota.limits.maxDiskGb) {
      throw new Error(
        `Quota exceeded: Disk limit (${quota.limits.maxDiskGb} GB) would be exceeded.`
      );
    }
  }

  const targetNodeId = params.nodeId ? Number(params.nodeId) : 1;
  const targetNode = getNodeById(targetNodeId);
  if (!targetNode) {
    throw new Error('Selected target VPS node does not exist.');
  }

  const primaryCandidate = resolvePrimaryAllocationCandidate({
    nodeId: targetNode.id,
    primaryAllocationId: params.primaryAllocationId,
    fallbackPort: params.port,
  });
  const primaryPort = primaryCandidate.port;
  if (!isValidPort(primaryPort)) {
    throw new Error('Primary port must be an integer between 1024 and 65535.');
  }

  const extraIds = Array.from(
    new Set(
      (params.additionalAllocationIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0 && id !== primaryCandidate.existingAllocation?.id)
    )
  );

  const additionalAllocations: AllocationRow[] = [];
  for (const extraId of extraIds) {
    const row = db
      .prepare('SELECT * FROM allocations WHERE id = ? AND node_id = ?')
      .get(extraId, targetNode.id) as AllocationRow | undefined;
    if (!row) {
      throw new Error('Additional allocation does not belong to the selected VPS node.');
    }
    if (row.server_id !== null) {
      throw new Error(`Allocation ${row.ip}:${row.port} is already assigned.`);
    }
    additionalAllocations.push(row);
  }

  const dockerAllocations = [
    {
      ip: primaryCandidate.ip,
      port: primaryPort,
      protocol: primaryCandidate.existingAllocation?.protocol || 'TCP/UDP',
    },
    ...additionalAllocations.map((a) => ({ ip: a.ip, port: a.port, protocol: a.protocol })),
  ];
  const { ExposedPorts, PortBindings } = buildDockerPortConfig(dockerAllocations);

  const containerName = slugifyContainerName(displayName, 'mc');
  const serverDir = path.join(getDataDir(), 'mc', containerName);
  initializeServerDirectory(serverDir, software, displayName, params.eulaAccepted, primaryPort);

  let containerId: string | null = null;
  let initialStatus = 'stopped';
  let dockerProvisioned = false;
  let note: string | undefined;

  if (targetNode.is_local === 0) {
    const remoteResult = await dispatchNodeCommand<{ containerId?: string; status?: string }>(
      targetNode.id,
      'mc:create',
      {
        containerName,
        software,
        version: params.version,
        ramMb,
        cpuPercent,
        port: primaryPort,
        allocations: dockerAllocations,
        eulaAccepted: params.eulaAccepted,
      },
      60000
    );
    containerId = remoteResult.containerId || null;
    initialStatus = remoteResult.status || 'running';
    dockerProvisioned = true;
  } else {
    const dockerUp = await isDockerReady();
    if (dockerUp) {
      const image = 'itzg/minecraft-server:latest';
      await pullImageIfNeeded(image);

      const container = await docker.createContainer({
        Image: image,
        name: containerName,
        Tty: true,
        OpenStdin: true,
        Env: [
          `EULA=${params.eulaAccepted ? 'TRUE' : 'FALSE'}`,
          `TYPE=${software}`,
          `VERSION=${params.version}`,
          `MEMORY=${ramMb}M`,
          `SERVER_NAME=${displayName}`,
          `SERVER_PORT=${primaryPort}`,
        ],
        ExposedPorts,
        HostConfig: {
          Binds: [`${serverDir}:/data`],
          PortBindings,
          Memory: ramMb * 1024 * 1024,
          NanoCpus: Math.round((cpuPercent / 100) * 1_000_000_000),
          RestartPolicy: { Name: 'unless-stopped' },
        },
      });
      containerId = container.id;
      await container.start();
      initialStatus = 'running';
      dockerProvisioned = true;
    } else {
      note =
        'Server workspace & configuration created on disk. Connect Docker daemon on Ubuntu/Debian VPS to boot the itzg/minecraft-server container.';
    }
  }

  const insertTx = db.transaction(() => {
    const maxAllocDefault = Math.max(3, 1 + additionalAllocations.length);
    const result = db
      .prepare(
        `INSERT INTO minecraft_servers
         (name, container_name, container_id, software, version, ram_mb, cpu_percent, disk_mb, port, max_allocations, eula_accepted, status, owner_id, node_id, data_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        displayName,
        containerName,
        containerId,
        software,
        params.version,
        ramMb,
        cpuPercent,
        diskMb,
        primaryPort,
        maxAllocDefault,
        params.eulaAccepted ? 1 : 0,
        initialStatus,
        params.ownerId,
        targetNode.id,
        serverDir
      );

    const serverId = Number(result.lastInsertRowid);

    if (primaryCandidate.existingAllocation) {
      const claimRes = db
        .prepare(
          `UPDATE allocations
           SET server_id = ?, is_primary = 1, notes = COALESCE(notes, 'Main Java Port')
           WHERE id = ? AND server_id IS NULL`
        )
        .run(serverId, primaryCandidate.existingAllocation.id);
      if (claimRes.changes === 0) {
        throw new Error('Selected primary allocation was claimed concurrently. Please retry.');
      }
    } else {
      db.prepare(
        `INSERT INTO allocations (node_id, ip, ip_alias, port, protocol, server_id, is_primary, notes)
         VALUES (?, ?, NULL, ?, 'TCP/UDP', ?, 1, 'Main Java Port')`
      ).run(targetNode.id, primaryCandidate.ip, primaryPort, serverId);
    }

    for (const extra of additionalAllocations) {
      db.prepare(
        `UPDATE allocations SET server_id = ?, is_primary = 0 WHERE id = ? AND server_id IS NULL`
      ).run(serverId, extra.id);
    }

    db.prepare(
      `INSERT OR IGNORE INTO port_allocations (resource_type, resource_id, host_port, target_port, protocol, device_name)
       VALUES ('minecraft', ?, ?, ?, 'tcp', ?)`
    ).run(serverId, primaryPort, primaryPort, containerName);

    return serverId;
  });

  const serverId = insertTx();
  const server = db
    .prepare(
      `SELECT ms.*, u.username AS owner_username,
              n.name AS node_name, n.location AS node_location,
              pa.ip AS primary_ip, pa.ip_alias AS primary_ip_alias,
              (SELECT COUNT(*) FROM allocations al WHERE al.server_id = ms.id) AS allocations_count
       FROM minecraft_servers ms
       LEFT JOIN users u ON u.id = ms.owner_id
       LEFT JOIN nodes n ON n.id = ms.node_id
       LEFT JOIN allocations pa ON pa.server_id = ms.id AND pa.is_primary = 1
       WHERE ms.id = ?`
    )
    .get(serverId) as MinecraftServerRow;

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'minecraft.create',
    target: containerName,
    details: `${software} ${params.version} on ${primaryCandidate.ip}:${primaryPort} (${dockerAllocations.length} port(s), ${ramMb}MB RAM, node=${targetNode.name}, owner#${params.ownerId})`,
    ipAddress: params.ipAddress,
  });

  if (initialStatus === 'running') {
    void sendDiscordAlert({
      event: 'start',
      title: `Minecraft Server Deployed: ${displayName}`,
      description: `Container \`${containerName}\` is running on node **${targetNode.name}**.`,
      fields: [
        { name: 'Software', value: `${software} ${params.version}`, inline: true },
        { name: 'Primary Port', value: `${primaryCandidate.ip}:${primaryPort}`, inline: true },
        { name: 'Memory', value: `${ramMb} MB`, inline: true },
      ],
    });
  }

  return { server, dockerProvisioned, note };
}

function portBindingsMatch(
  actual: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | undefined,
  expected: Record<string, Array<{ HostIp: string; HostPort: string }>>
): boolean {
  const actualKeys = Object.keys(actual || {}).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length) return false;
  for (let i = 0; i < expectedKeys.length; i++) {
    const k = expectedKeys[i];
    if (actualKeys[i] !== k) return false;
    const aList = (actual?.[k] || []).map((x) => `${x.HostIp || ''}:${x.HostPort || ''}`).sort();
    const eList = expected[k].map((x) => `${x.HostIp || ''}:${x.HostPort}`).sort();
    if (aList.length !== eList.length) return false;
    for (let j = 0; j < eList.length; j++) {
      if (aList[j] !== eList[j]) return false;
    }
  }
  return true;
}

async function ensureContainerSyncedWithAllocations(srv: MinecraftServerRow): Promise<Docker.Container> {
  const allocs = listServerAllocations(srv.id);
  const effectiveAllocs =
    allocs.length > 0
      ? allocs
      : [{ ip: '0.0.0.0', port: srv.port, protocol: 'TCP/UDP' }];
  const { ExposedPorts, PortBindings } = buildDockerPortConfig(effectiveAllocs);

  const container = docker.getContainer(srv.container_name);
  let needsRecreate = false;

  try {
    const info = await container.inspect();
    const envList = info.Config?.Env || [];
    const hasMatchingServerPort = envList.includes(`SERVER_PORT=${srv.port}`);
    if (!portBindingsMatch(info.HostConfig?.PortBindings, PortBindings) || !hasMatchingServerPort) {
      needsRecreate = true;
    }
    if (!needsRecreate) {
      return container;
    }
    if (info.State.Running) {
      await container.stop({ t: 10 }).catch(() => {});
    }
    await container.remove({ force: true }).catch(() => {});
  } catch {
    needsRecreate = true;
  }

  const image = 'itzg/minecraft-server:latest';
  await pullImageIfNeeded(image);

  const recreated = await docker.createContainer({
    Image: image,
    name: srv.container_name,
    Tty: true,
    OpenStdin: true,
    Env: [
      `EULA=${srv.eula_accepted ? 'TRUE' : 'FALSE'}`,
      `TYPE=${srv.software}`,
      `VERSION=${srv.version}`,
      `MEMORY=${srv.ram_mb}M`,
      `SERVER_NAME=${srv.name}`,
      `SERVER_PORT=${srv.port}`,
    ],
    ExposedPorts,
    HostConfig: {
      Binds: [`${srv.data_dir}:/data`],
      PortBindings,
      Memory: srv.ram_mb * 1024 * 1024,
      NanoCpus: Math.round((srv.cpu_percent / 100) * 1_000_000_000),
      RestartPolicy: { Name: 'unless-stopped' },
    },
  });

  db.prepare('UPDATE minecraft_servers SET container_id = ? WHERE id = ?').run(recreated.id, srv.id);
  return recreated;
}

export async function controlMinecraftServer(params: {
  id: number;
  action: 'start' | 'stop' | 'restart' | 'kill' | 'delete';
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ status: string; deleted?: boolean }> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(params.id) as
    | MinecraftServerRow
    | undefined;
  if (!srv) {
    throw new Error('Minecraft server not found.');
  }

  if (srv.node_id && srv.node_id !== 1) {
    if (params.action === 'delete') {
      await dispatchNodeCommand(srv.node_id, 'mc:power', {
        containerName: srv.container_name,
        action: 'delete',
      }).catch(() => {});

      if (fs.existsSync(srv.data_dir)) {
        fs.rmSync(srv.data_dir, { recursive: true, force: true });
      }
      db.transaction(() => {
        db.prepare(
          'UPDATE allocations SET server_id = NULL, is_primary = 0, notes = NULL WHERE server_id = ?'
        ).run(srv.id);
        db.prepare(
          `DELETE FROM port_allocations WHERE resource_type = 'minecraft' AND resource_id = ?`
        ).run(srv.id);
        db.prepare('DELETE FROM minecraft_servers WHERE id = ?').run(srv.id);
      })();

      recordAuditLog({
        userId: params.userId,
        username: params.username,
        action: 'minecraft.delete',
        target: srv.container_name,
        details: `Deleted remote server '${srv.name}' (node#${srv.node_id})`,
        ipAddress: params.ipAddress,
      });
      return { status: 'deleted', deleted: true };
    }

    const remoteRes = await dispatchNodeCommand<{ status?: string }>(srv.node_id, 'mc:power', {
      containerName: srv.container_name,
      action: params.action,
      port: srv.port,
      allocations: listServerAllocations(srv.id).map((a) => ({
        ip: a.ip,
        port: a.port,
        protocol: a.protocol,
      })),
    });
    const nextStatus =
      remoteRes.status ||
      (params.action === 'stop' || params.action === 'kill' ? 'stopped' : 'running');
    db.prepare('UPDATE minecraft_servers SET status = ? WHERE id = ?').run(nextStatus, srv.id);

    recordAuditLog({
      userId: params.userId,
      username: params.username,
      action: `minecraft.${params.action}`,
      target: srv.container_name,
      details: `Remote power action on node#${srv.node_id}: ${params.action}`,
      ipAddress: params.ipAddress,
    });

    void sendDiscordAlert({
      event: params.action === 'kill' ? 'crash' : params.action === 'stop' ? 'stop' : 'start',
      title: `Remote Server ${params.action.toUpperCase()}: ${srv.name}`,
      description: `Minecraft server \`${srv.container_name}\` (${params.action}) by ${params.username}.`,
    });

    return { status: nextStatus };
  }

  const dockerUp = await isDockerReady();

  if (params.action === 'delete') {
    if (dockerUp) {
      try {
        const container = docker.getContainer(srv.container_name);
        try {
          await container.stop({ t: 5 });
        } catch {
          // Container may already be stopped
        }
        await container.remove({ force: true });
      } catch {
        // Container might not exist on daemon
      }
    }

    if (fs.existsSync(srv.data_dir)) {
      fs.rmSync(srv.data_dir, { recursive: true, force: true });
    }

    db.transaction(() => {
      db.prepare(
        'UPDATE allocations SET server_id = NULL, is_primary = 0, notes = NULL WHERE server_id = ?'
      ).run(srv.id);
      db.prepare(
        `DELETE FROM port_allocations WHERE resource_type = 'minecraft' AND resource_id = ?`
      ).run(srv.id);
      db.prepare('DELETE FROM minecraft_servers WHERE id = ?').run(srv.id);
    })();

    recordAuditLog({
      userId: params.userId,
      username: params.username,
      action: 'minecraft.delete',
      target: srv.container_name,
      details: `Deleted server '${srv.name}' and released port allocations`,
      ipAddress: params.ipAddress,
    });

    return { status: 'deleted', deleted: true };
  }

  if (!dockerUp) {
    throw new Error(
      'Docker daemon is unavailable on this host (/var/run/docker.sock). Run on a Linux VPS with Docker installed to start, stop, or kill live containers.'
    );
  }

  let nextStatus = srv.status;

  if (params.action === 'start') {
    const container = await ensureContainerSyncedWithAllocations(srv);
    const info = await container.inspect().catch(() => null);
    if (!info?.State?.Running) {
      await container.start();
    }
    nextStatus = 'running';
    void sendDiscordAlert({
      event: 'start',
      title: `Server Started: ${srv.name}`,
      description: `Minecraft server \`${srv.container_name}\` started by ${params.username}.`,
    });
  } else if (params.action === 'stop') {
    const container = docker.getContainer(srv.container_name);
    await container.stop({ t: 10 });
    nextStatus = 'stopped';
    void sendDiscordAlert({
      event: 'stop',
      title: `Server Stopped: ${srv.name}`,
      description: `Minecraft server \`${srv.container_name}\` stopped by ${params.username}.`,
    });
  } else if (params.action === 'restart') {
    const syncedContainer = await ensureContainerSyncedWithAllocations(srv);
    const info = await syncedContainer.inspect().catch(() => null);
    if (!info?.State?.Running) {
      await syncedContainer.start();
    } else {
      await syncedContainer.restart({ t: 10 });
    }
    nextStatus = 'running';
    void sendDiscordAlert({
      event: 'start',
      title: `Server Restarted: ${srv.name}`,
      description: `Minecraft server \`${srv.container_name}\` restarted by ${params.username}.`,
    });
  } else if (params.action === 'kill') {
    const container = docker.getContainer(srv.container_name);
    await container.kill();
    nextStatus = 'stopped';
    void sendDiscordAlert({
      event: 'crash',
      title: `Server Force Killed: ${srv.name}`,
      description: `Minecraft server \`${srv.container_name}\` was force-killed by ${params.username}.`,
    });
  }

  db.prepare('UPDATE minecraft_servers SET status = ? WHERE id = ?').run(nextStatus, srv.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: `minecraft.${params.action}`,
    target: srv.container_name,
    details: `Power action: ${params.action}`,
    ipAddress: params.ipAddress,
  });

  return { status: nextStatus };
}

export async function getMinecraftLogs(id: number, tail = 200): Promise<string[]> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(id) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const dockerUp = await isDockerReady();
  if (!dockerUp) {
    return [
      `[FB BAHI Panel] Server workspace path: ${srv.data_dir}`,
      `[FB BAHI Panel] Configured runtime: itzg/minecraft-server (${srv.software} ${srv.version})`,
      `[FB BAHI Panel] Docker daemon is not running on this host (/var/run/docker.sock).`,
      `[FB BAHI Panel] Deploy on Ubuntu/Debian VPS using install.sh for live container console streaming.`,
    ];
  }

  try {
    const container = docker.getContainer(srv.container_name);
    const buffer = (await container.logs({
      stdout: true,
      stderr: true,
      tail,
    })) as Buffer;
    const cleaned = buffer.toString('utf8').replace(/[\x00-\x08\x0b-\x1a]/g, '');
    return cleaned.split('\n').filter(Boolean);
  } catch (err) {
    return [`[Console Error] ${err instanceof Error ? err.message : 'Unable to fetch logs'}`];
  }
}

export async function sendMinecraftCommand(id: number, command: string): Promise<string> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(id) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const cleanCmd = command.replace(/[\r\n]/g, '').trim();
  if (!cleanCmd) return '';

  const dockerUp = await isDockerReady();
  if (!dockerUp) {
    throw new Error('Docker daemon is unavailable on this host.');
  }

  const container = docker.getContainer(srv.container_name);
  const exec = await container.exec({
    Cmd: ['rcon-cli', cleanCmd],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: false, stdin: false });
  return await new Promise<string>((resolve) => {
    let out = '';
    const timer = setTimeout(() => resolve(out), 2500);
    stream.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8').replace(/[\x00-\x08\x0b-\x1a]/g, '');
    });
    stream.on('end', () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
}

export function getMinecraftProperties(id: number): Record<string, string> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(id) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const propsPath = resolveConfinedPath(srv.data_dir, 'server.properties');
  if (!fs.existsSync(propsPath)) {
    initializeServerDirectory(srv.data_dir, srv.software, srv.name, Boolean(srv.eula_accepted));
  }
  const content = fs.readFileSync(propsPath, 'utf8');
  const map: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1);
    map[key] = val;
  }
  return map;
}

export function updateMinecraftProperties(
  id: number,
  updates: Record<string, string | number | boolean>
): Record<string, string> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(id) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const allowedKeys = new Set([
    'motd',
    'gamemode',
    'difficulty',
    'max-players',
    'online-mode',
    'view-distance',
    'pvp',
    'allow-flight',
    'enable-command-block',
    'white-list',
    'spawn-protection',
  ]);

  const cleanUpdates = new Map<string, string>();
  for (const [key, val] of Object.entries(updates)) {
    if (!allowedKeys.has(key)) continue;
    cleanUpdates.set(key, String(val).replace(/[\r\n]/g, ' ').slice(0, 200));
  }

  const propsPath = resolveConfinedPath(srv.data_dir, 'server.properties');
  const existing = fs.existsSync(propsPath) ? fs.readFileSync(propsPath, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : ['# Minecraft server properties'];
  const seen = new Set<string>();

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = line.indexOf('=');
    if (eq === -1) return line;
    const k = line.slice(0, eq).trim();
    if (cleanUpdates.has(k)) {
      seen.add(k);
      return `${k}=${cleanUpdates.get(k)}`;
    }
    return line;
  });

  for (const [k, v] of cleanUpdates.entries()) {
    if (!seen.has(k)) {
      nextLines.push(`${k}=${v}`);
    }
  }

  fs.writeFileSync(propsPath, nextLines.join('\n').replace(/\n*$/, '\n'), 'utf8');
  return getMinecraftProperties(id);
}

export async function getMinecraftPlayers(id: number): Promise<{
  online: Array<{ name: string; isOp: boolean }>;
  ops: string[];
  banned: string[];
  dockerAvailable: boolean;
}> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(id) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const readJsonNames = (rel: string): string[] => {
    try {
      const p = resolveConfinedPath(srv.data_dir, rel);
      if (!fs.existsSync(p)) return [];
      const arr = JSON.parse(fs.readFileSync(p, 'utf8')) as Array<{ name?: string }>;
      return Array.isArray(arr) ? arr.map((x) => x.name || '').filter(Boolean) : [];
    } catch {
      return [];
    }
  };

  const ops = readJsonNames('ops.json');
  const banned = readJsonNames('banned-players.json');
  const opsSet = new Set(ops.map((n) => n.toLowerCase()));

  const dockerUp = await isDockerReady();
  const onlineNames = new Set<string>();

  if (dockerUp && srv.status === 'running') {
    try {
      const rconOut = await sendMinecraftCommand(id, 'list');
      const match = rconOut.match(/players online:\s*(.*)$/i);
      if (match && match[1]) {
        for (const p of match[1].split(',').map((s) => s.trim()).filter(Boolean)) {
          if (MC_PLAYER_REGEX.test(p)) onlineNames.add(p);
        }
      }
    } catch {
      // Fallback to recent log scan if RCON disabled
      const logs = await getMinecraftLogs(id, 300);
      for (const line of logs) {
        const joinMatch = line.match(/:\s+([a-zA-Z0-9_]{3,16}) joined the game/);
        if (joinMatch) onlineNames.add(joinMatch[1]);
        const leaveMatch = line.match(/:\s+([a-zA-Z0-9_]{3,16}) left the game/);
        if (leaveMatch) onlineNames.delete(leaveMatch[1]);
      }
    }
  }

  return {
    online: Array.from(onlineNames).map((name) => ({
      name,
      isOp: opsSet.has(name.toLowerCase()),
    })),
    ops,
    banned,
    dockerAvailable: dockerUp,
  };
}

export async function runPlayerAction(params: {
  serverId: number;
  playerName: string;
  action: 'kick' | 'ban' | 'pardon' | 'op' | 'deop';
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ executed: boolean; output: string }> {
  if (!MC_PLAYER_REGEX.test(params.playerName)) {
    throw new Error('Invalid Minecraft username (3-16 alphanumeric/underscore chars).');
  }

  const cmdMap: Record<typeof params.action, string> = {
    kick: `kick ${params.playerName}`,
    ban: `ban ${params.playerName}`,
    pardon: `pardon ${params.playerName}`,
    op: `op ${params.playerName}`,
    deop: `deop ${params.playerName}`,
  };

  const output = await sendMinecraftCommand(params.serverId, cmdMap[params.action]);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: `minecraft.player_${params.action}`,
    target: `server#${params.serverId}`,
    details: `${params.action.toUpperCase()} player ${params.playerName}`,
    ipAddress: params.ipAddress,
  });

  return { executed: true, output };
}

export async function getMinecraftContainerMetrics(id: number): Promise<{
  cpuPercent: number;
  ramUsedMb: number;
  ramLimitMb: number;
  live: boolean;
}> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(id) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const dockerUp = await isDockerReady();
  if (!dockerUp || srv.status !== 'running') {
    return {
      cpuPercent: 0,
      ramUsedMb: 0,
      ramLimitMb: srv.ram_mb,
      live: false,
    };
  }

  try {
    const container = docker.getContainer(srv.container_name);
    const stats = (await container.stats({ stream: false })) as {
      cpu_stats?: {
        cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
        system_cpu_usage?: number;
        online_cpus?: number;
      };
      precpu_stats?: {
        cpu_usage?: { total_usage?: number };
        system_cpu_usage?: number;
      };
      memory_stats?: { usage?: number };
    };

    const cpuDelta =
      (stats.cpu_stats?.cpu_usage?.total_usage || 0) -
      (stats.precpu_stats?.cpu_usage?.total_usage || 0);
    const sysDelta =
      (stats.cpu_stats?.system_cpu_usage || 0) -
      (stats.precpu_stats?.system_cpu_usage || 0);
    const cpuCount =
      stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
    const cpuPercent =
      sysDelta > 0 && cpuDelta > 0
        ? Number(((cpuDelta / sysDelta) * cpuCount * 100).toFixed(1))
        : 0;
    const ramUsedMb = Math.round((stats.memory_stats?.usage || 0) / (1024 * 1024));

    return {
      cpuPercent,
      ramUsedMb,
      ramLimitMb: srv.ram_mb,
      live: true,
    };
  } catch {
    return {
      cpuPercent: 0,
      ramUsedMb: 0,
      ramLimitMb: srv.ram_mb,
      live: false,
    };
  }
}

export function listServerFiles(id: number, relPath = ''): Array<{
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(id) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  fs.mkdirSync(srv.data_dir, { recursive: true });
  const targetDir = resolveConfinedPath(srv.data_dir, relPath);
  if (!fs.existsSync(targetDir)) {
    throw new Error('Directory does not exist.');
  }
  const stat = fs.statSync(targetDir);
  if (!stat.isDirectory()) {
    throw new Error('Target path is not a directory.');
  }

  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  return entries
    .map((entry) => {
      const full = path.join(targetDir, entry.name);
      const entryStat = fs.statSync(full);
      const itemRel = path.relative(srv.data_dir, full).replace(/\\/g, '/');
      return {
        name: entry.name,
        path: itemRel,
        isDirectory: entry.isDirectory(),
        size: entry.isDirectory() ? 0 : entryStat.size,
        modifiedAt: entryStat.mtime.toISOString(),
      };
    })
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export function readServerFile(id: number, relPath: string): string {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(id) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const targetFile = resolveConfinedPath(srv.data_dir, relPath);
  if (!fs.existsSync(targetFile)) {
    throw new Error('File not found.');
  }
  const stat = fs.statSync(targetFile);
  if (stat.isDirectory()) {
    throw new Error('Cannot read a directory.');
  }
  if (stat.size > 2 * 1024 * 1024) {
    throw new Error('File exceeds 2 MB inline editor limit.');
  }
  return fs.readFileSync(targetFile, 'utf8');
}

export function writeServerFile(id: number, relPath: string, content: string): void {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(id) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const targetFile = resolveConfinedPath(srv.data_dir, relPath);
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, content, 'utf8');
}

export function createServerEntry(id: number, relPath: string, type: 'file' | 'folder'): void {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(id) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const target = resolveConfinedPath(srv.data_dir, relPath);
  if (fs.existsSync(target)) {
    throw new Error('An item with that name already exists.');
  }
  if (type === 'folder') {
    fs.mkdirSync(target, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '', 'utf8');
  }
}

export function deleteServerEntry(id: number, relPath: string): void {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(id) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const target = resolveConfinedPath(srv.data_dir, relPath);
  if (target === path.resolve(srv.data_dir)) {
    throw new Error('Cannot delete server root directory.');
  }
  if (!fs.existsSync(target)) {
    throw new Error('File or folder not found.');
  }
  fs.rmSync(target, { recursive: true, force: true });
}

export function streamServerBackupZip(id: number, res: Response): void {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(id) as
    | MinecraftServerRow
    | undefined;
  if (!srv) {
    res.status(404).json({ error: 'Minecraft server not found.' });
    return;
  }

  fs.mkdirSync(srv.data_dir, { recursive: true });
  const archive = archiver('zip', { zlib: { level: 6 } });
  const safeFileName = `${srv.container_name}-backup-${Date.now()}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);

  res.on('close', () => {
    if (!res.writableEnded) {
      try {
        archive.abort();
      } catch {
        // ignore abort error
      }
    }
  });

  archive.on('error', (err: Error) => {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else if (!res.writableEnded) {
      res.destroy(err);
    }
  });

  archive.pipe(res);
  archive.glob('**/*', {
    cwd: srv.data_dir,
    ignore: ['backups/**'],
  });
  void archive.finalize();
}

export interface MinecraftBackupRow {
  id: number;
  server_id: number;
  name: string;
  filename: string;
  size_bytes: number;
  backup_type: 'manual' | 'scheduled' | 'pre_restore';
  cloud_provider?: string;
  cloud_key?: string;
  created_by: string;
  created_at: string;
  exists_on_disk?: boolean;
}

export async function createMinecraftBackup(params: {
  serverId: number;
  name?: string;
  backupType?: 'manual' | 'scheduled' | 'pre_restore';
  createdBy: string;
  userId?: number | null;
  ipAddress?: string;
  retentionCount?: number;
}): Promise<MinecraftBackupRow> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(params.serverId) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  fs.mkdirSync(srv.data_dir, { recursive: true });
  const backupsDir = path.join(srv.data_dir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });

  const backupType = params.backupType || 'manual';
  const cleanLabel =
    sanitizeDisplayName(params.name) ||
    (backupType === 'pre_restore'
      ? 'Pre-Restore Safety Backup'
      : backupType === 'scheduled'
      ? 'Scheduled Backup'
      : 'Manual Snapshot');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = cleanLabel
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  const filename = `${slug || 'backup'}-${stamp}.tar.gz`;
  const destTarGz = resolveConfinedPath(backupsDir, filename);

  await tar.c(
    {
      gzip: true,
      file: destTarGz,
      cwd: srv.data_dir,
      filter: (entryPath: string) => {
        const clean = entryPath.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
        return clean !== 'backups' && !clean.startsWith('backups/');
      },
    },
    ['.']
  );

  const stat = fs.statSync(destTarGz);
  let cloudProvider = 'local';
  let cloudKey = '';

  const cloudCfg = getCloudConfig();
  if (isCloudConfigured(cloudCfg) && cloudCfg.autoUpload) {
    try {
      const uploaded = await uploadBackupToCloud(destTarGz, `mc/${srv.container_name}/${filename}`);
      cloudProvider = uploaded.provider;
      cloudKey = uploaded.key;
    } catch {
      // Retain local .tar.gz backup even if remote cloud offload fails temporarily
    }
  }

  const res = db
    .prepare(
      `INSERT INTO minecraft_backups
       (server_id, name, filename, size_bytes, backup_type, created_by, cloud_provider, cloud_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      srv.id,
      cleanLabel,
      filename,
      stat.size,
      backupType,
      params.createdBy,
      cloudProvider,
      cloudKey
    );

  if (backupType === 'scheduled' && params.retentionCount && params.retentionCount > 0) {
    const oldScheduled = db
      .prepare(
        `SELECT id, filename, cloud_provider, cloud_key FROM minecraft_backups
         WHERE server_id = ? AND backup_type = 'scheduled'
         ORDER BY id DESC LIMIT -1 OFFSET ?`
      )
      .all(srv.id, params.retentionCount) as Array<{
      id: number;
      filename: string;
      cloud_provider?: string;
      cloud_key?: string;
    }>;

    for (const old of oldScheduled) {
      try {
        const oldPath = resolveConfinedPath(backupsDir, old.filename);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch {
        // ignore missing file
      }
      if (old.cloud_key) {
        await deleteBackupFromCloud(old.cloud_provider || 'none', old.cloud_key);
      }
      db.prepare('DELETE FROM minecraft_backups WHERE id = ?').run(old.id);
    }
  }

  recordAuditLog({
    userId: params.userId ?? null,
    username: params.createdBy,
    action:
      backupType === 'scheduled' ? 'minecraft.scheduled_backup' : 'minecraft.backup_create',
    target: srv.container_name,
    details: `Created ${backupType} .tar.gz backup '${cleanLabel}' (${filename}, ${stat.size} bytes${
      cloudProvider !== 'local' ? `, cloud=${cloudProvider}` : ''
    })`,
    ipAddress: params.ipAddress || '127.0.0.1',
  });

  const created = db
    .prepare('SELECT * FROM minecraft_backups WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as MinecraftBackupRow;

  return { ...created, exists_on_disk: true };
}

export function listMinecraftBackups(serverId: number): MinecraftBackupRow[] {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(serverId) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const backupsDir = path.join(srv.data_dir, 'backups');
  if (fs.existsSync(backupsDir)) {
    const existingRows = db
      .prepare('SELECT filename FROM minecraft_backups WHERE server_id = ?')
      .all(serverId) as Array<{ filename: string }>;
    const known = new Set(existingRows.map((r) => r.filename));

    for (const entry of fs.readdirSync(backupsDir)) {
      if ((!entry.endsWith('.tar.gz') && !entry.endsWith('.zip')) || known.has(entry)) continue;
      try {
        const full = resolveConfinedPath(backupsDir, entry);
        const st = fs.statSync(full);
        if (st.isFile()) {
          db.prepare(
            `INSERT INTO minecraft_backups (server_id, name, filename, size_bytes, backup_type, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, 'scheduler', ?)`
          ).run(
            serverId,
            entry.replace(/(\.tar\.gz|\.zip)$/, ''),
            entry,
            st.size,
            entry.startsWith('auto-backup-') ? 'scheduled' : 'manual',
            st.mtime.toISOString()
          );
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }

  const rows = db
    .prepare('SELECT * FROM minecraft_backups WHERE server_id = ? ORDER BY id DESC')
    .all(serverId) as MinecraftBackupRow[];

  return rows.map((r) => {
    let existsOnDisk = false;
    try {
      const p = resolveConfinedPath(backupsDir, r.filename);
      existsOnDisk = fs.existsSync(p);
    } catch {
      existsOnDisk = false;
    }
    return { ...r, exists_on_disk: existsOnDisk };
  });
}

export async function restoreMinecraftBackup(params: {
  serverId: number;
  backupId: number;
  createPreRestore?: boolean;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ restored: boolean; preRestoreBackup?: MinecraftBackupRow; restarted: boolean }> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(params.serverId) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const backup = db
    .prepare('SELECT * FROM minecraft_backups WHERE id = ? AND server_id = ?')
    .get(params.backupId, srv.id) as MinecraftBackupRow | undefined;
  if (!backup) throw new Error('Backup point not found.');

  const backupsDir = path.join(srv.data_dir, 'backups');
  const archivePath = resolveConfinedPath(backupsDir, backup.filename);

  if (!fs.existsSync(archivePath)) {
    if (backup.cloud_key && backup.cloud_provider && backup.cloud_provider !== 'local') {
      await downloadBackupFromCloud(backup.cloud_provider, backup.cloud_key, archivePath);
    } else {
      throw new Error('Backup archive file is missing on disk.');
    }
  }

  const dockerUp = await isDockerReady();
  let wasRunning = false;
  if (dockerUp && (!srv.node_id || srv.node_id === 1)) {
    try {
      const container = docker.getContainer(srv.container_name);
      const info = await container.inspect();
      if (info.State.Running) {
        wasRunning = true;
        await container.stop({ t: 10 });
        db.prepare(`UPDATE minecraft_servers SET status = 'stopped' WHERE id = ?`).run(srv.id);
      }
    } catch {
      // Container may not exist on daemon
    }
  }

  let preRestoreBackup: MinecraftBackupRow | undefined;
  if (params.createPreRestore !== false) {
    preRestoreBackup = await createMinecraftBackup({
      serverId: srv.id,
      name: `Pre-Restore (${backup.name.slice(0, 24)})`,
      backupType: 'pre_restore',
      createdBy: params.username,
      userId: params.userId,
      ipAddress: params.ipAddress,
    });
  }

  if (backup.filename.endsWith('.tar.gz') || backup.filename.endsWith('.tgz')) {
    await tar.t({
      file: archivePath,
      onentry: (entry) => {
        const clean = entry.path
          .replace(/\\/g, '/')
          .replace(/^(\.\/)+/, '')
          .replace(/^\/+/, '');
        if (!clean || clean === '.' || clean === 'backups' || clean.startsWith('backups/')) return;
        resolveConfinedPath(srv.data_dir, clean);
      },
    });

    fs.mkdirSync(srv.data_dir, { recursive: true });
    for (const item of fs.readdirSync(srv.data_dir)) {
      if (item === 'backups') continue;
      fs.rmSync(path.join(srv.data_dir, item), { recursive: true, force: true });
    }

    await tar.x({
      file: archivePath,
      cwd: srv.data_dir,
      strict: true,
      filter: (entryPath: string) => {
        const clean = entryPath.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
        return clean !== 'backups' && !clean.startsWith('backups/');
      },
    });
  } else {
    // Validate all zip entries before removing current workspace contents
    const zip = new AdmZip(archivePath);
    const entries = zip.getEntries();
    for (const entry of entries) {
      const cleanName = entry.entryName.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!cleanName || cleanName === 'backups' || cleanName.startsWith('backups/')) continue;
      resolveConfinedPath(srv.data_dir, cleanName);
    }

    // Wipe workspace contents except backups/
    fs.mkdirSync(srv.data_dir, { recursive: true });
    for (const item of fs.readdirSync(srv.data_dir)) {
      if (item === 'backups') continue;
      fs.rmSync(path.join(srv.data_dir, item), { recursive: true, force: true });
    }

    // Extract confined entries safely
    for (const entry of entries) {
      const cleanName = entry.entryName.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!cleanName || cleanName === 'backups' || cleanName.startsWith('backups/')) continue;
      const dest = resolveConfinedPath(srv.data_dir, cleanName);
      if (entry.isDirectory) {
        fs.mkdirSync(dest, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.getData());
      }
    }
  }

  let restarted = false;
  if (wasRunning && dockerUp) {
    try {
      const container = docker.getContainer(srv.container_name);
      await container.start();
      db.prepare(`UPDATE minecraft_servers SET status = 'running' WHERE id = ?`).run(srv.id);
      restarted = true;
    } catch {
      restarted = false;
    }
  }

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'minecraft.backup_restore',
    target: srv.container_name,
    details: `Restored point-in-time backup '${backup.name}' (${backup.filename})`,
    ipAddress: params.ipAddress,
  });

  return { restored: true, preRestoreBackup, restarted };
}

export async function uploadMinecraftBackupToCloud(params: {
  serverId: number;
  backupId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<MinecraftBackupRow> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(params.serverId) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const backup = db
    .prepare('SELECT * FROM minecraft_backups WHERE id = ? AND server_id = ?')
    .get(params.backupId, srv.id) as MinecraftBackupRow | undefined;
  if (!backup) throw new Error('Backup point not found.');

  const filePath = resolveConfinedPath(path.join(srv.data_dir, 'backups'), backup.filename);
  if (!fs.existsSync(filePath)) {
    throw new Error('Local backup file must exist on disk to upload to cloud.');
  }

  const uploaded = await uploadBackupToCloud(filePath, `mc/${srv.container_name}/${backup.filename}`);
  db.prepare('UPDATE minecraft_backups SET cloud_provider = ?, cloud_key = ? WHERE id = ?').run(
    uploaded.provider,
    uploaded.key,
    backup.id
  );

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'minecraft.backup_cloud_upload',
    target: srv.container_name,
    details: `Offloaded backup '${backup.filename}' to ${uploaded.provider.toUpperCase()}`,
    ipAddress: params.ipAddress,
  });

  const updated = db
    .prepare('SELECT * FROM minecraft_backups WHERE id = ?')
    .get(backup.id) as MinecraftBackupRow;
  return { ...updated, exists_on_disk: true };
}

export async function downloadMinecraftBackupFile(
  serverId: number,
  backupId: number,
  res: Response
): Promise<void> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(serverId) as
    | MinecraftServerRow
    | undefined;
  if (!srv) {
    res.status(404).json({ error: 'Minecraft server not found.' });
    return;
  }

  const backup = db
    .prepare('SELECT * FROM minecraft_backups WHERE id = ? AND server_id = ?')
    .get(backupId, srv.id) as MinecraftBackupRow | undefined;
  if (!backup) {
    res.status(404).json({ error: 'Backup not found.' });
    return;
  }

  const filePath = resolveConfinedPath(path.join(srv.data_dir, 'backups'), backup.filename);
  if (!fs.existsSync(filePath)) {
    if (backup.cloud_key && backup.cloud_provider && backup.cloud_provider !== 'local') {
      await downloadBackupFromCloud(backup.cloud_provider, backup.cloud_key, filePath);
    } else {
      res.status(404).json({ error: 'Backup file missing on disk.' });
      return;
    }
  }

  res.download(filePath, backup.filename, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Backup download failed.' });
    }
  });
}

export async function deleteMinecraftBackup(params: {
  serverId: number;
  backupId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<void> {
  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(params.serverId) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const backup = db
    .prepare('SELECT * FROM minecraft_backups WHERE id = ? AND server_id = ?')
    .get(params.backupId, srv.id) as MinecraftBackupRow | undefined;
  if (!backup) throw new Error('Backup not found.');

  const filePath = resolveConfinedPath(path.join(srv.data_dir, 'backups'), backup.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  if (backup.cloud_key && backup.cloud_provider && backup.cloud_provider !== 'local') {
    await deleteBackupFromCloud(backup.cloud_provider, backup.cloud_key);
  }
  db.prepare('DELETE FROM minecraft_backups WHERE id = ?').run(backup.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'minecraft.backup_delete',
    target: srv.container_name,
    details: `Deleted backup '${backup.name}' (${backup.filename})`,
    ipAddress: params.ipAddress,
  });
}

export interface ModrinthHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  icon_url: string;
  project_type: string;
  categories: string[];
  latest_version?: string;
}

export async function searchModrinthProjects(params: {
  query: string;
  projectType: 'plugin' | 'mod';
  loader?: string;
  gameVersion?: string;
}): Promise<ModrinthHit[]> {
  const facets: string[][] = [[`project_type:${params.projectType}`]];
  if (params.loader) {
    facets.push([`categories:${params.loader.toLowerCase()}`]);
  }
  if (params.gameVersion && isValidVersion(params.gameVersion)) {
    facets.push([`versions:${params.gameVersion}`]);
  }

  const searchUrl = new URL('https://api.modrinth.com/v2/search');
  searchUrl.searchParams.set('query', params.query || '');
  searchUrl.searchParams.set('limit', '18');
  searchUrl.searchParams.set('facets', JSON.stringify(facets));

  const response = await fetch(searchUrl.toString(), {
    headers: { 'User-Agent': 'FB-BAHI-Panel/1.0 (self-hosted)' },
  });

  if (!response.ok) {
    throw new Error(`Modrinth API returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as { hits?: ModrinthHit[] };
  return data.hits || [];
}

export async function installModrinthProject(params: {
  serverId: number;
  projectId: string;
  projectType: 'plugin' | 'mod';
  userId: number;
  username: string;
  ipAddress: string;
}): Promise<{ filename: string; installedPath: string; versionNumber: string }> {
  if (!/^[a-zA-Z0-9_-]{4,32}$/.test(params.projectId)) {
    throw new Error('Invalid Modrinth project ID.');
  }

  const srv = db.prepare('SELECT * FROM minecraft_servers WHERE id = ?').get(params.serverId) as
    | MinecraftServerRow
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const versionsRes = await fetch(
    `https://api.modrinth.com/v2/project/${encodeURIComponent(params.projectId)}/version`,
    {
      headers: { 'User-Agent': 'FB-BAHI-Panel/1.0 (self-hosted)' },
    }
  );
  if (!versionsRes.ok) {
    throw new Error(`Modrinth version lookup failed (HTTP ${versionsRes.status})`);
  }

  const versions = (await versionsRes.json()) as Array<{
    version_number: string;
    game_versions: string[];
    loaders: string[];
    files: Array<{ url: string; filename: string; primary: boolean }>;
  }>;

  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error('No downloadable versions found for this project.');
  }

  const preferredLoader = srv.software.toLowerCase();
  const matched =
    versions.find(
      (v) =>
        v.game_versions.includes(srv.version) &&
        (v.loaders.includes(preferredLoader) || v.loaders.length > 0)
    ) ||
    versions.find((v) => v.game_versions.includes(srv.version)) ||
    versions[0];

  const fileObj = matched.files.find((f) => f.primary) || matched.files[0];
  if (!fileObj || !fileObj.url) {
    throw new Error('No release file found for selected version.');
  }

  const parsedFileUrl = new URL(fileObj.url);
  if (parsedFileUrl.protocol !== 'https:' || parsedFileUrl.hostname !== 'cdn.modrinth.com') {
    throw new Error('Blocked untrusted Modrinth download URL.');
  }

  const safeFileName = path.basename(fileObj.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const targetSubfolder = params.projectType === 'mod' ? 'mods' : 'plugins';
  const destPath = resolveConfinedPath(srv.data_dir, `${targetSubfolder}/${safeFileName}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const jarRes = await fetch(parsedFileUrl.toString(), {
    headers: { 'User-Agent': 'FB-BAHI-Panel/1.0 (self-hosted)' },
  });
  if (!jarRes.ok) {
    throw new Error(`Failed to download artifact (HTTP ${jarRes.status})`);
  }

  const buffer = Buffer.from(await jarRes.arrayBuffer());
  fs.writeFileSync(destPath, buffer);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'minecraft.modrinth_install',
    target: srv.container_name,
    details: `Installed ${safeFileName} (${matched.version_number}) into ${targetSubfolder}/`,
    ipAddress: params.ipAddress,
  });

  return {
    filename: safeFileName,
    installedPath: `${targetSubfolder}/${safeFileName}`,
    versionNumber: matched.version_number,
  };
}
