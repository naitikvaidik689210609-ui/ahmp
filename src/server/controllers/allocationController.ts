import fs from 'node:fs';
import net from 'node:net';
import { db, recordAuditLog } from '../db.js';
import { isValidPort, resolveConfinedPath } from '../security.js';
import { detectHostPublicIpv4 } from './incusController.js';
import { getNodeById } from './nodeController.js';

export type AllocationProtocol = 'TCP/UDP' | 'BOTH' | 'TCP' | 'UDP';

export interface AllocationRow {
  id: number;
  node_id: number;
  ip: string;
  ip_alias: string | null;
  port: number;
  protocol: AllocationProtocol;
  server_id: number | null;
  server_name?: string | null;
  server_status?: string | null;
  is_primary: number;
  notes: string | null;
  created_at: string;
}

const HOSTNAME_ALIAS_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,118}[a-zA-Z0-9])?$/;
const MAX_BULK_PORTS = 500;

export function parsePortExpression(raw: unknown): number[] {
  const input = String(raw || '').trim();
  if (!input) {
    throw new Error('Port specification is required (e.g. 25565, 25565-25620, or 25565, 19132).');
  }

  const tokens = input
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error('Provide at least one valid port between 1024 and 65535.');
  }

  const portSet = new Set<number>();

  for (const token of tokens) {
    if (token.includes('-')) {
      const parts = token.split('-').map((p) => p.trim());
      if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
        throw new Error(`Invalid port range '${token}'. Expected format like 25565-25620.`);
      }
      const start = Number(parts[0]);
      const end = Number(parts[1]);
      if (!isValidPort(start) || !isValidPort(end)) {
        throw new Error(`Ports in range '${token}' must be between 1024 and 65535.`);
      }
      if (start > end) {
        throw new Error(`Invalid range '${token}': start port cannot exceed end port.`);
      }
      if (end - start + 1 > MAX_BULK_PORTS) {
        throw new Error(`Range '${token}' exceeds maximum ${MAX_BULK_PORTS} ports per batch.`);
      }
      for (let p = start; p <= end; p++) {
        portSet.add(p);
        if (portSet.size > MAX_BULK_PORTS) {
          throw new Error(`Batch exceeds maximum ${MAX_BULK_PORTS} total ports.`);
        }
      }
    } else {
      if (!/^\d+$/.test(token)) {
        throw new Error(`Invalid port '${token}'. Only numeric ports (1024-65535) are allowed.`);
      }
      const p = Number(token);
      if (!isValidPort(p)) {
        throw new Error(`Port ${p} must be between 1024 and 65535.`);
      }
      portSet.add(p);
      if (portSet.size > MAX_BULK_PORTS) {
        throw new Error(`Batch exceeds maximum ${MAX_BULK_PORTS} total ports.`);
      }
    }
  }

  return Array.from(portSet).sort((a, b) => a - b);
}

export function validateAllocationIp(rawIp: unknown): string {
  const ip = String(rawIp || '').trim();
  if (!ip) {
    throw new Error('IP address is required (e.g. 0.0.0.0 or node public IPv4).');
  }
  if (ip === '0.0.0.0' || net.isIPv4(ip) || net.isIPv6(ip)) {
    return ip;
  }
  throw new Error('IP address must be 0.0.0.0, a valid IPv4, or a valid IPv6 address.');
}

export function validateIpAlias(rawAlias: unknown): string | null {
  if (rawAlias === undefined || rawAlias === null) return null;
  const trimmed = String(rawAlias).trim();
  if (!trimmed) return null;
  if (!HOSTNAME_ALIAS_REGEX.test(trimmed)) {
    throw new Error('IP Alias must be a valid hostname or subdomain (e.g. play.yourdomain.com).');
  }
  return trimmed;
}

export function sanitizeAllocationNotes(rawNotes: unknown): string | null {
  if (rawNotes === undefined || rawNotes === null) return null;
  const cleaned = String(rawNotes).trim().replace(/[<>]/g, '').slice(0, 120);
  return cleaned || null;
}

export function normalizeProtocol(rawProtocol: unknown): AllocationProtocol {
  const p = String(rawProtocol || 'TCP/UDP')
    .trim()
    .toUpperCase();
  if (p === 'TCP/UDP' || p === 'BOTH' || p === 'TCP' || p === 'UDP') {
    return p;
  }
  return 'TCP/UDP';
}

export function syncServerPropertiesPort(dataDir: string, port: number): void {
  if (!dataDir || !isValidPort(port)) return;
  try {
    const propsPath = resolveConfinedPath(dataDir, 'server.properties');
    if (!fs.existsSync(propsPath)) return;

    const raw = fs.readFileSync(propsPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let replaced = false;
    const updated = lines.map((line) => {
      if (/^\s*server-port\s*=/.test(line)) {
        replaced = true;
        return `server-port=${port}`;
      }
      return line;
    });
    if (!replaced) {
      updated.push(`server-port=${port}`);
    }
    fs.writeFileSync(propsPath, `${updated.join('\n').replace(/\n*$/, '')}\n`, 'utf8');
  } catch {
    // Non-fatal if workspace isn't initialized yet
  }
}

export function buildDockerPortConfig(allocations: Array<{ ip: string; port: number; protocol?: string }>): {
  ExposedPorts: Record<string, Record<string, never>>;
  PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
} {
  const ExposedPorts: Record<string, Record<string, never>> = {};
  const PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};

  for (const alloc of allocations) {
    const proto = String(alloc.protocol || 'TCP/UDP').toUpperCase();
    const hostIp = alloc.ip === '0.0.0.0' ? '' : alloc.ip;
    const hostPort = String(alloc.port);

    if (proto === 'TCP' || proto === 'TCP/UDP' || proto === 'BOTH') {
      const key = `${alloc.port}/tcp`;
      ExposedPorts[key] = {};
      if (!PortBindings[key]) PortBindings[key] = [];
      PortBindings[key].push({ HostIp: hostIp, HostPort: hostPort });
    }
    if (proto === 'UDP' || proto === 'TCP/UDP' || proto === 'BOTH') {
      const key = `${alloc.port}/udp`;
      ExposedPorts[key] = {};
      if (!PortBindings[key]) PortBindings[key] = [];
      PortBindings[key].push({ HostIp: hostIp, HostPort: hostPort });
    }
  }

  return { ExposedPorts, PortBindings };
}

export async function getSuggestedNodeIp(nodeId: number): Promise<{
  suggestedIp: string;
  fqdn: string;
  isLocal: boolean;
}> {
  const node = getNodeById(nodeId);
  if (!node) throw new Error('Node not found.');

  if (node.is_local === 1) {
    const publicIpv4 = await detectHostPublicIpv4().catch(() => '0.0.0.0');
    const suggested =
      publicIpv4 && publicIpv4 !== '127.0.0.1' && publicIpv4 !== 'localhost'
        ? publicIpv4
        : '0.0.0.0';
    return { suggestedIp: suggested, fqdn: node.fqdn, isLocal: true };
  }

  return {
    suggestedIp: net.isIP(node.fqdn) ? node.fqdn : '0.0.0.0',
    fqdn: node.fqdn,
    isLocal: false,
  };
}

export function listNodeAllocations(nodeId: number): AllocationRow[] {
  const node = getNodeById(nodeId);
  if (!node) throw new Error('Node not found.');

  return db
    .prepare(
      `SELECT a.*, ms.name AS server_name, ms.status AS server_status
       FROM allocations a
       LEFT JOIN minecraft_servers ms ON ms.id = a.server_id
       WHERE a.node_id = ?
       ORDER BY a.port ASC, a.ip ASC`
    )
    .all(nodeId) as AllocationRow[];
}

export function listAvailableNodeAllocations(nodeId: number): AllocationRow[] {
  const node = getNodeById(nodeId);
  if (!node) throw new Error('Node not found.');

  return db
    .prepare(
      `SELECT a.*
       FROM allocations a
       WHERE a.node_id = ? AND a.server_id IS NULL
       ORDER BY a.port ASC, a.ip ASC`
    )
    .all(nodeId) as AllocationRow[];
}

export function createNodeAllocations(params: {
  nodeId: number;
  ip: string;
  ipAlias?: string | null;
  portsInput: string;
  protocol?: string;
  notes?: string | null;
  userId: number;
  username: string;
  ipAddress: string;
}): {
  createdCount: number;
  skippedCount: number;
  allocations: AllocationRow[];
} {
  const node = getNodeById(params.nodeId);
  if (!node) throw new Error('Target node not found.');

  const validIp = validateAllocationIp(params.ip);
  const validAlias = validateIpAlias(params.ipAlias);
  const validNotes = sanitizeAllocationNotes(params.notes);
  const validProtocol = normalizeProtocol(params.protocol);
  const ports = parsePortExpression(params.portsInput);

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO allocations (node_id, ip, ip_alias, port, protocol, server_id, is_primary, notes)
     VALUES (?, ?, ?, ?, ?, NULL, 0, ?)`
  );

  let createdCount = 0;
  let skippedCount = 0;

  db.transaction(() => {
    for (const port of ports) {
      const res = insertStmt.run(
        node.id,
        validIp,
        validAlias,
        port,
        validProtocol,
        validNotes
      );
      if (res.changes > 0) {
        createdCount += 1;
      } else {
        skippedCount += 1;
      }
    }
  })();

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'node.allocations_create',
    target: node.name,
    details: `Added ${createdCount} allocation(s) on ${validIp} (${params.portsInput}), skipped ${skippedCount} duplicate(s)`,
    ipAddress: params.ipAddress,
  });

  return {
    createdCount,
    skippedCount,
    allocations: listNodeAllocations(node.id),
  };
}

export function updateNodeAllocation(params: {
  nodeId: number;
  allocationId: number;
  ipAlias?: string | null;
  notes?: string | null;
  userId: number;
  username: string;
  ipAddress: string;
}): AllocationRow {
  const existing = db
    .prepare('SELECT * FROM allocations WHERE id = ? AND node_id = ?')
    .get(params.allocationId, params.nodeId) as AllocationRow | undefined;
  if (!existing) {
    throw new Error('Allocation not found on this node.');
  }

  const nextAlias =
    params.ipAlias !== undefined ? validateIpAlias(params.ipAlias) : existing.ip_alias;
  const nextNotes =
    params.notes !== undefined ? sanitizeAllocationNotes(params.notes) : existing.notes;

  db.prepare('UPDATE allocations SET ip_alias = ?, notes = ? WHERE id = ?').run(
    nextAlias,
    nextNotes,
    existing.id
  );

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'node.allocation_update',
    target: `${existing.ip}:${existing.port}`,
    details: `Updated alias='${nextAlias || ''}', notes='${nextNotes || ''}'`,
    ipAddress: params.ipAddress,
  });

  return db
    .prepare(
      `SELECT a.*, ms.name AS server_name, ms.status AS server_status
       FROM allocations a
       LEFT JOIN minecraft_servers ms ON ms.id = a.server_id
       WHERE a.id = ?`
    )
    .get(existing.id) as AllocationRow;
}

export function deleteNodeAllocation(params: {
  nodeId: number;
  allocationId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): void {
  const existing = db
    .prepare('SELECT * FROM allocations WHERE id = ? AND node_id = ?')
    .get(params.allocationId, params.nodeId) as AllocationRow | undefined;
  if (!existing) {
    throw new Error('Allocation not found on this node.');
  }
  if (existing.server_id !== null) {
    throw new Error(
      `Cannot delete ${existing.ip}:${existing.port} while it is assigned to a server.`
    );
  }

  db.prepare('DELETE FROM allocations WHERE id = ?').run(existing.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'node.allocation_delete',
    target: `${existing.ip}:${existing.port}`,
    details: `Removed unassigned allocation from node#${params.nodeId}`,
    ipAddress: params.ipAddress,
  });
}

export function bulkDeleteNodeAllocations(params: {
  nodeId: number;
  allocationIds: number[];
  userId: number;
  username: string;
  ipAddress: string;
}): { deletedCount: number; blockedCount: number } {
  const node = getNodeById(params.nodeId);
  if (!node) throw new Error('Node not found.');

  const cleanIds = Array.from(
    new Set(params.allocationIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))
  );
  if (cleanIds.length === 0) {
    throw new Error('Select at least one allocation to delete.');
  }

  let deletedCount = 0;
  let blockedCount = 0;

  db.transaction(() => {
    const checkStmt = db.prepare('SELECT id, server_id FROM allocations WHERE id = ? AND node_id = ?');
    const delStmt = db.prepare('DELETE FROM allocations WHERE id = ? AND server_id IS NULL');

    for (const allocId of cleanIds) {
      const row = checkStmt.get(allocId, node.id) as { id: number; server_id: number | null } | undefined;
      if (!row) continue;
      if (row.server_id !== null) {
        blockedCount += 1;
        continue;
      }
      const res = delStmt.run(allocId);
      if (res.changes > 0) deletedCount += 1;
    }
  })();

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'node.allocations_bulk_delete',
    target: node.name,
    details: `Bulk deleted ${deletedCount} unassigned allocation(s) (${blockedCount} assigned skipped)`,
    ipAddress: params.ipAddress,
  });

  return { deletedCount, blockedCount };
}

export function listServerAllocations(serverId: number): AllocationRow[] {
  return db
    .prepare(
      `SELECT a.*, ms.name AS server_name, ms.status AS server_status
       FROM allocations a
       LEFT JOIN minecraft_servers ms ON ms.id = a.server_id
       WHERE a.server_id = ?
       ORDER BY a.is_primary DESC, a.port ASC, a.id ASC`
    )
    .all(serverId) as AllocationRow[];
}

function findNextFreePoolPortForNode(nodeId: number): number {
  const pools = db
    .prepare('SELECT start_port, end_port FROM port_pools ORDER BY id ASC')
    .all() as Array<{ start_port: number; end_port: number }>;

  const usedRows = db
    .prepare('SELECT port FROM allocations WHERE node_id = ?')
    .all(nodeId) as Array<{ port: number }>;
  const usedPorts = new Set(usedRows.map((r) => r.port));

  if (nodeId === 1) {
    const legacyRows = db.prepare('SELECT host_port FROM port_allocations').all() as Array<{
      host_port: number;
    }>;
    for (const r of legacyRows) usedPorts.add(r.host_port);
  }

  const candidatePools =
    pools.length > 0 ? pools : [{ start_port: 25565, end_port: 25999 }];

  for (const pool of candidatePools) {
    for (let port = Math.max(1024, pool.start_port); port <= Math.min(65535, pool.end_port); port++) {
      if (!usedPorts.has(port)) {
        return port;
      }
    }
  }

  for (let port = 25565; port <= 29999; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }

  throw new Error('No free ports available on this node. Add more allocations in Node Settings.');
}

/**
 * Reserves an available allocation (or falls back to creating one from free node pool ports)
 * without assigning server_id yet (used right before server row insertion, then finalized).
 */
export function resolvePrimaryAllocationCandidate(params: {
  nodeId: number;
  primaryAllocationId?: number | 'auto' | null;
  fallbackPort?: number;
}): { existingAllocation?: AllocationRow; port: number; ip: string } {
  if (
    typeof params.primaryAllocationId === 'number' &&
    Number.isInteger(params.primaryAllocationId) &&
    params.primaryAllocationId > 0
  ) {
    const alloc = db
      .prepare('SELECT * FROM allocations WHERE id = ? AND node_id = ?')
      .get(params.primaryAllocationId, params.nodeId) as AllocationRow | undefined;
    if (!alloc) {
      throw new Error('Selected primary allocation does not belong to the chosen node.');
    }
    if (alloc.server_id !== null) {
      throw new Error(`Allocation ${alloc.ip}:${alloc.port} is already assigned to another server.`);
    }
    return { existingAllocation: alloc, port: alloc.port, ip: alloc.ip };
  }

  if (params.primaryAllocationId === 'auto' || !params.fallbackPort) {
    const available = db
      .prepare(
        `SELECT * FROM allocations WHERE node_id = ? AND server_id IS NULL ORDER BY port ASC, id ASC LIMIT 1`
      )
      .get(params.nodeId) as AllocationRow | undefined;
    if (available) {
      return { existingAllocation: available, port: available.port, ip: available.ip };
    }
    const freePort = findNextFreePoolPortForNode(params.nodeId);
    return { port: freePort, ip: '0.0.0.0' };
  }

  // Legacy explicit port mode
  const requestedPort = Number(params.fallbackPort);
  if (!isValidPort(requestedPort)) {
    throw new Error('Port must be an integer between 1024 and 65535.');
  }

  const matchingAlloc = db
    .prepare('SELECT * FROM allocations WHERE node_id = ? AND port = ? LIMIT 1')
    .get(params.nodeId, requestedPort) as AllocationRow | undefined;

  if (matchingAlloc) {
    if (matchingAlloc.server_id !== null) {
      throw new Error(`Port ${requestedPort} is already assigned to another server on this node.`);
    }
    return { existingAllocation: matchingAlloc, port: matchingAlloc.port, ip: matchingAlloc.ip };
  }

  if (params.nodeId === 1) {
    const legacyConflict = db
      .prepare('SELECT id FROM port_allocations WHERE host_port = ? AND protocol = ?')
      .get(requestedPort, 'tcp');
    if (legacyConflict) {
      throw new Error(`Port ${requestedPort}/tcp is already allocated.`);
    }
  }

  return { port: requestedPort, ip: '0.0.0.0' };
}

export function assignNextAllocationToServer(params: {
  serverId: number;
  notes?: string | null;
  isStaff: boolean;
  userId: number;
  username: string;
  ipAddress: string;
}): {
  allocation: AllocationRow;
  allocations: AllocationRow[];
  restartRequired: boolean;
} {
  const srv = db
    .prepare('SELECT id, name, container_name, node_id, max_allocations, status FROM minecraft_servers WHERE id = ?')
    .get(params.serverId) as
    | {
        id: number;
        name: string;
        container_name: string;
        node_id: number;
        max_allocations: number;
        status: string;
      }
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const currentAllocs = listServerAllocations(srv.id);
  const maxLimit = Number(srv.max_allocations || 3);
  if (!params.isStaff && currentAllocs.length >= maxLimit) {
    throw new Error(
      `Allocation limit reached (${currentAllocs.length}/${maxLimit}). Contact an administrator to increase Max Allocations.`
    );
  }
  if (params.isStaff && currentAllocs.length >= Math.max(maxLimit, 25)) {
    throw new Error('Maximum server port allocation safety cap reached.');
  }

  const nodeId = srv.node_id || 1;
  const cleanNotes = sanitizeAllocationNotes(params.notes);
  let claimedId = 0;

  db.transaction(() => {
    const available = db
      .prepare(
        `SELECT * FROM allocations WHERE node_id = ? AND server_id IS NULL ORDER BY port ASC, id ASC LIMIT 1`
      )
      .get(nodeId) as AllocationRow | undefined;

    if (available) {
      db.prepare(
        'UPDATE allocations SET server_id = ?, is_primary = 0, notes = COALESCE(?, notes) WHERE id = ?'
      ).run(srv.id, cleanNotes, available.id);
      claimedId = available.id;
    } else {
      const freePort = findNextFreePoolPortForNode(nodeId);
      const res = db
        .prepare(
          `INSERT INTO allocations (node_id, ip, ip_alias, port, protocol, server_id, is_primary, notes)
           VALUES (?, '0.0.0.0', NULL, ?, 'TCP/UDP', ?, 0, ?)`
        )
        .run(nodeId, freePort, srv.id, cleanNotes);
      claimedId = Number(res.lastInsertRowid);
    }
  })();

  const allocation = db.prepare('SELECT * FROM allocations WHERE id = ?').get(claimedId) as AllocationRow;

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'minecraft.allocation_add',
    target: srv.container_name,
    details: `Assigned ${allocation.ip}:${allocation.port} to ${srv.name}`,
    ipAddress: params.ipAddress,
  });

  return {
    allocation,
    allocations: listServerAllocations(srv.id),
    restartRequired: true,
  };
}

export function updateServerAllocationNotes(params: {
  serverId: number;
  allocationId: number;
  notes: string | null;
  userId: number;
  username: string;
  ipAddress: string;
}): AllocationRow[] {
  const existing = db
    .prepare('SELECT * FROM allocations WHERE id = ? AND server_id = ?')
    .get(params.allocationId, params.serverId) as AllocationRow | undefined;
  if (!existing) {
    throw new Error('Allocation is not assigned to this server.');
  }

  const cleanNotes = sanitizeAllocationNotes(params.notes);
  db.prepare('UPDATE allocations SET notes = ? WHERE id = ?').run(cleanNotes, existing.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'minecraft.allocation_notes',
    target: `${existing.ip}:${existing.port}`,
    details: `Updated allocation notes: '${cleanNotes || ''}'`,
    ipAddress: params.ipAddress,
  });

  return listServerAllocations(params.serverId);
}

export function setServerPrimaryAllocation(params: {
  serverId: number;
  allocationId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): {
  allocations: AllocationRow[];
  primaryPort: number;
  restartRequired: boolean;
} {
  const srv = db
    .prepare('SELECT id, name, container_name, data_dir FROM minecraft_servers WHERE id = ?')
    .get(params.serverId) as
    | { id: number; name: string; container_name: string; data_dir: string }
    | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const target = db
    .prepare('SELECT * FROM allocations WHERE id = ? AND server_id = ?')
    .get(params.allocationId, srv.id) as AllocationRow | undefined;
  if (!target) {
    throw new Error('Allocation is not assigned to this server.');
  }

  db.transaction(() => {
    db.prepare('UPDATE allocations SET is_primary = 0 WHERE server_id = ?').run(srv.id);
    db.prepare('UPDATE allocations SET is_primary = 1 WHERE id = ?').run(target.id);
    db.prepare('UPDATE minecraft_servers SET port = ? WHERE id = ?').run(target.port, srv.id);
    db.prepare(
      `UPDATE port_allocations SET host_port = ?, target_port = ?
       WHERE resource_type = 'minecraft' AND resource_id = ?`
    ).run(target.port, target.port, srv.id);
  })();

  syncServerPropertiesPort(srv.data_dir, target.port);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'minecraft.allocation_primary',
    target: srv.container_name,
    details: `Switched primary allocation to ${target.ip}:${target.port} (synced server-port=${target.port})`,
    ipAddress: params.ipAddress,
  });

  return {
    allocations: listServerAllocations(srv.id),
    primaryPort: target.port,
    restartRequired: true,
  };
}

export function unassignServerAllocation(params: {
  serverId: number;
  allocationId: number;
  userId: number;
  username: string;
  ipAddress: string;
}): { allocations: AllocationRow[]; restartRequired: boolean } {
  const srv = db
    .prepare('SELECT id, name, container_name FROM minecraft_servers WHERE id = ?')
    .get(params.serverId) as { id: number; name: string; container_name: string } | undefined;
  if (!srv) throw new Error('Minecraft server not found.');

  const target = db
    .prepare('SELECT * FROM allocations WHERE id = ? AND server_id = ?')
    .get(params.allocationId, srv.id) as AllocationRow | undefined;
  if (!target) {
    throw new Error('Allocation is not assigned to this server.');
  }
  if (target.is_primary === 1) {
    throw new Error('Cannot unassign the Primary allocation. Make another port Primary first.');
  }

  db.prepare(
    'UPDATE allocations SET server_id = NULL, is_primary = 0, notes = NULL WHERE id = ?'
  ).run(target.id);

  recordAuditLog({
    userId: params.userId,
    username: params.username,
    action: 'minecraft.allocation_unassign',
    target: srv.container_name,
    details: `Released ${target.ip}:${target.port} back to node pool`,
    ipAddress: params.ipAddress,
  });

  return {
    allocations: listServerAllocations(srv.id),
    restartRequired: true,
  };
}
