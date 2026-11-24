import {
  Archive,
  Box,
  Camera,
  Clock,
  CloudUpload,
  Download,
  HardDrive,
  RotateCcw,
  Search,
  Server,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { apiDownloadFile, apiFetch, formatBytes } from '../lib/api';
import type {
  IncusBackupItem,
  IncusScheduleItem,
  MinecraftBackupItem,
  MinecraftServer,
  ScheduleItem,
  UnifiedBackupsSummary,
  VmInstance,
} from '../types';

interface BackupsViewProps {
  servers: MinecraftServer[];
  instances: VmInstance[];
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

type UnifiedRestorePoint =
  | {
      uid: string;
      workloadType: 'minecraft';
      workloadId: number;
      workloadName: string;
      backupId: number;
      name: string;
      filename: string;
      kindLabel: string;
      backupType: 'manual' | 'scheduled' | 'pre_restore';
      sizeBytes: number;
      createdBy: string;
      createdAt: string;
      cloudProvider: string;
      existsOnDisk: boolean;
      downloadUrl: string;
    }
  | {
      uid: string;
      workloadType: 'incus';
      workloadId: number;
      workloadIdStr?: string;
      workloadName: string;
      instanceType: 'container' | 'vm';
      backupId: number;
      name: string;
      filename: string;
      kind: 'snapshot' | 'archive';
      kindLabel: string;
      backupType: 'manual' | 'scheduled' | 'pre_restore';
      sizeBytes: number;
      createdBy: string;
      createdAt: string;
      cloudProvider: string;
      existsOnDisk: boolean;
      downloadUrl: string | null;
    };

const CRON_PRESETS = [
  { label: 'Hourly', expr: '0 * * * *' },
  { label: 'Every 6h', expr: '0 */6 * * *' },
  { label: 'Daily 03:00', expr: '0 3 * * *' },
  { label: 'Weekly Sun', expr: '0 4 * * 0' },
];

export function BackupsView({ servers, instances, onRefresh, onNotify }: BackupsViewProps) {
  const [subTab, setSubTab] = useState<'points' | 'schedules'>('points');
  const [summary, setSummary] = useState<UnifiedBackupsSummary>({
    mcBackups: [],
    incusBackups: [],
    mcSchedules: [],
    incusSchedules: [],
  });
  const [loading, setLoading] = useState(true);

  // Target selection for 1-click backup / snapshot
  const defaultTarget =
    servers.length > 0
      ? `mc:${servers[0].id}`
      : instances.length > 0
      ? `vm:${instances[0].id}`
      : '';
  const [targetValue, setTargetValue] = useState(defaultTarget);
  const [customLabel, setCustomLabel] = useState('');
  const [vmKind, setVmKind] = useState<'snapshot' | 'archive'>('snapshot');
  const [creating, setCreating] = useState(false);

  // Filter & Search for Restore Points
  const [typeFilter, setTypeFilter] = useState<'all' | 'minecraft' | 'incus'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Restore confirmation modal
  const [restoreTarget, setRestoreTarget] = useState<UnifiedRestorePoint | null>(null);
  const [createPreRestore, setCreatePreRestore] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [uploadingUid, setUploadingUid] = useState<string | null>(null);

  // Schedule creation state
  const [schedTarget, setSchedTarget] = useState(defaultTarget);
  const [schedName, setSchedName] = useState('');
  const [schedCron, setSchedCron] = useState('0 3 * * *');
  const [schedVmAction, setSchedVmAction] = useState<'snapshot' | 'local_backup'>('snapshot');
  const [schedRetention, setSchedRetention] = useState(7);
  const [creatingSched, setCreatingSched] = useState(false);

  useEffect(() => {
    if (!targetValue && defaultTarget) setTargetValue(defaultTarget);
    if (!schedTarget && defaultTarget) setSchedTarget(defaultTarget);
  }, [defaultTarget, targetValue, schedTarget]);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<UnifiedBackupsSummary>('/api/backups/summary');
      setSummary(res);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load backups summary', 'error');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const selectedTargetParsed = useMemo(() => {
    const [prefix, rawId] = targetValue.split(':');
    const id = Number(rawId);
    if (!id) return null;
    if (prefix === 'mc') return { type: 'mc' as const, id };
    if (prefix === 'vm') return { type: 'vm' as const, id };
    return null;
  }, [targetValue]);

  const selectedSchedParsed = useMemo(() => {
    const [prefix, rawId] = schedTarget.split(':');
    const id = Number(rawId);
    if (!id) return null;
    if (prefix === 'mc') return { type: 'mc' as const, id };
    if (prefix === 'vm') return { type: 'vm' as const, id };
    return null;
  }, [schedTarget]);

  const unifiedPoints = useMemo<UnifiedRestorePoint[]>(() => {
    const mcPts: UnifiedRestorePoint[] = summary.mcBackups.map((b: MinecraftBackupItem) => ({
      uid: `mc-${b.id}`,
      workloadType: 'minecraft',
      workloadId: b.server_id,
      workloadName: b.server_name || `Server #${b.server_id}`,
      backupId: b.id,
      name: b.name,
      filename: b.filename || `${b.name}.tar.gz`,
      kindLabel: (b.filename || '').endsWith('.tar.gz') ? 'Tarball (.tar.gz)' : 'Zip Archive',
      backupType: b.backup_type,
      sizeBytes: b.size_bytes,
      createdBy: b.created_by,
      createdAt: b.created_at,
      cloudProvider: b.cloud_provider || 'local',
      existsOnDisk: b.exists_on_disk !== false,
      downloadUrl: `/api/minecraft/servers/${b.server_id}/backups/${b.id}/download`,
    }));

    const vmPts: UnifiedRestorePoint[] = summary.incusBackups.map((b: IncusBackupItem) => ({
      uid: `vm-${b.id}`,
      workloadType: 'incus',
      workloadId: b.instance_id,
      workloadName: b.instance_display_name || b.instance_name || `Instance #${b.instance_id}`,
      instanceType: b.instance_type || 'container',
      backupId: b.id,
      name: b.name,
      filename: b.archive_filename || `${b.name}.tar.gz`,
      kind: b.backup_kind,
      kindLabel: b.backup_kind === 'archive' ? 'Tarball (.tar.gz)' : 'CoW Snapshot',
      backupType: b.backup_type,
      sizeBytes: b.size_bytes,
      createdBy: b.created_by,
      createdAt: b.created_at,
      cloudProvider: b.cloud_provider || 'local',
      existsOnDisk: b.backup_kind === 'snapshot' ? true : b.exists_on_disk !== false,
      downloadUrl:
        b.backup_kind === 'archive'
          ? `/api/incus/instances/${b.instance_id}/backups/${b.id}/download`
          : null,
    }));

    return [...mcPts, ...vmPts]
      .filter((pt) => (typeFilter === 'all' ? true : pt.workloadType === typeFilter))
      .filter((pt) => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return (
          pt.workloadName.toLowerCase().includes(q) ||
          pt.name.toLowerCase().includes(q) ||
          pt.kindLabel.toLowerCase().includes(q) ||
          pt.cloudProvider.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [summary.mcBackups, summary.incusBackups, typeFilter, searchQuery]);

  async function handleOneClickCreate(e: FormEvent) {
    e.preventDefault();
    if (!selectedTargetParsed) return;
    setCreating(true);
    try {
      if (selectedTargetParsed.type === 'mc') {
        await apiFetch(`/api/minecraft/servers/${selectedTargetParsed.id}/backups`, {
          method: 'POST',
          body: JSON.stringify({ name: customLabel.trim() || undefined }),
        });
        onNotify('Minecraft .tar.gz backup created.');
      } else {
        await apiFetch(`/api/incus/instances/${selectedTargetParsed.id}/backups`, {
          method: 'POST',
          body: JSON.stringify({
            name: customLabel.trim() || undefined,
            kind: vmKind,
          }),
        });
        onNotify(
          vmKind === 'archive'
            ? 'VM/LXC .tar.gz archive exported.'
            : 'VM/LXC point-in-time snapshot created.'
        );
      }
      setCustomLabel('');
      await loadSummary();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Backup creation failed', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleConfirmRestore() {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      if (restoreTarget.workloadType === 'minecraft') {
        await apiFetch(
          `/api/minecraft/servers/${restoreTarget.workloadId}/backups/${restoreTarget.backupId}/restore`,
          {
            method: 'POST',
            body: JSON.stringify({ createPreRestore }),
          }
        );
      } else {
        await apiFetch(
          `/api/incus/instances/${restoreTarget.workloadId}/backups/${restoreTarget.backupId}/restore`,
          {
            method: 'POST',
            body: JSON.stringify({ createPreRestore }),
          }
        );
      }
      onNotify(`Restored '${restoreTarget.workloadName}' to '${restoreTarget.name}'.`);
      setRestoreTarget(null);
      await Promise.all([loadSummary(), onRefresh()]);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Point-in-time restore failed', 'error');
    } finally {
      setRestoring(false);
    }
  }

  async function handleUploadToCloud(pt: UnifiedRestorePoint) {
    setUploadingUid(pt.uid);
    try {
      if (pt.workloadType === 'minecraft') {
        await apiFetch(`/api/minecraft/servers/${pt.workloadId}/backups/${pt.backupId}/cloud`, {
          method: 'POST',
        });
      } else {
        await apiFetch(`/api/incus/instances/${pt.workloadId}/backups/${pt.backupId}/cloud`, {
          method: 'POST',
        });
      }
      onNotify(`Offloaded '${pt.name}' to configured cloud storage.`);
      await loadSummary();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Cloud upload failed', 'error');
    } finally {
      setUploadingUid(null);
    }
  }

  async function handleDeletePoint(pt: UnifiedRestorePoint) {
    try {
      if (pt.workloadType === 'minecraft') {
        await apiFetch(`/api/minecraft/servers/${pt.workloadId}/backups/${pt.backupId}`, {
          method: 'DELETE',
        });
      } else {
        await apiFetch(`/api/incus/instances/${pt.workloadId}/backups/${pt.backupId}`, {
          method: 'DELETE',
        });
      }
      onNotify(`Deleted restore point '${pt.name}'.`);
      await loadSummary();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  }

  async function handleCreateSchedule(e: FormEvent) {
    e.preventDefault();
    if (!selectedSchedParsed) return;
    setCreatingSched(true);
    try {
      if (selectedSchedParsed.type === 'mc') {
        await apiFetch(`/api/minecraft/servers/${selectedSchedParsed.id}/schedules`, {
          method: 'POST',
          body: JSON.stringify({
            name: schedName.trim(),
            cronExpr: schedCron.trim(),
            action: 'backup',
            retentionCount: Number(schedRetention),
          }),
        });
      } else {
        await apiFetch(`/api/incus/instances/${selectedSchedParsed.id}/schedules`, {
          method: 'POST',
          body: JSON.stringify({
            name: schedName.trim(),
            cronExpr: schedCron.trim(),
            action: schedVmAction,
            retentionCount: Number(schedRetention),
          }),
        });
      }
      setSchedName('');
      onNotify('Automated backup schedule created.');
      await loadSummary();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create schedule', 'error');
    } finally {
      setCreatingSched(false);
    }
  }

  async function handleToggleMcSchedule(s: ScheduleItem) {
    try {
      await apiFetch(`/api/minecraft/servers/${s.server_id}/schedules/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      await loadSummary();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Toggle failed', 'error');
    }
  }

  async function handleDeleteMcSchedule(s: ScheduleItem) {
    try {
      await apiFetch(`/api/minecraft/servers/${s.server_id}/schedules/${s.id}`, {
        method: 'DELETE',
      });
      await loadSummary();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  }

  async function handleToggleIncusSchedule(s: IncusScheduleItem) {
    try {
      await apiFetch(`/api/incus/instances/${s.instance_id}/schedules/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      await loadSummary();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Toggle failed', 'error');
    }
  }

  async function handleDeleteIncusSchedule(s: IncusScheduleItem) {
    try {
      await apiFetch(`/api/incus/instances/${s.instance_id}/schedules/${s.id}`, {
        method: 'DELETE',
      });
      await loadSummary();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  }

  const totalStorageBytes = useMemo(() => {
    const mcBytes = summary.mcBackups.reduce((acc, b) => acc + (b.size_bytes || 0), 0);
    const vmBytes = summary.incusBackups.reduce((acc, b) => acc + (b.size_bytes || 0), 0);
    return mcBytes + vmBytes;
  }, [summary.mcBackups, summary.incusBackups]);

  const totalSchedules = summary.mcSchedules.length + summary.incusSchedules.length;

  return (
    <div className="space-y-6">
      {/* Top KPI Summary Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="cyber-glass rounded-xl p-4">
          <p className="text-xs text-slate-400">Available Restore Points</p>
          <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums">
            {summary.mcBackups.length + summary.incusBackups.length}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {summary.mcBackups.length} Minecraft · {summary.incusBackups.length} VM/LXC
          </p>
        </div>

        <div className="cyber-glass rounded-xl p-4">
          <p className="text-xs text-slate-400">Local Backup Storage</p>
          <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums">
            {formatBytes(totalStorageBytes)}
          </p>
          <p className="mt-1 text-xs text-slate-400">Confined local vault archives</p>
        </div>

        <div className="cyber-glass rounded-xl p-4">
          <p className="text-xs text-slate-400">Automated Backup Rules</p>
          <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums">
            {totalSchedules}
          </p>
          <p className="mt-1 text-xs text-slate-400">Cron jobs with retention pruning</p>
        </div>
      </div>

      {/* 1-Click Snapshot & Local Backup Bar */}
      <div className="cyber-glass rounded-xl p-5">
        <div className="mb-3 flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-violet-400" />
          <h2 className="text-sm font-semibold text-white">One-Click Snapshot &amp; Local Backup</h2>
        </div>

        {servers.length === 0 && instances.length === 0 ? (
          <p className="text-xs text-slate-400">
            Deploy a Minecraft server or Incus container/VM first to create restore points.
          </p>
        ) : (
          <form onSubmit={handleOneClickCreate} className="grid grid-cols-1 gap-3 md:grid-cols-12">
            <div className="md:col-span-4">
              <label className="mb-1 block text-xs text-slate-400">Target Workload</label>
              <select
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 text-xs text-white"
              >
                {servers.length > 0 && (
                  <optgroup label="Minecraft Servers">
                    {servers.map((s) => (
                      <option key={`mc-${s.id}`} value={`mc:${s.id}`}>
                        [MC] {s.name} ({s.software})
                      </option>
                    ))}
                  </optgroup>
                )}
                {instances.length > 0 && (
                  <optgroup label="Incus VMs & LXC">
                    {instances.map((i) => (
                      <option key={`vm-${i.id}`} value={`vm:${i.id}`}>
                        [{i.type.toUpperCase()}] {i.name} ({i.os_template})
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            {selectedTargetParsed?.type === 'vm' && (
              <div className="md:col-span-3">
                <label className="mb-1 block text-xs text-slate-400">Capture Mode</label>
                <select
                  value={vmKind}
                  onChange={(e) => setVmKind(e.target.value as 'snapshot' | 'archive')}
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 text-xs text-white"
                >
                  <option value="snapshot">Instant CoW Snapshot</option>
                  <option value="archive">Local Export (.tar.gz)</option>
                </select>
              </div>
            )}

            <div className={selectedTargetParsed?.type === 'vm' ? 'md:col-span-3' : 'md:col-span-5'}>
              <label className="mb-1 block text-xs text-slate-400">Label (Optional)</label>
              <input
                type="text"
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
                placeholder="e.g. pre-update-checkpoint"
                className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
              />
            </div>

            <div
              className={`flex items-end ${
                selectedTargetParsed?.type === 'vm' ? 'md:col-span-2' : 'md:col-span-3'
              }`}
            >
              <button
                type="submit"
                disabled={creating || !selectedTargetParsed}
                className="cyber-glow-btn inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {selectedTargetParsed?.type === 'vm' && vmKind === 'snapshot' ? (
                  <Camera className="h-3.5 w-3.5" />
                ) : (
                  <Archive className="h-3.5 w-3.5" />
                )}
                {creating
                  ? 'Working...'
                  : selectedTargetParsed?.type === 'vm' && vmKind === 'snapshot'
                  ? 'Take Snapshot'
                  : 'Backup Now'}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Main Workspace Tabs */}
      <div className="cyber-glass rounded-xl p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-violet-500/15 pb-3">
          <div className="flex items-center gap-1 rounded-lg bg-[#090714]/80 p-1">
            <button
              type="button"
              onClick={() => setSubTab('points')}
              className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                subTab === 'points' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Restore Points
            </button>
            <button
              type="button"
              onClick={() => setSubTab('schedules')}
              className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                subTab === 'schedules'
                  ? 'bg-violet-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Automated Schedules
            </button>
          </div>

          {subTab === 'points' && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-lg bg-[#090714]/80 p-1">
                {(
                  [
                    ['all', 'All'],
                    ['minecraft', 'Minecraft'],
                    ['incus', 'VMs & LXC'],
                  ] as const
                ).map(([f, lbl]) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setTypeFilter(f)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                      typeFilter === f
                        ? 'bg-violet-600/30 text-violet-200'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              <div className="relative min-w-[200px]">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter checkpoints..."
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 py-1.5 pr-3 pl-8 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                />
              </div>
            </div>
          )}
        </div>

        {/* SUB-TAB 1: POINT-IN-TIME RESTORE POINTS */}
        {subTab === 'points' && (
          <>
            {loading ? (
              <div className="space-y-2 py-4">
                {Array.from({ length: 4 }).map((_, idx) => (
                  <div key={idx} className="h-10 animate-pulse rounded bg-violet-950/35" />
                ))}
              </div>
            ) : unifiedPoints.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-400">
                No snapshots or local backups found for the current filter.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                      <th className="pb-2.5 font-medium">Workload</th>
                      <th className="pb-2.5 font-medium">Point Name</th>
                      <th className="pb-2.5 font-medium">Format</th>
                      <th className="pb-2.5 font-medium">Storage</th>
                      <th className="pb-2.5 font-medium">Trigger</th>
                      <th className="pb-2.5 font-medium text-right">Size</th>
                      <th className="pb-2.5 font-medium">Created</th>
                      <th className="pb-2.5 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-violet-500/10">
                    {unifiedPoints.map((pt) => {
                      const hasCloud = Boolean(pt.cloudProvider && pt.cloudProvider !== 'local');
                      const canRestoreOrDownload = pt.existsOnDisk || hasCloud;
                      const isArchive =
                        pt.workloadType === 'minecraft' ||
                        (pt.workloadType === 'incus' && pt.kind === 'archive');

                      return (
                        <tr key={pt.uid} className="hover:bg-violet-500/5">
                          <td className="py-2.5 pr-3">
                            <div className="flex items-center gap-2">
                              {pt.workloadType === 'minecraft' ? (
                                <Box className="h-3.5 w-3.5 text-violet-400 shrink-0" />
                              ) : (
                                <Server className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
                              )}
                              <span className="text-xs font-semibold text-white">
                                {pt.workloadName}
                              </span>
                            </div>
                          </td>
                          <td className="py-2.5 pr-3 font-mono text-xs text-slate-200">{pt.name}</td>
                          <td className="py-2.5 pr-3 text-xs text-slate-300">{pt.kindLabel}</td>
                          <td className="py-2.5 pr-3 font-mono text-xs uppercase">
                            {hasCloud ? (
                              <span className="text-cyan-300">
                                {pt.existsOnDisk ? `Local + ${pt.cloudProvider}` : `Cloud (${pt.cloudProvider})`}
                              </span>
                            ) : (
                              <span className="text-slate-400">Local</span>
                            )}
                          </td>
                          <td className="py-2.5 pr-3 text-xs capitalize text-slate-400">
                            {pt.backupType.replace('_', ' ')}
                          </td>
                          <td className="py-2.5 pr-3 text-right font-mono text-xs text-slate-300 tabular-nums">
                            {pt.sizeBytes > 0 ? formatBytes(pt.sizeBytes) : '--'}
                          </td>
                          <td className="py-2.5 pr-3 font-mono text-xs text-slate-400 tabular-nums">
                            {new Date(pt.createdAt).toLocaleString()}
                          </td>
                          <td className="py-2.5 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={!canRestoreOrDownload}
                                onClick={() => {
                                  setCreatePreRestore(true);
                                  setRestoreTarget(pt);
                                }}
                                className="inline-flex items-center gap-1 rounded border border-violet-500/35 bg-violet-600/15 px-2.5 py-1 text-xs font-medium text-violet-200 hover:bg-violet-600/30 disabled:opacity-40 whitespace-nowrap shrink-0"
                              >
                                <RotateCcw className="h-3 w-3" />
                                Restore
                              </button>
                              {isArchive && pt.existsOnDisk && !hasCloud && (
                                <button
                                  type="button"
                                  disabled={uploadingUid === pt.uid}
                                  onClick={() => void handleUploadToCloud(pt)}
                                  title="Offload backup to Cloud Storage"
                                  className="rounded border border-cyan-500/30 p-1 text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40"
                                >
                                  <CloudUpload className="h-3.5 w-3.5" />
                                </button>
                              )}
                              {pt.downloadUrl && canRestoreOrDownload && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void apiDownloadFile(pt.downloadUrl!, pt.filename)
                                  }
                                  title="Download archive"
                                  className="rounded border border-violet-500/25 p-1 text-slate-300 hover:bg-violet-600/20 hover:text-white"
                                >
                                  <Download className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void handleDeletePoint(pt)}
                                title="Delete restore point"
                                className="rounded p-1 text-slate-400 hover:bg-red-500/15 hover:text-red-300"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* SUB-TAB 2: AUTOMATED BACKUP & SNAPSHOT SCHEDULES */}
        {subTab === 'schedules' && (
          <div className="space-y-6">
            {servers.length + instances.length > 0 && (
              <form
                onSubmit={handleCreateSchedule}
                className="space-y-3 rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4"
              >
                <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
                  <div className="md:col-span-3">
                    <label className="mb-1 block text-xs text-slate-400">Workload</label>
                    <select
                      value={schedTarget}
                      onChange={(e) => setSchedTarget(e.target.value)}
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 text-xs text-white"
                    >
                      {servers.map((s) => (
                        <option key={`smc-${s.id}`} value={`mc:${s.id}`}>
                          [MC] {s.name}
                        </option>
                      ))}
                      {instances.map((i) => (
                        <option key={`svm-${i.id}`} value={`vm:${i.id}`}>
                          [{i.type.toUpperCase()}] {i.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="md:col-span-3">
                    <label className="mb-1 block text-xs text-slate-400">Schedule Name</label>
                    <input
                      type="text"
                      required
                      value={schedName}
                      onChange={(e) => setSchedName(e.target.value)}
                      placeholder="Nightly World Backup"
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 text-xs text-white"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="mb-1 block text-xs text-slate-400">Cron Expression</label>
                    <input
                      type="text"
                      required
                      value={schedCron}
                      onChange={(e) => setSchedCron(e.target.value)}
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 font-mono text-xs text-white"
                    />
                  </div>

                  {selectedSchedParsed?.type === 'vm' && (
                    <div className="md:col-span-2">
                      <label className="mb-1 block text-xs text-slate-400">Action</label>
                      <select
                        value={schedVmAction}
                        onChange={(e) =>
                          setSchedVmAction(e.target.value as 'snapshot' | 'local_backup')
                        }
                        className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-2.5 py-2 text-xs text-white"
                      >
                        <option value="snapshot">CoW Snapshot</option>
                        <option value="local_backup">Local .tar.gz</option>
                      </select>
                    </div>
                  )}

                  <div
                    className={
                      selectedSchedParsed?.type === 'vm' ? 'md:col-span-1' : 'md:col-span-2'
                    }
                  >
                    <label className="mb-1 block text-xs text-slate-400">Keep Last</label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={schedRetention}
                      onChange={(e) => setSchedRetention(Number(e.target.value))}
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 font-mono text-xs text-white"
                    />
                  </div>

                  <div
                    className={`flex items-end ${
                      selectedSchedParsed?.type === 'vm' ? 'md:col-span-1' : 'md:col-span-2'
                    }`}
                  >
                    <button
                      type="submit"
                      disabled={creatingSched}
                      className="cyber-glow-btn inline-flex w-full items-center justify-center gap-1 rounded-lg px-3 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                    >
                      <Clock className="h-3.5 w-3.5" />
                      Save
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-400">Quick Presets:</span>
                  {CRON_PRESETS.map((p) => (
                    <button
                      key={p.expr}
                      type="button"
                      onClick={() => setSchedCron(p.expr)}
                      className={`rounded border px-2 py-0.5 font-mono text-xs transition-colors ${
                        schedCron === p.expr
                          ? 'border-violet-400 bg-violet-600/25 text-white'
                          : 'border-violet-500/25 text-slate-300 hover:border-violet-400/50'
                      }`}
                    >
                      {p.label} ({p.expr})
                    </button>
                  ))}
                </div>
              </form>
            )}

            {totalSchedules === 0 ? (
              <p className="py-8 text-center text-sm text-slate-400">
                No automated backup or snapshot schedules configured yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                      <th className="pb-2.5 font-medium">Workload</th>
                      <th className="pb-2.5 font-medium">Rule Name</th>
                      <th className="pb-2.5 font-medium">Mode</th>
                      <th className="pb-2.5 font-medium">Cron</th>
                      <th className="pb-2.5 font-medium text-right">Retention</th>
                      <th className="pb-2.5 font-medium">Last Run</th>
                      <th className="pb-2.5 font-medium text-right">Controls</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-violet-500/10">
                    {summary.mcSchedules.map((s) => (
                      <tr key={`mcs-${s.id}`}>
                        <td className="py-2.5 text-xs font-semibold text-white">
                          {s.server_name || `MC #${s.server_id}`}
                        </td>
                        <td className="py-2.5 text-xs text-slate-200">{s.name}</td>
                        <td className="py-2.5 text-xs text-violet-300">MC Tarball (.tar.gz)</td>
                        <td className="py-2.5 font-mono text-xs text-slate-300">{s.cron_expr}</td>
                        <td className="py-2.5 text-right font-mono text-xs text-slate-300 tabular-nums">
                          {s.retention_count || 7}
                        </td>
                        <td className="py-2.5 font-mono text-xs text-slate-400">
                          {s.last_run_at ? new Date(s.last_run_at).toLocaleString() : 'Never'}
                        </td>
                        <td className="py-2.5 text-right">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void handleToggleMcSchedule(s)}
                              className={`rounded px-2.5 py-1 text-xs font-medium ${
                                s.enabled
                                  ? 'bg-emerald-500/15 text-emerald-300'
                                  : 'bg-slate-800 text-slate-400'
                              }`}
                            >
                              {s.enabled ? 'Enabled' : 'Paused'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteMcSchedule(s)}
                              className="rounded p-1 text-slate-400 hover:text-red-300"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {summary.incusSchedules.map((s) => (
                      <tr key={`vms-${s.id}`}>
                        <td className="py-2.5 text-xs font-semibold text-white">
                          {s.instance_display_name || `Instance #${s.instance_id}`}
                        </td>
                        <td className="py-2.5 text-xs text-slate-200">{s.name}</td>
                        <td className="py-2.5 text-xs text-cyan-300">
                          {s.action === 'local_backup' ? 'Local .tar.gz' : 'CoW Snapshot'}
                        </td>
                        <td className="py-2.5 font-mono text-xs text-slate-300">{s.cron_expr}</td>
                        <td className="py-2.5 text-right font-mono text-xs text-slate-300 tabular-nums">
                          {s.retention_count}
                        </td>
                        <td className="py-2.5 font-mono text-xs text-slate-400">
                          {s.last_run_at ? new Date(s.last_run_at).toLocaleString() : 'Never'}
                        </td>
                        <td className="py-2.5 text-right">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void handleToggleIncusSchedule(s)}
                              className={`rounded px-2.5 py-1 text-xs font-medium ${
                                s.enabled
                                  ? 'bg-emerald-500/15 text-emerald-300'
                                  : 'bg-slate-800 text-slate-400'
                              }`}
                            >
                              {s.enabled ? 'Enabled' : 'Paused'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteIncusSchedule(s)}
                              className="rounded p-1 text-slate-400 hover:text-red-300"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* POINT-IN-TIME RESTORE CONFIRMATION MODAL */}
      {restoreTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-md rounded-2xl p-6">
            <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-amber-400" />
                <h3 className="text-base font-semibold text-white">Confirm Point-in-Time Restore</h3>
              </div>
              <button
                type="button"
                onClick={() => setRestoreTarget(null)}
                className="rounded p-1 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs text-slate-300">
              <p>
                Restoring <strong className="text-white">{restoreTarget.workloadName}</strong> to
                checkpoint <span className="font-mono text-violet-300">{restoreTarget.name}</span>{' '}
                will replace current runtime files/state.
              </p>
              <label className="flex items-center gap-2.5 rounded-lg border border-violet-500/20 bg-[#090714]/70 p-3 text-slate-200">
                <input
                  type="checkbox"
                  checked={createPreRestore}
                  onChange={(e) => setCreatePreRestore(e.target.checked)}
                  className="h-4 w-4 accent-violet-600"
                />
                <span>
                  Create automatic safety{' '}
                  {restoreTarget.workloadType === 'incus' ? 'snapshot' : 'backup'} before restoring
                </span>
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-3 border-t border-violet-500/15 pt-4">
              <button
                type="button"
                onClick={() => setRestoreTarget(null)}
                className="rounded-lg border border-violet-500/30 px-4 py-2 text-xs text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={restoring}
                onClick={() => void handleConfirmRestore()}
                className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {restoring ? 'Restoring...' : 'Restore Now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
