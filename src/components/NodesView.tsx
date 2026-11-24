import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Globe,
  HardDrive,
  KeyRound,
  Lock,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { apiFetch, copyToClipboard } from '../lib/api';
import type { AllocationItem, AuthUser, NodeItem } from '../types';

interface NodesViewProps {
  currentUser: AuthUser;
  socket: Socket | null;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onNavigateToServer?: (serverId: number) => void;
}

export function NodesView({
  currentUser,
  socket,
  onNotify,
  onNavigateToServer,
}: NodesViewProps) {
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);

  // Selected Node Workspace (Overview vs Allocations)
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [nodeTab, setNodeTab] = useState<'overview' | 'allocations'>('allocations');

  // Add Remote Node form state
  const [name, setName] = useState('');
  const [location, setLocation] = useState('DE · Falkenstein');
  const [fqdn, setFqdn] = useState('');
  const [daemonPort, setDaemonPort] = useState(8443);
  const [creating, setCreating] = useState(false);

  // Install Command Modal (for newly created node or rotated token)
  const [tokenReveal, setTokenReveal] = useState<{
    nodeName: string;
    rawToken: string;
  } | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedTok, setCopiedTok] = useState(false);

  // Node Allocations Manager state
  const [allocations, setAllocations] = useState<AllocationItem[]>([]);
  const [allocLoading, setAllocLoading] = useState(false);
  const [suggestedIp, setSuggestedIp] = useState('0.0.0.0');
  const [allocIp, setAllocIp] = useState('0.0.0.0');
  const [allocAlias, setAllocAlias] = useState('');
  const [allocPorts, setAllocPorts] = useState('25565-25600');
  const [allocProtocol, setAllocProtocol] = useState<'TCP/UDP' | 'BOTH' | 'TCP' | 'UDP'>('TCP/UDP');
  const [allocNotes, setAllocNotes] = useState('');
  const [creatingAllocs, setCreatingAllocs] = useState(false);

  const [allocSearch, setAllocSearch] = useState('');
  const [allocFilter, setAllocFilter] = useState<'all' | 'available' | 'assigned'>('all');
  const [selectedAllocIds, setSelectedAllocIds] = useState<Set<number>>(new Set());
  const [editingAliasId, setEditingAliasId] = useState<number | null>(null);
  const [editingAliasVal, setEditingAliasVal] = useState('');
  const [savingAliasId, setSavingAliasId] = useState<number | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const isStaff = currentUser.role === 'owner' || currentUser.role === 'admin';
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;

  const loadNodes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ nodes: NodeItem[] }>('/api/nodes');
      setNodes(res.nodes);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load VPS nodes', 'error');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void loadNodes();
  }, [loadNodes]);

  useEffect(() => {
    if (!socket) return;
    const handleNodesUpdate = (updated: NodeItem[]) => {
      if (Array.isArray(updated)) {
        setNodes(updated);
      }
    };
    socket.on('nodes:update', handleNodesUpdate);
    return () => {
      socket.off('nodes:update', handleNodesUpdate);
    };
  }, [socket]);

  const loadNodeAllocations = useCallback(
    async (nodeId: number) => {
      setAllocLoading(true);
      try {
        const [allocRes, ipRes] = await Promise.all([
          apiFetch<{ allocations: AllocationItem[] }>(`/api/nodes/${nodeId}/allocations`),
          apiFetch<{ suggestedIp: string }>(`/api/nodes/${nodeId}/suggested-ip`).catch(() => ({
            suggestedIp: '0.0.0.0',
          })),
        ]);
        setAllocations(allocRes.allocations);
        setSuggestedIp(ipRes.suggestedIp || '0.0.0.0');
        setAllocIp((prev) => (prev === '0.0.0.0' && ipRes.suggestedIp ? ipRes.suggestedIp : prev));
        setSelectedAllocIds(new Set());
      } catch (err) {
        onNotify(err instanceof Error ? err.message : 'Failed to load node allocations', 'error');
      } finally {
        setAllocLoading(false);
      }
    },
    [onNotify]
  );

  useEffect(() => {
    if (selectedNodeId) {
      void loadNodeAllocations(selectedNodeId);
    }
  }, [selectedNodeId, loadNodeAllocations]);

  async function handleAddNode(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await apiFetch<{ node: NodeItem; rawToken: string }>('/api/nodes', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          location: location.trim(),
          fqdn: fqdn.trim(),
          daemonPort: Number(daemonPort),
        }),
      });
      setShowAddModal(false);
      setName('');
      setFqdn('');
      setTokenReveal({ nodeName: res.node.name, rawToken: res.rawToken });
      setCopiedCmd(false);
      setCopiedTok(false);
      onNotify(`Registered remote VPS node '${res.node.name}'.`);
      await loadNodes();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create remote node', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleRotateToken(node: NodeItem) {
    try {
      const res = await apiFetch<{ rawToken: string; tokenPrefix: string }>(
        `/api/nodes/${node.id}/token`,
        { method: 'POST' }
      );
      setTokenReveal({ nodeName: node.name, rawToken: res.rawToken });
      setCopiedCmd(false);
      setCopiedTok(false);
      onNotify(`Rotated agent token for '${node.name}'.`);
      await loadNodes();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to rotate node token', 'error');
    }
  }

  async function handleDeleteNode(node: NodeItem) {
    try {
      await apiFetch(`/api/nodes/${node.id}`, { method: 'DELETE' });
      onNotify(`Removed node '${node.name}'.`);
      if (selectedNodeId === node.id) setSelectedNodeId(null);
      await loadNodes();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete node', 'error');
    }
  }

  async function handleCreateAllocations(e: FormEvent) {
    e.preventDefault();
    if (!selectedNode) return;
    setCreatingAllocs(true);
    try {
      const res = await apiFetch<{
        createdCount: number;
        skippedCount: number;
        allocations: AllocationItem[];
      }>(`/api/nodes/${selectedNode.id}/allocations`, {
        method: 'POST',
        body: JSON.stringify({
          ip: allocIp.trim(),
          ipAlias: allocAlias.trim() || undefined,
          ports: allocPorts.trim(),
          protocol: allocProtocol,
          notes: allocNotes.trim() || undefined,
        }),
      });
      setAllocations(res.allocations);
      setSelectedAllocIds(new Set());
      onNotify(
        `Created ${res.createdCount} allocation(s)${
          res.skippedCount > 0 ? ` (${res.skippedCount} duplicate skipped)` : ''
        }.`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create allocations', 'error');
    } finally {
      setCreatingAllocs(false);
    }
  }

  async function handleSaveAlias(alloc: AllocationItem) {
    if (!selectedNode) return;
    setSavingAliasId(alloc.id);
    try {
      const res = await apiFetch<{ allocation: AllocationItem }>(
        `/api/nodes/${selectedNode.id}/allocations/${alloc.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ ipAlias: editingAliasVal.trim() || null }),
        }
      );
      setAllocations((prev) => prev.map((a) => (a.id === alloc.id ? res.allocation : a)));
      setEditingAliasId(null);
      onNotify(`Updated IP alias for ${alloc.ip}:${alloc.port}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update IP alias', 'error');
    } finally {
      setSavingAliasId(null);
    }
  }

  async function handleDeleteAllocation(alloc: AllocationItem) {
    if (!selectedNode) return;
    try {
      await apiFetch(`/api/nodes/${selectedNode.id}/allocations/${alloc.id}`, {
        method: 'DELETE',
      });
      setAllocations((prev) => prev.filter((a) => a.id !== alloc.id));
      setSelectedAllocIds((prev) => {
        const next = new Set(prev);
        next.delete(alloc.id);
        return next;
      });
      onNotify(`Removed allocation ${alloc.ip}:${alloc.port}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete allocation', 'error');
    }
  }

  async function handleBulkDelete() {
    if (!selectedNode || selectedAllocIds.size === 0) return;
    setBulkDeleting(true);
    try {
      const res = await apiFetch<{ deletedCount: number; blockedCount: number }>(
        `/api/nodes/${selectedNode.id}/allocations/bulk-delete`,
        {
          method: 'POST',
          body: JSON.stringify({ ids: Array.from(selectedAllocIds) }),
        }
      );
      onNotify(`Deleted ${res.deletedCount} unassigned allocation(s).`);
      await loadNodeAllocations(selectedNode.id);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Bulk delete failed', 'error');
    } finally {
      setBulkDeleting(false);
    }
  }

  const filteredAllocations = useMemo(() => {
    const q = allocSearch.trim().toLowerCase();
    return allocations.filter((a) => {
      if (allocFilter === 'available' && a.server_id !== null) return false;
      if (allocFilter === 'assigned' && a.server_id === null) return false;
      if (!q) return true;
      return (
        String(a.port).includes(q) ||
        a.ip.toLowerCase().includes(q) ||
        (a.ip_alias || '').toLowerCase().includes(q) ||
        (a.notes || '').toLowerCase().includes(q) ||
        (a.server_name || '').toLowerCase().includes(q)
      );
    });
  }, [allocations, allocFilter, allocSearch]);

  const selectableFiltered = useMemo(
    () => filteredAllocations.filter((a) => a.server_id === null),
    [filteredAllocations]
  );

  const allSelectableChecked =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((a) => selectedAllocIds.has(a.id));

  function toggleSelectAllUnassigned() {
    if (allSelectableChecked) {
      setSelectedAllocIds(new Set());
    } else {
      setSelectedAllocIds(new Set(selectableFiltered.map((a) => a.id)));
    }
  }

  function toggleSelectOne(allocId: number) {
    setSelectedAllocIds((prev) => {
      const next = new Set(prev);
      if (next.has(allocId)) next.delete(allocId);
      else next.add(allocId);
      return next;
    });
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://panel.local';
  const buildInstallCommand = (rawToken: string) =>
    `bash <(curl -sSL ${origin}/api/nodes/install-script) --token ${rawToken} --panel ${origin}`;

  const onlineCount = nodes.filter((n) => n.status === 'online').length;
  const totalWorkloads = nodes.reduce((acc, n) => acc + (n.workload_count || 0), 0);

  const availableCount = allocations.filter((a) => a.server_id === null).length;
  const assignedCount = allocations.length - availableCount;

  return (
    <div className="space-y-6">
      {/* Selected Node Detail + Allocations View */}
      {selectedNode ? (
        <div className="space-y-5">
          <div className="cyber-glass rounded-xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-violet-500/15 pb-4">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={() => setSelectedNodeId(null)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-[#090714]/80 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-violet-600/20 whitespace-nowrap shrink-0"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  All Nodes
                </button>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-lg font-bold text-white">{selectedNode.name}</h2>
                    <span
                      className={`text-xs font-semibold ${
                        selectedNode.status === 'online' ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      · {selectedNode.status === 'online' ? 'Online' : 'Offline'}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {selectedNode.location} ·{' '}
                    <span className="font-mono text-slate-300">
                      {selectedNode.fqdn}:{selectedNode.daemon_port}
                    </span>
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 rounded-lg bg-[#090714]/80 p-1">
                {(
                  [
                    ['allocations', 'IP & Port Allocations'],
                    ['overview', 'Node Telemetry'],
                  ] as const
                ).map(([tabKey, label]) => (
                  <button
                    key={tabKey}
                    type="button"
                    onClick={() => setNodeTab(tabKey)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      nodeTab === tabKey
                        ? 'bg-violet-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {nodeTab === 'overview' ? (
              <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-4">
                <div className="rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4">
                  <p className="text-xs text-slate-400">CPU Load</p>
                  <p className="mt-1 font-mono text-xl font-bold text-white tabular-nums">
                    {Number(selectedNode.cpu_percent || 0).toFixed(1)}%
                  </p>
                </div>
                <div className="rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4">
                  <p className="text-xs text-slate-400">RAM Usage</p>
                  <p className="mt-1 font-mono text-xl font-bold text-white tabular-nums">
                    {Number(selectedNode.ram_percent || 0).toFixed(1)}%
                  </p>
                </div>
                <div className="rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4">
                  <p className="text-xs text-slate-400">Disk Usage</p>
                  <p className="mt-1 font-mono text-xl font-bold text-white tabular-nums">
                    {Number(selectedNode.disk_percent || 0).toFixed(1)}%
                  </p>
                </div>
                <div className="rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4">
                  <p className="text-xs text-slate-400">Total Allocations</p>
                  <p className="mt-1 font-mono text-xl font-bold text-white tabular-nums">
                    {assignedCount} / {allocations.length} used
                  </p>
                </div>
              </div>
            ) : (
              <div className="mt-5 grid grid-cols-1 gap-6 xl:grid-cols-12">
                {/* LEFT: BULK / SINGLE ALLOCATION CREATOR */}
                <form
                  onSubmit={handleCreateAllocations}
                  className="space-y-4 rounded-xl border border-violet-500/20 bg-[#090714]/65 p-5 xl:col-span-4 h-fit"
                >
                  <div className="flex items-center justify-between border-b border-violet-500/15 pb-3">
                    <div className="flex items-center gap-2">
                      <Network className="h-4 w-4 text-violet-400" />
                      <h3 className="text-sm font-semibold text-white">Assign New Allocations</h3>
                    </div>
                    <span className="font-mono text-xs text-slate-400 tabular-nums">
                      {availableCount} free
                    </span>
                  </div>

                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <label className="text-xs font-medium text-slate-300">IP Address</label>
                      <div className="flex items-center gap-2 text-[11px]">
                        {suggestedIp && suggestedIp !== '0.0.0.0' && (
                          <button
                            type="button"
                            onClick={() => setAllocIp(suggestedIp)}
                            className="text-violet-300 hover:text-violet-200 underline"
                          >
                            Use {suggestedIp}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setAllocIp('0.0.0.0')}
                          className="text-slate-400 hover:text-slate-200 underline"
                        >
                          0.0.0.0
                        </button>
                      </div>
                    </div>
                    <input
                      type="text"
                      required
                      value={allocIp}
                      onChange={(e) => setAllocIp(e.target.value)}
                      placeholder="0.0.0.0 or VPS Public IPv4"
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 font-mono text-xs text-white focus:border-violet-400 focus:outline-none"
                    />
                    <p className="mt-1 text-[11px] text-slate-500">
                      Use 0.0.0.0 to bind all interfaces, or enter a specific public IPv4/IPv6.
                    </p>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-300">
                      IP Alias (Optional Hostname)
                    </label>
                    <input
                      type="text"
                      value={allocAlias}
                      onChange={(e) => setAllocAlias(e.target.value)}
                      placeholder="play.yourdomain.com"
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 font-mono text-xs text-white focus:border-violet-400 focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <label className="mb-1 block text-xs font-medium text-slate-300">
                        Port(s)
                      </label>
                      <input
                        type="text"
                        required
                        value={allocPorts}
                        onChange={(e) => setAllocPorts(e.target.value)}
                        placeholder="25565-25620 or 25565, 19132"
                        className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 font-mono text-xs text-white focus:border-violet-400 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-300">
                        Protocol
                      </label>
                      <select
                        value={allocProtocol}
                        onChange={(e) =>
                          setAllocProtocol(
                            e.target.value as 'TCP/UDP' | 'BOTH' | 'TCP' | 'UDP'
                          )
                        }
                        className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-2.5 py-2 font-mono text-xs text-white"
                      >
                        <option value="TCP/UDP">TCP/UDP</option>
                        <option value="TCP">TCP</option>
                        <option value="UDP">UDP</option>
                        <option value="BOTH">BOTH</option>
                      </select>
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 -mt-2">
                    Supports single (<span className="font-mono">25565</span>), range (
                    <span className="font-mono">25565-25620</span>), or comma lists (
                    <span className="font-mono">25565, 19132</span>).
                  </p>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-300">
                      Notes (Optional)
                    </label>
                    <input
                      type="text"
                      value={allocNotes}
                      onChange={(e) => setAllocNotes(e.target.value)}
                      placeholder="e.g. Main Java Pool or Geyser Bedrock"
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 text-xs text-white focus:border-violet-400 focus:outline-none"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={creatingAllocs}
                    className="cyber-glow-btn w-full rounded-lg px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-60"
                  >
                    {creatingAllocs ? 'Creating Allocations...' : 'Create Allocations'}
                  </button>
                </form>

                {/* RIGHT: ALLOCATIONS TABLE & BULK ACTIONS */}
                <div className="space-y-4 xl:col-span-8">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[220px]">
                      <div className="relative flex-1 min-w-[180px]">
                        <Search className="pointer-events-none absolute top-2.5 left-3 h-3.5 w-3.5 text-slate-500" />
                        <input
                          type="text"
                          value={allocSearch}
                          onChange={(e) => setAllocSearch(e.target.value)}
                          placeholder="Filter by port, IP, alias, or server..."
                          className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 py-2 pr-3 pl-8 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                        />
                      </div>

                      <div className="flex items-center gap-1 rounded-lg bg-[#090714]/80 p-1">
                        {(
                          [
                            ['all', `All (${allocations.length})`],
                            ['available', `Available (${availableCount})`],
                            ['assigned', `Assigned (${assignedCount})`],
                          ] as const
                        ).map(([fKey, label]) => (
                          <button
                            key={fKey}
                            type="button"
                            onClick={() => setAllocFilter(fKey)}
                            className={`rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 ${
                              allocFilter === fKey
                                ? 'bg-violet-600 text-white'
                                : 'text-slate-400 hover:text-white'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {selectedAllocIds.size > 0 && (
                      <button
                        type="button"
                        disabled={bulkDeleting}
                        onClick={() => void handleBulkDelete()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/15 px-3 py-1.5 text-xs font-semibold text-red-200 hover:bg-red-500/25 whitespace-nowrap shrink-0"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete Selected ({selectedAllocIds.size})
                      </button>
                    )}
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-violet-500/20 bg-[#090714]/55">
                    {allocLoading ? (
                      <div className="p-8 text-center text-xs text-slate-400">
                        Loading node allocations...
                      </div>
                    ) : filteredAllocations.length === 0 ? (
                      <div className="p-10 text-center text-xs text-slate-400">
                        No IP/port allocations match this filter. Create allocations using the form.
                      </div>
                    ) : (
                      <table className="w-full text-left text-xs">
                        <thead className="border-b border-violet-500/15 text-[11px] uppercase tracking-wider text-slate-400">
                          <tr>
                            <th className="w-9 px-3 py-3">
                              <input
                                type="checkbox"
                                checked={allSelectableChecked}
                                disabled={selectableFiltered.length === 0}
                                onChange={toggleSelectAllUnassigned}
                                aria-label="Select all unassigned allocations"
                                className="h-3.5 w-3.5 accent-violet-600"
                              />
                            </th>
                            <th className="px-3 py-3">IP Address</th>
                            <th className="px-3 py-3">IP Alias</th>
                            <th className="px-3 py-3">Port</th>
                            <th className="px-3 py-3">Assigned To</th>
                            <th className="px-3 py-3">Notes</th>
                            <th className="px-3 py-3 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-violet-500/10">
                          {filteredAllocations.map((alloc) => {
                            const isAssigned = alloc.server_id !== null;
                            const isEditingAlias = editingAliasId === alloc.id;
                            return (
                              <tr
                                key={alloc.id}
                                className="hover:bg-violet-500/5 transition-colors"
                              >
                                <td className="px-3 py-2.5">
                                  <input
                                    type="checkbox"
                                    disabled={isAssigned}
                                    checked={selectedAllocIds.has(alloc.id)}
                                    onChange={() => toggleSelectOne(alloc.id)}
                                    title={
                                      isAssigned
                                        ? 'Assigned allocations cannot be bulk deleted'
                                        : 'Select allocation'
                                    }
                                    className="h-3.5 w-3.5 accent-violet-600 disabled:opacity-30"
                                  />
                                </td>
                                <td className="px-3 py-2.5 font-mono text-slate-200 whitespace-nowrap">
                                  {alloc.ip}
                                </td>
                                <td className="px-3 py-2.5">
                                  {isEditingAlias ? (
                                    <div className="flex items-center gap-1.5">
                                      <input
                                        type="text"
                                        value={editingAliasVal}
                                        onChange={(e) => setEditingAliasVal(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            e.preventDefault();
                                            void handleSaveAlias(alloc);
                                          } else if (e.key === 'Escape') {
                                            setEditingAliasId(null);
                                          }
                                        }}
                                        placeholder="play.domain.com"
                                        className="w-36 rounded border border-violet-500/40 bg-[#0d0a1a] px-2 py-1 font-mono text-xs text-white focus:outline-none"
                                        autoFocus
                                      />
                                      <button
                                        type="button"
                                        disabled={savingAliasId === alloc.id}
                                        onClick={() => void handleSaveAlias(alloc)}
                                        className="rounded bg-violet-600 px-2 py-1 text-[11px] font-medium text-white"
                                      >
                                        Save
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setEditingAliasId(null)}
                                        className="rounded border border-slate-700 px-1.5 py-1 text-[11px] text-slate-400"
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingAliasId(alloc.id);
                                        setEditingAliasVal(alloc.ip_alias || '');
                                      }}
                                      className="group inline-flex items-center gap-1.5 font-mono text-slate-300 hover:text-violet-300"
                                      title="Click to edit IP alias"
                                    >
                                      <span>{alloc.ip_alias || '—'}</span>
                                      <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100 text-violet-400" />
                                    </button>
                                  )}
                                </td>
                                <td className="px-3 py-2.5 font-mono font-semibold text-white tabular-nums whitespace-nowrap">
                                  {alloc.port}{' '}
                                  <span className="text-[10px] font-normal text-slate-500">
                                    {alloc.protocol}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 whitespace-nowrap">
                                  {isAssigned ? (
                                    <div className="flex items-center gap-2">
                                      {onNavigateToServer ? (
                                        <button
                                          type="button"
                                          onClick={() => onNavigateToServer(alloc.server_id!)}
                                          className="inline-flex items-center gap-1 font-medium text-violet-300 hover:text-violet-200 underline decoration-violet-500/40"
                                        >
                                          <span>
                                            {alloc.server_name || `Server #${alloc.server_id}`}
                                          </span>
                                          <ExternalLink className="h-3 w-3" />
                                        </button>
                                      ) : (
                                        <span className="font-medium text-slate-200">
                                          {alloc.server_name || `Server #${alloc.server_id}`}
                                        </span>
                                      )}
                                      {alloc.is_primary === 1 && (
                                        <span className="text-[11px] font-semibold text-amber-300">
                                          Primary
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-emerald-400 font-medium">Available</span>
                                  )}
                                </td>
                                <td className="px-3 py-2.5 text-slate-400 max-w-[160px] truncate">
                                  {alloc.notes || '—'}
                                </td>
                                <td className="px-3 py-2.5 text-right">
                                  {isAssigned ? (
                                    <span
                                      className="inline-flex items-center gap-1 text-slate-600"
                                      title="In use by a Minecraft server — unassign or delete the server first"
                                    >
                                      <Lock className="h-3.5 w-3.5" />
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => void handleDeleteAllocation(alloc)}
                                      className="rounded p-1 text-slate-400 hover:bg-red-500/15 hover:text-red-300"
                                      title="Delete unassigned allocation"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Cluster Summary Strip */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="cyber-glass rounded-xl p-4">
              <p className="text-xs text-slate-400">Connected VPS Nodes</p>
              <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums">
                {onlineCount} / {nodes.length}
              </p>
              <p className="mt-1 text-xs text-slate-400">Online control-plane &amp; remote daemons</p>
            </div>

            <div className="cyber-glass rounded-xl p-4">
              <p className="text-xs text-slate-400">Provisioned Workloads</p>
              <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums">
                {totalWorkloads}
              </p>
              <p className="mt-1 text-xs text-slate-400">Minecraft containers &amp; Incus VMs</p>
            </div>

            <div className="cyber-glass flex items-center justify-between rounded-xl p-4">
              <div>
                <p className="text-xs text-slate-400">Multi-Node Mesh</p>
                <p className="mt-1 text-sm font-semibold text-white">Ubuntu / Debian Agent</p>
                <p className="mt-0.5 text-xs text-slate-400">Socket.IO encrypted control channel</p>
              </div>
              {isStaff && (
                <button
                  type="button"
                  onClick={() => setShowAddModal(true)}
                  className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Node
                </button>
              )}
            </div>
          </div>

          {/* Node Cards */}
          {loading ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="cyber-glass h-48 animate-pulse rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              {nodes.map((node) => {
                const isOnline = node.status === 'online';
                return (
                  <div key={node.id} className="cyber-glass rounded-xl p-5 space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-violet-500/15 pb-3.5">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                            isOnline
                              ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                              : 'border-slate-600/40 bg-slate-800/40 text-slate-400'
                          }`}
                        >
                          <Server className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedNodeId(node.id);
                                setNodeTab('allocations');
                              }}
                              className="truncate text-base font-semibold text-white hover:text-violet-300 text-left"
                            >
                              {node.name}
                            </button>
                            {node.is_local === 1 && (
                              <span className="text-[11px] font-medium text-violet-300">
                                · Control Plane
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                            <span className="inline-flex items-center gap-1">
                              <Globe className="h-3 w-3 text-violet-400" />
                              {node.location}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono text-slate-300">
                              {node.fqdn}:{node.daemon_port}
                            </span>
                          </div>
                        </div>
                      </div>

                      <span
                        className={`text-xs font-semibold ${
                          isOnline ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {isOnline ? 'Online' : 'Offline'}
                      </span>
                    </div>

                    {/* Live CPU / RAM / Disk Telemetry Meters */}
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <div className="mb-1 flex justify-between text-xs">
                          <span className="text-slate-400">CPU</span>
                          <span className="font-mono text-white tabular-nums">
                            {Number(node.cpu_percent || 0).toFixed(1)}%
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-[#090714]">
                          <div
                            className="h-full bg-violet-500 transition-all"
                            style={{ width: `${Math.min(100, Math.max(0, node.cpu_percent || 0))}%` }}
                          />
                        </div>
                      </div>

                      <div>
                        <div className="mb-1 flex justify-between text-xs">
                          <span className="text-slate-400">RAM</span>
                          <span className="font-mono text-white tabular-nums">
                            {Number(node.ram_percent || 0).toFixed(1)}%
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-[#090714]">
                          <div
                            className="h-full bg-cyan-500 transition-all"
                            style={{ width: `${Math.min(100, Math.max(0, node.ram_percent || 0))}%` }}
                          />
                        </div>
                      </div>

                      <div>
                        <div className="mb-1 flex justify-between text-xs">
                          <span className="text-slate-400">Disk</span>
                          <span className="font-mono text-white tabular-nums">
                            {Number(node.disk_percent || 0).toFixed(1)}%
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-[#090714]">
                          <div
                            className="h-full bg-emerald-500 transition-all"
                            style={{ width: `${Math.min(100, Math.max(0, node.disk_percent || 0))}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-violet-500/15 pt-3 text-xs">
                      <div className="flex flex-wrap items-center gap-3 text-slate-400">
                        <span className="inline-flex items-center gap-1.5">
                          <HardDrive className="h-3.5 w-3.5 text-violet-400" />
                          <strong className="font-mono text-white tabular-nums">
                            {node.workload_count}
                          </strong>{' '}
                          assigned ·{' '}
                          <strong className="font-mono text-white tabular-nums">
                            {node.active_servers}
                          </strong>{' '}
                          running
                        </span>
                        <span className="font-mono text-slate-500">
                          Seen:{' '}
                          {node.last_seen_at
                            ? new Date(node.last_seen_at).toLocaleTimeString()
                            : 'Never'}
                        </span>
                      </div>

                      {isStaff && (
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedNodeId(node.id);
                              setNodeTab('allocations');
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/40 bg-violet-600/20 px-3 py-1 text-xs font-semibold text-violet-200 hover:bg-violet-600/35 whitespace-nowrap shrink-0"
                          >
                            <Network className="h-3.5 w-3.5" />
                            Manage Allocations
                          </button>

                          {node.is_local === 0 && (
                            <>
                              <button
                                type="button"
                                onClick={() => void handleRotateToken(node)}
                                className="inline-flex items-center gap-1 rounded-lg border border-violet-500/35 bg-violet-600/15 px-2.5 py-1 text-xs font-medium text-violet-200 hover:bg-violet-600/30 whitespace-nowrap shrink-0"
                              >
                                <RefreshCw className="h-3 w-3" />
                                Agent Token
                              </button>
                              <button
                                type="button"
                                disabled={node.workload_count > 0}
                                title={
                                  node.workload_count > 0
                                    ? 'Remove or migrate workloads on this node first'
                                    : 'Delete remote node'
                                }
                                onClick={() => void handleDeleteNode(node)}
                                className="rounded p-1.5 text-slate-400 hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ADD REMOTE NODE MODAL */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-md rounded-2xl p-6">
            <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
              <h3 className="text-base font-semibold text-white">Connect Remote VPS Node</h3>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="rounded p-1 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleAddNode} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs text-slate-300">Node Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="EU Game Node #2"
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-slate-300">Location / Region</label>
                <input
                  type="text"
                  required
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="DE · Falkenstein"
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="mb-1 block text-xs text-slate-300">FQDN or IPv4</label>
                  <input
                    type="text"
                    required
                    value={fqdn}
                    onChange={(e) => setFqdn(e.target.value)}
                    placeholder="node2.example.com"
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 font-mono text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-300">Daemon Port</label>
                  <input
                    type="number"
                    required
                    min={1024}
                    max={65535}
                    value={daemonPort}
                    onChange={(e) => setDaemonPort(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 font-mono text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 border-t border-violet-500/15 pt-4">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="rounded-lg border border-violet-500/30 px-4 py-2 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="cyber-glow-btn rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {creating ? 'Generating Token...' : 'Register Node'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 1-CLICK NODE AGENT INSTALL COMMAND MODAL */}
      {tokenReveal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-2xl rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-violet-500/15 pb-3">
              <div className="flex items-center gap-2.5">
                <Terminal className="h-5 w-5 text-violet-400" />
                <div>
                  <h3 className="text-base font-semibold text-white">
                    1-Click Node Agent Setup · {tokenReveal.nodeName}
                  </h3>
                  <p className="text-xs text-slate-400">
                    Run this command on your secondary Ubuntu/Debian VPS as root
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setTokenReveal(null)}
                className="rounded p-1 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-300">
                <span>One-Line Installer Command</span>
                <button
                  type="button"
                  onClick={() => {
                    void copyToClipboard(buildInstallCommand(tokenReveal.rawToken)).then((ok) => {
                      if (ok) setCopiedCmd(true);
                    });
                  }}
                  className="inline-flex items-center gap-1 rounded border border-violet-500/35 px-2.5 py-1 text-xs font-medium text-violet-200 hover:bg-violet-600/20"
                >
                  {copiedCmd ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedCmd ? 'Copied Command' : 'Copy Command'}
                </button>
              </div>
              <pre className="overflow-x-auto rounded-lg border border-violet-500/25 bg-[#070510] p-3.5 font-mono text-xs text-emerald-300">
                {buildInstallCommand(tokenReveal.rawToken)}
              </pre>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-300">
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5 text-amber-400" />
                  Secret Node Token (displayed once)
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void copyToClipboard(tokenReveal.rawToken).then((ok) => {
                      if (ok) setCopiedTok(true);
                    });
                  }}
                  className="inline-flex items-center gap-1 rounded border border-violet-500/35 px-2.5 py-1 text-xs font-medium text-violet-200 hover:bg-violet-600/20"
                >
                  {copiedTok ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedTok ? 'Copied Token' : 'Copy Token'}
                </button>
              </div>
              <code className="block truncate rounded-lg border border-violet-500/20 bg-[#090714] px-3 py-2 font-mono text-xs text-violet-200">
                {tokenReveal.rawToken}
              </code>
            </div>

            <div className="flex justify-end border-t border-violet-500/15 pt-3">
              <button
                type="button"
                onClick={() => setTokenReveal(null)}
                className="cyber-glow-btn rounded-lg px-5 py-2 text-xs font-semibold text-white"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
