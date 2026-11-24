import {
  AlertTriangle,
  Archive,
  Bot,
  Check,
  ChevronRight,
  Clock,
  CloudUpload,
  Copy,
  Download,
  FileCode2,
  FilePlus,
  Folder,
  FolderPlus,
  Network,
  Package,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Shield,
  ShieldAlert,
  Skull,
  Square,
  Star,
  Trash2,
  Upload,
  UserCheck,
  UserPlus,
  X,
} from 'lucide-react';
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { apiDownloadFile, apiFetch, copyToClipboard, formatBytes } from '../lib/api';
import type {
  AllocationItem,
  AuthUser,
  FileEntry,
  ManagedUser,
  MinecraftBackupItem,
  MinecraftServer,
  ModrinthHit,
  NodeItem,
  ScheduleItem,
  SubUserItem,
} from '../types';
import { AiAssistantDrawer } from './ai/AiAssistantDrawer';
import { CodeEditorView } from './CodeEditorView';
import { type MetricPoint, ResourceChart } from './ResourceChart';
import { TerminalView } from './TerminalView';

interface MinecraftViewProps {
  currentUser: AuthUser;
  servers: MinecraftServer[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onRefresh: () => Promise<void>;
  socket: Socket | null;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  openDeploySignal: number;
}

const SOFTWARE_OPTIONS = ['PAPER', 'PURPUR', 'SPIGOT', 'VANILLA', 'FORGE', 'FABRIC', 'VELOCITY'];
const VERSION_PRESETS = ['1.21.4', '1.21.1', '1.20.4', '1.19.4', '1.16.5', '1.12.2', '1.8.8', 'LATEST'];

const MC_COLOR_MAP: Record<string, string> = {
  '0': '#000000',
  '1': '#0000aa',
  '2': '#00aa00',
  '3': '#00aaaa',
  '4': '#aa0000',
  '5': '#aa00aa',
  '6': '#ffaa00',
  '7': '#aaaaaa',
  '8': '#555555',
  '9': '#5555ff',
  a: '#55ff55',
  b: '#55ffff',
  c: '#ff5555',
  d: '#ff55ff',
  e: '#ffff55',
  f: '#ffffff',
};

function renderMotdPreview(motd: string) {
  const parts = motd.split(/(§[0-9a-fA-Flonmrk])/g);
  let color = '#e2e8f0';
  let bold = false;
  let italic = false;

  return parts.map((part, idx) => {
    if (part.startsWith('§') && part.length === 2) {
      const code = part[1].toLowerCase();
      if (MC_COLOR_MAP[code]) {
        color = MC_COLOR_MAP[code];
        bold = false;
        italic = false;
      } else if (code === 'l') bold = true;
      else if (code === 'o') italic = true;
      else if (code === 'r') {
        color = '#e2e8f0';
        bold = false;
        italic = false;
      }
      return null;
    }
    return (
      <span
        key={idx}
        style={{
          color,
          fontWeight: bold ? 700 : 400,
          fontStyle: italic ? 'italic' : 'normal',
        }}
      >
        {part}
      </span>
    );
  });
}

export function MinecraftView({
  currentUser,
  servers,
  selectedId,
  onSelect,
  onRefresh,
  socket,
  onNotify,
  openDeploySignal,
}: MinecraftViewProps) {
  const [activeTab, setActiveTab] = useState<
    | 'console'
    | 'network'
    | 'properties'
    | 'players'
    | 'backups'
    | 'schedules'
    | 'subusers'
    | 'files'
    | 'modrinth'
    | 'settings'
  >('console');
  const [showDeploy, setShowDeploy] = useState(false);
  const [allUsers, setAllUsers] = useState<ManagedUser[]>([]);
  const [nodes, setNodes] = useState<NodeItem[]>([]);

  // Deploy Form State
  const [name, setName] = useState('');
  const [software, setSoftware] = useState('PAPER');
  const [version, setVersion] = useState('1.21.4');
  const [ramMb, setRamMb] = useState(2048);
  const [cpuPercent, setCpuPercent] = useState(200);
  const [availableNodeAllocs, setAvailableNodeAllocs] = useState<AllocationItem[]>([]);
  const [primaryAllocationChoice, setPrimaryAllocationChoice] = useState<string>('auto');
  const [additionalAllocationIds, setAdditionalAllocationIds] = useState<number[]>([]);
  const [nodeId, setNodeId] = useState<number>(1);
  const [assignOwnerId, setAssignOwnerId] = useState<number>(currentUser.id);
  const [eulaAccepted, setEulaAccepted] = useState(true);
  const [deploying, setDeploying] = useState(false);

  // Console & Live Resource Chart State
  const [commandInput, setCommandInput] = useState('');
  const termWriteRef = useRef<((chunk: string) => void) | null>(null);
  const termClearRef = useRef<(() => void) | null>(null);
  const [metricPoints, setMetricPoints] = useState<MetricPoint[]>([]);
  const [metricLive, setMetricLive] = useState(false);

  // Properties Visual Editor State
  const [props, setProps] = useState<Record<string, string>>({});
  const [savingProps, setSavingProps] = useState(false);

  // Player Manager State
  const [playersData, setPlayersData] = useState<{
    online: Array<{ name: string; isOp: boolean }>;
    ops: string[];
    banned: string[];
  }>({ online: [], ops: [], banned: [] });
  const [manualPlayer, setManualPlayer] = useState('');

  // Backups State
  const [backups, setBackups] = useState<MinecraftBackupItem[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backupLabel, setBackupLabel] = useState('');
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [uploadingBackupId, setUploadingBackupId] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<MinecraftBackupItem | null>(null);
  const [restoreSafetyBackup, setRestoreSafetyBackup] = useState(true);
  const [restoringBackup, setRestoringBackup] = useState(false);

  // Schedules State
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [schedName, setSchedName] = useState('');
  const [schedCron, setSchedCron] = useState('0 */6 * * *');
  const [schedAction, setSchedAction] = useState<'restart' | 'backup' | 'command'>('restart');
  const [schedPayload, setSchedPayload] = useState('');
  const [schedRetention, setSchedRetention] = useState(7);

  // Sub-users State
  const [subusers, setSubusers] = useState<SubUserItem[]>([]);
  const [subIdentifier, setSubIdentifier] = useState('');
  const [subStartStop, setSubStartStop] = useState(true);
  const [subConsole, setSubConsole] = useState(true);
  const [subFiles, setSubFiles] = useState(false);
  const [subBackups, setSubBackups] = useState(false);

  // File Manager State
  const [currentDir, setCurrentDir] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [editingFile, setEditingFile] = useState<{ path: string; content: string } | null>(null);
  const [savingFile, setSavingFile] = useState(false);
  const [newEntryName, setNewEntryName] = useState('');
  const [newEntryType, setNewEntryType] = useState<'file' | 'folder' | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  // Modrinth State
  const [modQuery, setModQuery] = useState('');
  const [modType, setModType] = useState<'plugin' | 'mod'>('plugin');
  const [modHits, setModHits] = useState<ModrinthHit[]>([]);
  const [modSearching, setModSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);

  // Network / Allocations State
  const [serverAllocations, setServerAllocations] = useState<AllocationItem[]>([]);
  const [maxAllocations, setMaxAllocations] = useState<number>(3);
  const [allocsLoading, setAllocsLoading] = useState(false);
  const [newAllocNotes, setNewAllocNotes] = useState('');
  const [claimingAlloc, setClaimingAlloc] = useState(false);
  const [networkRestartRequired, setNetworkRestartRequired] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [editingNoteVal, setEditingNoteVal] = useState('');
  const [copiedAddressId, setCopiedAddressId] = useState<string | number | null>(null);

  // Admin Limits & Delete State
  const [adminOwnerId, setAdminOwnerId] = useState<number>(currentUser.id);
  const [adminRam, setAdminRam] = useState<number>(2048);
  const [adminCpu, setAdminCpu] = useState<number>(200);
  const [adminMaxAllocations, setAdminMaxAllocations] = useState<number>(3);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showAiDrawer, setShowAiDrawer] = useState(false);

  const isStaff = currentUser.role === 'owner' || currentUser.role === 'admin';
  const selectedServer = servers.find((s) => s.id === selectedId) || servers[0] || null;

  useEffect(() => {
    apiFetch<{ nodes: NodeItem[] }>('/api/nodes')
      .then((res) => {
        setNodes(res.nodes);
        if (res.nodes.length > 0 && !res.nodes.some((n) => n.id === nodeId)) {
          setNodeId(res.nodes[0].id);
        }
      })
      .catch(() => {});
    if (isStaff) {
      apiFetch<{ users: ManagedUser[] }>('/api/users')
        .then((res) => setAllUsers(res.users))
        .catch(() => {});
    }
  }, [isStaff]);

  useEffect(() => {
    if (!showDeploy) return;
    apiFetch<{ allocations: AllocationItem[] }>(`/api/nodes/${nodeId}/allocations/available`)
      .then((res) => {
        setAvailableNodeAllocs(res.allocations);
        setPrimaryAllocationChoice('auto');
        setAdditionalAllocationIds([]);
      })
      .catch(() => {
        setAvailableNodeAllocs([]);
      });
  }, [showDeploy, nodeId]);

  useEffect(() => {
    if (openDeploySignal > 0) setShowDeploy(true);
  }, [openDeploySignal]);

  useEffect(() => {
    if (!selectedId && servers.length > 0) {
      onSelect(servers[0].id);
    }
  }, [servers, selectedId, onSelect]);

  useEffect(() => {
    setCurrentDir('');
    setEditingFile(null);
    setConfirmDelete(false);
    setMetricPoints([]);
    setNetworkRestartRequired(false);
    if (selectedServer) {
      setModType(
        selectedServer.software === 'FABRIC' || selectedServer.software === 'FORGE' ? 'mod' : 'plugin'
      );
      setAdminOwnerId(selectedServer.owner_id || currentUser.id);
      setAdminRam(selectedServer.ram_mb);
      setAdminCpu(selectedServer.cpu_percent);
      setAdminMaxAllocations(selectedServer.max_allocations || 3);
    }
  }, [selectedServer?.id]);

  // Poll live container metrics for Chart.js 10m window
  useEffect(() => {
    if (!selectedServer) return;
    let active = true;

    const poll = () => {
      apiFetch<{ cpuPercent: number; ramUsedMb: number; ramLimitMb: number; live: boolean }>(
        `/api/minecraft/servers/${selectedServer.id}/metrics`
      )
        .then((m) => {
          if (!active) return;
          setMetricLive(m.live);
          const nowLabel = new Date().toLocaleTimeString([], {
            minute: '2-digit',
            second: '2-digit',
          });
          setMetricPoints((prev) => [
            ...prev.slice(-299),
            { label: nowLabel, cpuPercent: m.cpuPercent, ramUsedMb: m.ramUsedMb },
          ]);
        })
        .catch(() => {});
    };

    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selectedServer?.id]);

  // Attach socket to live Minecraft console
  useEffect(() => {
    if (!socket || !selectedServer || activeTab !== 'console') return;
    const handleConsoleData = (chunk: string) => termWriteRef.current?.(chunk);
    socket.on('mc:console:data', handleConsoleData);
    termClearRef.current?.();
    socket.emit('mc:attach', { serverId: selectedServer.id });
    return () => {
      socket.off('mc:console:data', handleConsoleData);
      socket.emit('mc:detach');
    };
  }, [socket, selectedServer?.id, activeTab]);

  const loadFiles = useCallback(
    async (relDir = currentDir) => {
      if (!selectedServer) return;
      setFilesLoading(true);
      try {
        const res = await apiFetch<{ entries: FileEntry[]; currentPath: string }>(
          `/api/minecraft/servers/${selectedServer.id}/files?path=${encodeURIComponent(relDir)}`
        );
        setFiles(res.entries);
        setCurrentDir(res.currentPath);
      } catch (err) {
        onNotify(err instanceof Error ? err.message : 'Failed to list files', 'error');
      } finally {
        setFilesLoading(false);
      }
    },
    [selectedServer?.id, currentDir, onNotify]
  );

  const loadProperties = useCallback(async () => {
    if (!selectedServer) return;
    try {
      const res = await apiFetch<{ properties: Record<string, string> }>(
        `/api/minecraft/servers/${selectedServer.id}/properties`
      );
      setProps(res.properties);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load properties', 'error');
    }
  }, [selectedServer?.id, onNotify]);

  const loadPlayers = useCallback(async () => {
    if (!selectedServer) return;
    try {
      const res = await apiFetch<{
        online: Array<{ name: string; isOp: boolean }>;
        ops: string[];
        banned: string[];
      }>(`/api/minecraft/servers/${selectedServer.id}/players`);
      setPlayersData(res);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to fetch players', 'error');
    }
  }, [selectedServer?.id, onNotify]);

  const loadBackups = useCallback(async () => {
    if (!selectedServer) return;
    setBackupsLoading(true);
    try {
      const res = await apiFetch<{ backups: MinecraftBackupItem[] }>(
        `/api/minecraft/servers/${selectedServer.id}/backups`
      );
      setBackups(res.backups);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load backups', 'error');
    } finally {
      setBackupsLoading(false);
    }
  }, [selectedServer?.id, onNotify]);

  const loadSchedules = useCallback(async () => {
    if (!selectedServer) return;
    try {
      const res = await apiFetch<{ schedules: ScheduleItem[] }>(
        `/api/minecraft/servers/${selectedServer.id}/schedules`
      );
      setSchedules(res.schedules);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load schedules', 'error');
    }
  }, [selectedServer?.id, onNotify]);

  const loadSubusers = useCallback(async () => {
    if (!selectedServer) return;
    try {
      const res = await apiFetch<{ subusers: SubUserItem[] }>(
        `/api/minecraft/servers/${selectedServer.id}/subusers`
      );
      setSubusers(res.subusers);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load sub-users', 'error');
    }
  }, [selectedServer?.id, onNotify]);

  const loadServerAllocations = useCallback(async () => {
    if (!selectedServer) return;
    setAllocsLoading(true);
    try {
      const res = await apiFetch<{ allocations: AllocationItem[]; maxAllocations: number }>(
        `/api/minecraft/servers/${selectedServer.id}/allocations`
      );
      setServerAllocations(res.allocations);
      setMaxAllocations(res.maxAllocations || 3);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load server allocations', 'error');
    } finally {
      setAllocsLoading(false);
    }
  }, [selectedServer?.id, onNotify]);

  useEffect(() => {
    if (!selectedServer) return;
    if (activeTab === 'network') void loadServerAllocations();
    if (activeTab === 'files') void loadFiles(currentDir);
    if (activeTab === 'properties') void loadProperties();
    if (activeTab === 'players') void loadPlayers();
    if (activeTab === 'backups') void loadBackups();
    if (activeTab === 'schedules') void loadSchedules();
    if (activeTab === 'subusers') void loadSubusers();
    if (activeTab === 'modrinth' && modHits.length === 0) void runModrinthSearch('', modType);
  }, [activeTab, selectedServer?.id]);

  async function runModrinthSearch(q = modQuery, type = modType) {
    if (!selectedServer) return;
    setModSearching(true);
    try {
      const loaderParam =
        selectedServer.software === 'VANILLA' ? '' : selectedServer.software.toLowerCase();
      const url = `/api/modrinth/search?q=${encodeURIComponent(q)}&type=${type}&loader=${encodeURIComponent(
        loaderParam
      )}&version=${encodeURIComponent(selectedServer.version === 'LATEST' ? '' : selectedServer.version)}`;
      const res = await apiFetch<{ hits: ModrinthHit[] }>(url);
      setModHits(res.hits);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Modrinth search failed', 'error');
    } finally {
      setModSearching(false);
    }
  }

  async function handleDeploy(e: FormEvent) {
    e.preventDefault();
    setDeploying(true);
    try {
      const primaryNumeric =
        primaryAllocationChoice === 'auto' ? 'auto' : Number(primaryAllocationChoice);
      const filteredAdditional = additionalAllocationIds.filter(
        (id) => primaryNumeric === 'auto' || id !== primaryNumeric
      );

      const res = await apiFetch<{
        server: MinecraftServer;
        dockerProvisioned: boolean;
        note?: string;
      }>('/api/minecraft/servers', {
        method: 'POST',
        body: JSON.stringify({
          name,
          software,
          version,
          ramMb: Number(ramMb),
          cpuPercent: Number(cpuPercent),
          primaryAllocationId: primaryNumeric,
          additionalAllocationIds: filteredAdditional,
          nodeId: Number(nodeId || 1),
          eulaAccepted,
          ownerId: isStaff ? assignOwnerId : currentUser.id,
        }),
      });
      setShowDeploy(false);
      setName('');
      setAdditionalAllocationIds([]);
      await onRefresh();
      onSelect(res.server.id);
      onNotify(res.note || `Server '${res.server.name}' deployed.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to deploy server', 'error');
    } finally {
      setDeploying(false);
    }
  }

  async function handlePower(action: 'start' | 'stop' | 'restart' | 'kill' | 'delete') {
    if (!selectedServer) return;
    try {
      const res = await apiFetch<{ status: string; deleted?: boolean }>(
        `/api/minecraft/servers/${selectedServer.id}/power`,
        {
          method: 'POST',
          body: JSON.stringify({ action }),
        }
      );
      if (action === 'start' || action === 'restart') {
        setNetworkRestartRequired(false);
      }
      await onRefresh();
      if (res.deleted) {
        onSelect(null);
        onNotify(`Server '${selectedServer.name}' deleted.`);
      } else {
        onNotify(`Server action '${action}' executed.`);
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : `Failed to ${action} server`, 'error');
    }
  }

  function copyAddress(text: string, key: string | number) {
    void copyToClipboard(text).then((ok) => {
      if (ok) {
        setCopiedAddressId(key);
        onNotify(`Copied ${text}`);
        setTimeout(() => {
          setCopiedAddressId((curr) => (curr === key ? null : curr));
        }, 1800);
      } else {
        onNotify('Clipboard unavailable in this browser context.', 'error');
      }
    });
  }

  async function handleCreateServerAllocation(e: FormEvent) {
    e.preventDefault();
    if (!selectedServer) return;
    setClaimingAlloc(true);
    try {
      const res = await apiFetch<{
        allocation: AllocationItem;
        allocations: AllocationItem[];
        restartRequired: boolean;
      }>(`/api/minecraft/servers/${selectedServer.id}/allocations`, {
        method: 'POST',
        body: JSON.stringify({ notes: newAllocNotes.trim() || undefined }),
      });
      setServerAllocations(res.allocations);
      setNewAllocNotes('');
      if (res.restartRequired && selectedServer.status === 'running') {
        setNetworkRestartRequired(true);
      }
      await onRefresh();
      onNotify(`Assigned port ${res.allocation.ip}:${res.allocation.port} to ${selectedServer.name}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create allocation', 'error');
    } finally {
      setClaimingAlloc(false);
    }
  }

  async function handleSaveAllocationNote(allocId: number) {
    if (!selectedServer) return;
    try {
      const res = await apiFetch<{ allocations: AllocationItem[] }>(
        `/api/minecraft/servers/${selectedServer.id}/allocations/${allocId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ notes: editingNoteVal.trim() || null }),
        }
      );
      setServerAllocations(res.allocations);
      setEditingNoteId(null);
      onNotify('Allocation notes updated.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update notes', 'error');
    }
  }

  async function handleMakePrimaryAllocation(alloc: AllocationItem) {
    if (!selectedServer) return;
    try {
      const res = await apiFetch<{
        allocations: AllocationItem[];
        primaryPort: number;
        restartRequired: boolean;
      }>(`/api/minecraft/servers/${selectedServer.id}/allocations/${alloc.id}/primary`, {
        method: 'POST',
      });
      setServerAllocations(res.allocations);
      if (res.restartRequired) {
        setNetworkRestartRequired(true);
      }
      await onRefresh();
      onNotify(
        `Switched Primary Port to ${alloc.port} (synced server.properties). Restart container to apply.`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to set primary port', 'error');
    }
  }

  async function handleUnassignAllocation(alloc: AllocationItem) {
    if (!selectedServer) return;
    try {
      const res = await apiFetch<{ allocations: AllocationItem[]; restartRequired: boolean }>(
        `/api/minecraft/servers/${selectedServer.id}/allocations/${alloc.id}`,
        { method: 'DELETE' }
      );
      setServerAllocations(res.allocations);
      if (res.restartRequired && selectedServer.status === 'running') {
        setNetworkRestartRequired(true);
      }
      await onRefresh();
      onNotify(`Released port ${alloc.port} back to node pool.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to unassign allocation', 'error');
    }
  }

  function handleSendCommand(e: FormEvent) {
    e.preventDefault();
    if (!selectedServer || !commandInput.trim()) return;
    socket?.emit('mc:command', { serverId: selectedServer.id, command: commandInput });
    setCommandInput('');
  }

  async function handleSaveProperties(e: FormEvent) {
    e.preventDefault();
    if (!selectedServer) return;
    setSavingProps(true);
    try {
      const res = await apiFetch<{ properties: Record<string, string> }>(
        `/api/minecraft/servers/${selectedServer.id}/properties`,
        {
          method: 'PUT',
          body: JSON.stringify({ properties: props }),
        }
      );
      setProps(res.properties);
      onNotify('Saved server.properties! Restart server to apply changes.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save properties', 'error');
    } finally {
      setSavingProps(false);
    }
  }

  async function handlePlayerAction(
    playerName: string,
    action: 'kick' | 'ban' | 'pardon' | 'op' | 'deop'
  ) {
    if (!selectedServer || !playerName.trim()) return;
    try {
      await apiFetch(`/api/minecraft/servers/${selectedServer.id}/players/action`, {
        method: 'POST',
        body: JSON.stringify({ playerName: playerName.trim(), action }),
      });
      onNotify(`Executed ${action.toUpperCase()} on ${playerName}.`);
      setManualPlayer('');
      void loadPlayers();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Player command failed', 'error');
    }
  }

  async function handleCreateBackup(e: FormEvent) {
    e.preventDefault();
    if (!selectedServer) return;
    setCreatingBackup(true);
    try {
      await apiFetch(`/api/minecraft/servers/${selectedServer.id}/backups`, {
        method: 'POST',
        body: JSON.stringify({ name: backupLabel.trim() || undefined }),
      });
      setBackupLabel('');
      onNotify('Local .tar.gz backup saved to server vault.');
      void loadBackups();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Backup creation failed', 'error');
    } finally {
      setCreatingBackup(false);
    }
  }

  async function handleConfirmRestoreBackup() {
    if (!selectedServer || !restoreTarget) return;
    setRestoringBackup(true);
    try {
      await apiFetch(
        `/api/minecraft/servers/${selectedServer.id}/backups/${restoreTarget.id}/restore`,
        {
          method: 'POST',
          body: JSON.stringify({ createPreRestore: restoreSafetyBackup }),
        }
      );
      onNotify(`Restored '${selectedServer.name}' to backup '${restoreTarget.name}'.`);
      setRestoreTarget(null);
      await Promise.all([loadBackups(), onRefresh()]);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Backup restore failed', 'error');
    } finally {
      setRestoringBackup(false);
    }
  }

  async function handleUploadBackupToCloud(backupId: number) {
    if (!selectedServer) return;
    setUploadingBackupId(backupId);
    try {
      await apiFetch(`/api/minecraft/servers/${selectedServer.id}/backups/${backupId}/cloud`, {
        method: 'POST',
      });
      onNotify('Backup offloaded to configured cloud storage.');
      void loadBackups();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Cloud upload failed', 'error');
    } finally {
      setUploadingBackupId(null);
    }
  }

  async function handleDeleteBackup(backupId: number) {
    if (!selectedServer) return;
    try {
      await apiFetch(`/api/minecraft/servers/${selectedServer.id}/backups/${backupId}`, {
        method: 'DELETE',
      });
      onNotify('Backup deleted.');
      void loadBackups();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete backup', 'error');
    }
  }

  async function handleCreateSchedule(e: FormEvent) {
    e.preventDefault();
    if (!selectedServer) return;
    try {
      await apiFetch(`/api/minecraft/servers/${selectedServer.id}/schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: schedName,
          cronExpr: schedCron,
          action: schedAction,
          payload: schedPayload,
          retentionCount: Number(schedRetention),
        }),
      });
      setSchedName('');
      setSchedPayload('');
      onNotify('Scheduled cron task created.');
      void loadSchedules();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create schedule', 'error');
    }
  }

  async function handleToggleSchedule(s: ScheduleItem) {
    if (!selectedServer) return;
    try {
      await apiFetch(`/api/minecraft/servers/${selectedServer.id}/schedules/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      void loadSchedules();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Toggle failed', 'error');
    }
  }

  async function handleDeleteSchedule(scheduleId: number) {
    if (!selectedServer) return;
    try {
      await apiFetch(`/api/minecraft/servers/${selectedServer.id}/schedules/${scheduleId}`, {
        method: 'DELETE',
      });
      void loadSchedules();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  }

  async function handleInviteSubuser(e: FormEvent) {
    e.preventDefault();
    if (!selectedServer) return;
    try {
      await apiFetch(`/api/minecraft/servers/${selectedServer.id}/subusers`, {
        method: 'POST',
        body: JSON.stringify({
          identifier: subIdentifier,
          canStartStop: subStartStop,
          canUseConsole: subConsole,
          canEditFiles: subFiles,
          canManageBackups: subBackups,
        }),
      });
      setSubIdentifier('');
      onNotify('Sub-user permissions saved.');
      void loadSubusers();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to invite sub-user', 'error');
    }
  }

  async function handleRemoveSubuser(subId: number) {
    if (!selectedServer) return;
    try {
      await apiFetch(`/api/minecraft/servers/${selectedServer.id}/subusers/${subId}`, {
        method: 'DELETE',
      });
      void loadSubusers();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to remove sub-user', 'error');
    }
  }

  async function handleOpenFile(entry: FileEntry) {
    if (!selectedServer) return;
    if (entry.isDirectory) {
      await loadFiles(entry.path);
      return;
    }
    try {
      const res = await apiFetch<{ content: string; path: string }>(
        `/api/minecraft/servers/${selectedServer.id}/files/content?path=${encodeURIComponent(
          entry.path
        )}`
      );
      setEditingFile({ path: res.path, content: res.content });
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Cannot open file', 'error');
    }
  }

  async function handleSaveFile() {
    if (!selectedServer || !editingFile) return;
    setSavingFile(true);
    try {
      await apiFetch(`/api/minecraft/servers/${selectedServer.id}/files/content`, {
        method: 'PUT',
        body: JSON.stringify({ path: editingFile.path, content: editingFile.content }),
      });
      onNotify(`Saved ${editingFile.path}`);
      await loadFiles(currentDir);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save file', 'error');
    } finally {
      setSavingFile(false);
    }
  }

  async function handleCreateEntry(e: FormEvent) {
    e.preventDefault();
    if (!selectedServer || !newEntryType || !newEntryName.trim()) return;
    const rel = currentDir ? `${currentDir}/${newEntryName.trim()}` : newEntryName.trim();
    try {
      await apiFetch(`/api/minecraft/servers/${selectedServer.id}/files/entry`, {
        method: 'POST',
        body: JSON.stringify({ path: rel, type: newEntryType }),
      });
      setNewEntryType(null);
      setNewEntryName('');
      await loadFiles(currentDir);
      onNotify(`Created ${rel}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create entry', 'error');
    }
  }

  async function handleDeleteEntry(entry: FileEntry) {
    if (!selectedServer) return;
    try {
      await apiFetch(
        `/api/minecraft/servers/${selectedServer.id}/files/entry?path=${encodeURIComponent(
          entry.path
        )}`,
        { method: 'DELETE' }
      );
      if (editingFile?.path === entry.path) setEditingFile(null);
      await loadFiles(currentDir);
      onNotify(`Deleted ${entry.name}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete entry', 'error');
    }
  }

  async function handleUploadFiles(e: ChangeEvent<HTMLInputElement>) {
    if (!selectedServer || !e.target.files || e.target.files.length === 0) return;
    const form = new FormData();
    form.append('dir', currentDir);
    for (const file of Array.from(e.target.files)) {
      form.append('files', file);
    }
    try {
      const res = await apiFetch<{ uploaded: string[] }>(
        `/api/minecraft/servers/${selectedServer.id}/files/upload`,
        { method: 'POST', body: form }
      );
      onNotify(`Uploaded ${res.uploaded.length} file(s).`);
      await loadFiles(currentDir);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Upload failed', 'error');
    } finally {
      e.target.value = '';
    }
  }

  async function handleInstallModrinth(hit: ModrinthHit) {
    if (!selectedServer) return;
    setInstallingId(hit.project_id);
    try {
      const res = await apiFetch<{ filename: string; installedPath: string; versionNumber: string }>(
        `/api/minecraft/servers/${selectedServer.id}/modrinth/install`,
        {
          method: 'POST',
          body: JSON.stringify({ projectId: hit.project_id, projectType: modType }),
        }
      );
      onNotify(`Installed ${res.filename} (${res.versionNumber}) to ${res.installedPath}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Modrinth install failed', 'error');
    } finally {
      setInstallingId(null);
    }
  }

  async function handleAdminUpdate(updates: { isSuspended?: boolean; applyLimits?: boolean }) {
    if (!selectedServer) return;
    try {
      await apiFetch(`/api/minecraft/servers/${selectedServer.id}/admin`, {
        method: 'PUT',
        body: JSON.stringify({
          ...(updates.applyLimits
            ? {
                ownerId: adminOwnerId,
                ramMb: adminRam,
                cpuPercent: adminCpu,
                maxAllocations: adminMaxAllocations,
              }
            : {}),
          ...(updates.isSuspended !== undefined ? { isSuspended: updates.isSuspended } : {}),
        }),
      });
      await onRefresh();
      if (activeTab === 'network') void loadServerAllocations();
      onNotify('Server administrative configuration updated.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update server', 'error');
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Server List Column */}
      <div className="cyber-glass rounded-xl p-4 lg:col-span-3">
        <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
          <h2 className="text-sm font-semibold text-white">Minecraft Nodes</h2>
          <button
            type="button"
            onClick={() => setShowDeploy(true)}
            className="cyber-glow-btn inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            Deploy
          </button>
        </div>

        {servers.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-xs text-slate-400">No servers available.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {servers.map((srv) => {
              const active = selectedServer?.id === srv.id;
              return (
                <button
                  key={srv.id}
                  type="button"
                  onClick={() => onSelect(srv.id)}
                  className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    active
                      ? 'border-violet-500/50 bg-violet-600/20 text-white'
                      : 'border-transparent text-slate-300 hover:border-violet-500/20 hover:bg-violet-500/10'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{srv.name}</span>
                    <span
                      className={`text-xs font-semibold shrink-0 ${
                        srv.is_suspended
                          ? 'text-red-400'
                          : srv.status === 'running'
                          ? 'text-emerald-400'
                          : 'text-slate-400'
                      }`}
                    >
                      {srv.is_suspended
                        ? 'Suspended'
                        : srv.status === 'running'
                        ? 'Online'
                        : 'Offline'}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span>{srv.software}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">{srv.version}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {srv.primary_ip_alias
                        ? `${srv.primary_ip_alias}:${srv.port}`
                        : `:${srv.port}`}
                    </span>
                    {srv.node_name && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="truncate text-violet-300">{srv.node_name}</span>
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Active Server Workspace */}
      <div className="lg:col-span-9">
        {!selectedServer ? (
          <div className="cyber-glass flex min-h-[420px] flex-col items-center justify-center rounded-xl p-8 text-center">
            <h3 className="text-lg font-semibold text-white">Deploy Your First Minecraft Server</h3>
            <p className="mt-2 max-w-md text-sm text-slate-400">
              Launch Paper, Purpur, Spigot, Vanilla, Forge, Fabric, or Velocity inside an isolated
              itzg/minecraft-server Docker container.
            </p>
            <button
              type="button"
              onClick={() => setShowDeploy(true)}
              className="cyber-glow-btn mt-5 inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white"
            >
              <Plus className="h-4 w-4" />
              Deploy Minecraft Server
            </button>
          </div>
        ) : (
          <div className="cyber-glass rounded-xl p-6">
            {/* Workspace Header + Power Controls */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-violet-500/15 pb-4">
              <div>
                <h2 className="text-xl font-bold text-white">{selectedServer.name}</h2>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span>{selectedServer.software}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{selectedServer.version}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{selectedServer.ram_mb} MB RAM</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{selectedServer.cpu_percent}% CPU</span>
                  <span aria-hidden="true">·</span>
                  {(() => {
                    const hostDisplay =
                      selectedServer.primary_ip_alias || selectedServer.primary_ip || '0.0.0.0';
                    const fullAddr = `${hostDisplay}:${selectedServer.port}`;
                    return (
                      <button
                        type="button"
                        onClick={() => copyAddress(fullAddr, 'header')}
                        className="inline-flex items-center gap-1 rounded border border-violet-500/25 bg-[#090714]/80 px-2 py-0.5 font-mono text-violet-200 hover:border-violet-400/50 tabular-nums"
                        title="Click to copy server address"
                      >
                        <span>{fullAddr}</span>
                        {copiedAddressId === 'header' ? (
                          <Check className="h-3 w-3 text-emerald-400" />
                        ) : (
                          <Copy className="h-3 w-3 text-slate-400" />
                        )}
                      </button>
                    );
                  })()}
                  {selectedServer.node_name && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-violet-300">{selectedServer.node_name}</span>
                    </>
                  )}
                  {selectedServer.owner_username && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>Owner: {selectedServer.owner_username}</span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handlePower('start')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/35 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 whitespace-nowrap shrink-0"
                >
                  <Play className="h-3.5 w-3.5" />
                  Start
                </button>
                <button
                  type="button"
                  onClick={() => void handlePower('restart')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/35 bg-violet-500/15 px-3 py-1.5 text-xs font-semibold text-violet-200 hover:bg-violet-500/25 whitespace-nowrap shrink-0"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  Restart
                </button>
                <button
                  type="button"
                  onClick={() => void handlePower('stop')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/35 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 whitespace-nowrap shrink-0"
                >
                  <Square className="h-3.5 w-3.5" />
                  Stop
                </button>
                <button
                  type="button"
                  onClick={() => void handlePower('kill')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/35 bg-red-500/15 px-3 py-1.5 text-xs font-semibold text-red-200 hover:bg-red-500/25 whitespace-nowrap shrink-0"
                >
                  <Skull className="h-3.5 w-3.5" />
                  Kill
                </button>
                <button
                  type="button"
                  onClick={() => setShowAiDrawer(true)}
                  className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                >
                  <Bot className="h-3.5 w-3.5" />
                  MC AI Assistant
                </button>
              </div>
            </div>

            {/* Segmented Sub-Navigation */}
            <div className="my-4 flex flex-wrap items-center gap-1 rounded-lg bg-[#090714]/80 p-1">
              {(
                [
                  ['console', 'Console & Graph'],
                  ['network', 'Network'],
                  ['properties', 'Properties UI'],
                  ['players', 'Players'],
                  ['backups', 'Backups'],
                  ['schedules', 'Cron Schedules'],
                  ['subusers', 'Sub-Users'],
                  ['files', 'Files'],
                  ['modrinth', 'Modrinth'],
                  ['settings', 'Config'],
                ] as const
              ).map(([tabKey, label]) => (
                <button
                  key={tabKey}
                  type="button"
                  onClick={() => setActiveTab(tabKey)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    activeTab === tabKey
                      ? 'bg-violet-600 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* TAB 1: CONSOLE & LIVE RESOURCE GRAPH */}
            {activeTab === 'console' && (
              <div className="space-y-4">
                <TerminalView
                  interactive={false}
                  onReady={(write, clear) => {
                    termWriteRef.current = write;
                    termClearRef.current = clear;
                  }}
                />
                <form onSubmit={handleSendCommand} className="flex gap-2">
                  <input
                    type="text"
                    value={commandInput}
                    onChange={(e) => setCommandInput(e.target.value)}
                    placeholder="Type Minecraft server command (e.g. say Hello, op Player, list)..."
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 font-mono text-sm text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="cyber-glow-btn rounded-lg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                  >
                    Send Command
                  </button>
                </form>

                <ResourceChart
                  title="Container CPU & Memory Usage (10m)"
                  points={metricPoints}
                  ramLimitMb={selectedServer.ram_mb}
                  live={metricLive}
                />
              </div>
            )}

            {/* TAB 1B: NETWORK & PORT ALLOCATIONS */}
            {activeTab === 'network' && (
              <div className="space-y-5">
                {networkRestartRequired && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-100">
                    <div className="flex items-center gap-2.5">
                      <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                      <span>
                        Port allocations changed. Restart the server to recreate Docker container
                        port bindings (<span className="font-mono">-p</span> TCP/UDP) and apply the
                        updated <span className="font-mono">server-port</span>.
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handlePower('restart')}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 whitespace-nowrap shrink-0"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                      Restart &amp; Apply Ports
                    </button>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-500/20 bg-[#090714]/65 p-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <Network className="h-4 w-4 text-violet-400" />
                      <h3 className="text-sm font-semibold text-white">
                        Server IP &amp; Port Allocations
                      </h3>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">
                      Using{' '}
                      <strong className="font-mono text-white tabular-nums">
                        {serverAllocations.length} / {maxAllocations}
                      </strong>{' '}
                      allocations on{' '}
                      <span className="text-violet-300">
                        {selectedServer.node_name || 'Primary Node #1'}
                      </span>
                    </p>
                  </div>

                  <form onSubmit={handleCreateServerAllocation} className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={newAllocNotes}
                      onChange={(e) => setNewAllocNotes(e.target.value)}
                      placeholder="Label (e.g. Geyser UDP, Voice Chat)"
                      className="w-52 rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={
                        claimingAlloc ||
                        (!isStaff && serverAllocations.length >= maxAllocations)
                      }
                      className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {claimingAlloc ? 'Allocating...' : 'Create Allocation'}
                    </button>
                  </form>
                </div>

                {allocsLoading ? (
                  <div className="space-y-3">
                    {Array.from({ length: 2 }).map((_, i) => (
                      <div key={i} className="h-20 animate-pulse rounded-xl bg-violet-950/35" />
                    ))}
                  </div>
                ) : serverAllocations.length === 0 ? (
                  <div className="rounded-xl border border-violet-500/20 bg-[#090714]/50 p-8 text-center text-xs text-slate-400">
                    No port allocations found for this server yet. Click &ldquo;Create
                    Allocation&rdquo; above to assign one.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {serverAllocations.map((alloc) => {
                      const isPrimary = alloc.is_primary === 1;
                      const displayHost = alloc.ip_alias || alloc.ip;
                      const fullAddress = `${displayHost}:${alloc.port}`;
                      const rawAddress = `${alloc.ip}:${alloc.port}`;
                      const isEditingNote = editingNoteId === alloc.id;

                      return (
                        <div
                          key={alloc.id}
                          className={`rounded-xl border p-4 transition-colors ${
                            isPrimary
                              ? 'border-amber-400/45 bg-amber-500/[0.06]'
                              : 'border-violet-500/20 bg-[#090714]/65'
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-4">
                            <div className="flex flex-wrap items-center gap-4 min-w-0">
                              <div className="flex items-center gap-2">
                                {isPrimary && (
                                  <span className="inline-flex items-center gap-1 rounded border border-amber-400/40 bg-amber-500/20 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-200">
                                    <Star className="h-3 w-3 fill-amber-300 text-amber-300" />
                                    Primary
                                  </span>
                                )}
                                <span className="font-mono text-base font-bold text-white tabular-nums">
                                  {fullAddress}
                                </span>
                                <span className="font-mono text-[11px] text-slate-400">
                                  {alloc.protocol}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => copyAddress(fullAddress, alloc.id)}
                                  className="inline-flex items-center gap-1 rounded border border-violet-500/30 bg-[#0d0a1a] px-2 py-1 text-[11px] text-slate-200 hover:border-violet-400"
                                  title="Copy connection address"
                                >
                                  {copiedAddressId === alloc.id ? (
                                    <Check className="h-3 w-3 text-emerald-400" />
                                  ) : (
                                    <Copy className="h-3 w-3 text-slate-400" />
                                  )}
                                  Copy
                                </button>
                              </div>

                              {alloc.ip_alias && (
                                <span className="font-mono text-xs text-slate-400">
                                  Bound IP: {rawAddress}
                                </span>
                              )}

                              {isPrimary && (
                                <span className="font-mono text-xs text-emerald-300">
                                  server-port={alloc.port} synced
                                </span>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              {!isPrimary && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => void handleMakePrimaryAllocation(alloc)}
                                    className="inline-flex items-center gap-1 rounded-lg border border-amber-500/35 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 whitespace-nowrap shrink-0"
                                  >
                                    <Star className="h-3 w-3" />
                                    Make Primary
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleUnassignAllocation(alloc)}
                                    className="inline-flex items-center gap-1 rounded-lg border border-red-500/35 bg-red-500/15 px-3 py-1.5 text-xs font-semibold text-red-200 hover:bg-red-500/25 whitespace-nowrap shrink-0"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                    Unassign
                                  </button>
                                </>
                              )}
                            </div>
                          </div>

                          {/* Allocation Notes Row */}
                          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-violet-500/10 pt-2.5 text-xs">
                            <span className="text-slate-500">Notes:</span>
                            {isEditingNote ? (
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="text"
                                  value={editingNoteVal}
                                  onChange={(e) => setEditingNoteVal(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      void handleSaveAllocationNote(alloc.id);
                                    } else if (e.key === 'Escape') {
                                      setEditingNoteId(null);
                                    }
                                  }}
                                  placeholder="e.g. Geyser UDP, Simple Voice Chat, Dynmap"
                                  className="w-64 rounded border border-violet-500/40 bg-[#0d0a1a] px-2.5 py-1 text-xs text-white focus:outline-none"
                                  autoFocus
                                />
                                <button
                                  type="button"
                                  onClick={() => void handleSaveAllocationNote(alloc.id)}
                                  className="rounded bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingNoteId(null)}
                                  className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-400"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingNoteId(alloc.id);
                                  setEditingNoteVal(alloc.notes || '');
                                }}
                                className="inline-flex items-center gap-1.5 text-slate-300 hover:text-violet-300"
                              >
                                <span>{alloc.notes || 'Add port note (e.g. Geyser Bedrock Port)'}</span>
                                <Pencil className="h-3 w-3 text-violet-400" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: VISUAL SERVER.PROPERTIES EDITOR */}
            {activeTab === 'properties' && (
              <form onSubmit={handleSaveProperties} className="space-y-5">
                <div className="rounded-lg border border-violet-500/20 bg-[#090714]/70 p-4">
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    Server MOTD (supports § color codes like §dWelcome §fSMP)
                  </label>
                  <input
                    type="text"
                    value={props['motd'] || ''}
                    onChange={(e) => setProps({ ...props, motd: e.target.value })}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3.5 py-2 font-mono text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                  <div className="mt-2 rounded border border-violet-500/15 bg-black/50 px-3 py-2 font-mono text-sm">
                    {renderMotdPreview(props['motd'] || 'A Minecraft Server')}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <label className="mb-1 block text-xs text-slate-300">Gamemode</label>
                    <select
                      value={props['gamemode'] || 'survival'}
                      onChange={(e) => setProps({ ...props, gamemode: e.target.value })}
                      className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 text-sm text-white"
                    >
                      <option value="survival">Survival</option>
                      <option value="creative">Creative</option>
                      <option value="adventure">Adventure</option>
                      <option value="spectator">Spectator</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-300">Difficulty</label>
                    <select
                      value={props['difficulty'] || 'normal'}
                      onChange={(e) => setProps({ ...props, difficulty: e.target.value })}
                      className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 text-sm text-white"
                    >
                      <option value="peaceful">Peaceful</option>
                      <option value="easy">Easy</option>
                      <option value="normal">Normal</option>
                      <option value="hard">Hard</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-300">Max Players</label>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={props['max-players'] || '20'}
                      onChange={(e) => setProps({ ...props, 'max-players': e.target.value })}
                      className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 font-mono text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-300">View Distance</label>
                    <input
                      type="number"
                      min={3}
                      max={32}
                      value={props['view-distance'] || '10'}
                      onChange={(e) => setProps({ ...props, 'view-distance': e.target.value })}
                      className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 font-mono text-sm text-white"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {(
                    [
                      ['online-mode', 'Online Mode (Disable for Cracked)'],
                      ['pvp', 'Enable PvP Combat'],
                      ['white-list', 'Enable Whitelist'],
                      ['enable-command-block', 'Enable Command Blocks'],
                      ['allow-flight', 'Allow Flight'],
                    ] as const
                  ).map(([key, label]) => (
                    <label
                      key={key}
                      className="flex items-center justify-between rounded-lg border border-violet-500/20 bg-[#090714]/60 px-3.5 py-2.5 text-xs text-slate-200"
                    >
                      <span>{label}</span>
                      <input
                        type="checkbox"
                        checked={(props[key] || 'false') === 'true'}
                        onChange={(e) =>
                          setProps({ ...props, [key]: e.target.checked ? 'true' : 'false' })
                        }
                        className="h-4 w-4 accent-violet-600"
                      />
                    </label>
                  ))}
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={savingProps}
                    className="cyber-glow-btn inline-flex items-center gap-2 rounded-lg px-5 py-2 text-xs font-semibold text-white"
                  >
                    <Save className="h-3.5 w-3.5" />
                    {savingProps ? 'Saving...' : 'Save server.properties'}
                  </button>
                </div>
              </form>
            )}

            {/* TAB 3: PLAYER MANAGER */}
            {activeTab === 'players' && (
              <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4">
                  <input
                    type="text"
                    value={manualPlayer}
                    onChange={(e) => setManualPlayer(e.target.value)}
                    placeholder="Player username (3-16 chars)"
                    className="flex-1 min-w-[200px] rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3.5 py-2 font-mono text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                  {(
                    [
                      ['op', 'OP'],
                      ['deop', 'De-OP'],
                      ['kick', 'Kick'],
                      ['ban', 'Ban'],
                      ['pardon', 'Unban'],
                    ] as const
                  ).map(([act, label]) => (
                    <button
                      key={act}
                      type="button"
                      onClick={() => void handlePlayerAction(manualPlayer, act)}
                      className="rounded-lg border border-violet-500/35 bg-violet-600/15 px-3 py-2 text-xs font-semibold text-violet-200 hover:bg-violet-600/30 whitespace-nowrap"
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div>
                  <h4 className="mb-2 text-sm font-semibold text-white">Online Players</h4>
                  {playersData.online.length === 0 ? (
                    <p className="rounded-lg border border-violet-500/15 bg-[#090714]/40 p-4 text-xs text-slate-400">
                      No online players detected (requires live running server with RCON/logs).
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                            <th className="pb-2 font-medium">Player</th>
                            <th className="pb-2 font-medium">Status</th>
                            <th className="pb-2 font-medium text-right">Quick Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-violet-500/10">
                          {playersData.online.map((p) => (
                            <tr key={p.name}>
                              <td className="py-2.5 font-mono text-xs text-white">{p.name}</td>
                              <td className="py-2.5 text-xs text-violet-300">
                                {p.isOp ? 'Operator' : 'Player'}
                              </td>
                              <td className="py-2.5 text-right">
                                <div className="inline-flex gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handlePlayerAction(p.name, p.isOp ? 'deop' : 'op')
                                    }
                                    className="rounded border border-violet-500/35 px-2.5 py-1 text-xs text-violet-200"
                                  >
                                    {p.isOp ? 'De-OP' : 'OP'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handlePlayerAction(p.name, 'kick')}
                                    className="rounded border border-amber-500/35 px-2.5 py-1 text-xs text-amber-200"
                                  >
                                    Kick
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handlePlayerAction(p.name, 'ban')}
                                    className="rounded border border-red-500/35 px-2.5 py-1 text-xs text-red-200"
                                  >
                                    Ban
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

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4">
                    <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold text-white">
                      <Shield className="h-3.5 w-3.5 text-violet-400" />
                      Operators (ops.json)
                    </h4>
                    <p className="font-mono text-xs text-slate-400">
                      {playersData.ops.length > 0 ? playersData.ops.join(', ') : 'None configured'}
                    </p>
                  </div>
                  <div className="rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4">
                    <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold text-white">
                      <UserCheck className="h-3.5 w-3.5 text-red-400" />
                      Banned Players (banned-players.json)
                    </h4>
                    <p className="font-mono text-xs text-slate-400">
                      {playersData.banned.length > 0 ? playersData.banned.join(', ') : 'None'}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3.5: POINT-IN-TIME LOCAL BACKUPS */}
            {activeTab === 'backups' && (
              <div className="space-y-5">
                <form
                  onSubmit={handleCreateBackup}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4"
                >
                  <input
                    type="text"
                    value={backupLabel}
                    onChange={(e) => setBackupLabel(e.target.value)}
                    placeholder="Backup label (optional, e.g. pre-plugin-update)"
                    className="flex-1 min-w-[220px] rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={creatingBackup}
                    className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    {creatingBackup ? 'Archiving...' : 'Create .tar.gz Backup'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSchedAction('backup');
                      setSchedCron('0 3 * * *');
                      setActiveTab('schedules');
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 px-3.5 py-2 text-xs font-medium text-violet-200 hover:bg-violet-600/20 whitespace-nowrap shrink-0"
                  >
                    <Clock className="h-3.5 w-3.5" />
                    Schedule Automated Backups
                  </button>
                </form>

                {backupsLoading ? (
                  <div className="space-y-2 py-4">
                    {Array.from({ length: 3 }).map((_, idx) => (
                      <div key={idx} className="h-10 animate-pulse rounded bg-violet-950/35" />
                    ))}
                  </div>
                ) : backups.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-400">
                    No restore points saved yet for {selectedServer.name}.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                          <th className="pb-2.5 font-medium">Restore Point</th>
                          <th className="pb-2.5 font-medium">Storage</th>
                          <th className="pb-2.5 font-medium">Trigger</th>
                          <th className="pb-2.5 font-medium">Created By</th>
                          <th className="pb-2.5 font-medium text-right">Size</th>
                          <th className="pb-2.5 font-medium">Timestamp</th>
                          <th className="pb-2.5 font-medium text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-violet-500/10">
                        {backups.map((b) => {
                          const hasCloud = Boolean(b.cloud_provider && b.cloud_provider !== 'local');
                          const onDisk = b.exists_on_disk !== false;
                          const canAccess = onDisk || hasCloud;

                          return (
                            <tr key={b.id}>
                              <td className="py-2.5 pr-3 font-mono text-xs text-white">{b.name}</td>
                              <td className="py-2.5 pr-3 font-mono text-xs uppercase">
                                {hasCloud ? (
                                  <span className="text-cyan-300">
                                    {onDisk ? `Local + ${b.cloud_provider}` : `Cloud (${b.cloud_provider})`}
                                  </span>
                                ) : (
                                  <span className="text-slate-400">Local</span>
                                )}
                              </td>
                              <td className="py-2.5 pr-3 text-xs capitalize text-slate-300">
                                {b.backup_type.replace('_', ' ')}
                              </td>
                              <td className="py-2.5 pr-3 text-xs text-slate-400">{b.created_by}</td>
                              <td className="py-2.5 pr-3 text-right font-mono text-xs text-slate-300 tabular-nums">
                                {formatBytes(b.size_bytes)}
                              </td>
                              <td className="py-2.5 pr-3 font-mono text-xs text-slate-400 tabular-nums">
                                {new Date(b.created_at).toLocaleString()}
                              </td>
                              <td className="py-2.5 text-right">
                                <div className="inline-flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    disabled={!canAccess}
                                    onClick={() => {
                                      setRestoreSafetyBackup(true);
                                      setRestoreTarget(b);
                                    }}
                                    className="inline-flex items-center gap-1 rounded border border-violet-500/35 bg-violet-600/15 px-2.5 py-1 text-xs font-medium text-violet-200 hover:bg-violet-600/30 disabled:opacity-40 whitespace-nowrap shrink-0"
                                  >
                                    <RotateCcw className="h-3 w-3" />
                                    Restore
                                  </button>
                                  {onDisk && !hasCloud && (
                                    <button
                                      type="button"
                                      disabled={uploadingBackupId === b.id}
                                      onClick={() => void handleUploadBackupToCloud(b.id)}
                                      title="Offload to Cloud Storage"
                                      className="rounded border border-cyan-500/30 p-1 text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40"
                                    >
                                      <CloudUpload className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {canAccess && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void apiDownloadFile(
                                          `/api/minecraft/servers/${selectedServer.id}/backups/${b.id}/download`,
                                          b.filename
                                        )
                                      }
                                      title="Download archive"
                                      className="rounded border border-violet-500/25 p-1 text-slate-300 hover:bg-violet-600/20 hover:text-white"
                                    >
                                      <Download className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => void handleDeleteBackup(b.id)}
                                    title="Delete backup"
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
              </div>
            )}

            {/* TAB 4: CRON SCHEDULED TASKS */}
            {activeTab === 'schedules' && (
              <div className="space-y-5">
                <form
                  onSubmit={handleCreateSchedule}
                  className="grid grid-cols-1 gap-3 rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4 sm:grid-cols-12"
                >
                  <div className="sm:col-span-3">
                    <label className="mb-1 block text-xs text-slate-400">Task Name</label>
                    <input
                      type="text"
                      required
                      value={schedName}
                      onChange={(e) => setSchedName(e.target.value)}
                      placeholder="Auto-Restart 6h"
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 text-xs text-white"
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="mb-1 block text-xs text-slate-400">Cron Expression</label>
                    <input
                      type="text"
                      required
                      value={schedCron}
                      onChange={(e) => setSchedCron(e.target.value)}
                      placeholder="0 */6 * * *"
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 font-mono text-xs text-white"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-xs text-slate-400">Action</label>
                    <select
                      value={schedAction}
                      onChange={(e) =>
                        setSchedAction(e.target.value as 'restart' | 'backup' | 'command')
                      }
                      className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="restart">Restart</option>
                      <option value="backup">.tar.gz Backup</option>
                      <option value="command">Console Cmd</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    {schedAction === 'backup' ? (
                      <>
                        <label className="mb-1 block text-xs text-slate-400">Keep Last Backups</label>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={schedRetention}
                          onChange={(e) => setSchedRetention(Number(e.target.value))}
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 font-mono text-xs text-white"
                        />
                      </>
                    ) : (
                      <>
                        <label className="mb-1 block text-xs text-slate-400">Command Payload</label>
                        <input
                          type="text"
                          disabled={schedAction !== 'command'}
                          value={schedPayload}
                          onChange={(e) => setSchedPayload(e.target.value)}
                          placeholder="say Restarting..."
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 font-mono text-xs text-white disabled:opacity-40"
                        />
                      </>
                    )}
                  </div>
                  <div className="flex items-end sm:col-span-2">
                    <button
                      type="submit"
                      className="cyber-glow-btn inline-flex w-full items-center justify-center gap-1 rounded-lg px-3 py-2 text-xs font-semibold text-white"
                    >
                      <Clock className="h-3.5 w-3.5" />
                      Add Task
                    </button>
                  </div>
                </form>

                {schedules.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-400">
                    No cron schedules configured yet.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                          <th className="pb-2 font-medium">Name</th>
                          <th className="pb-2 font-medium">Cron</th>
                          <th className="pb-2 font-medium">Action</th>
                          <th className="pb-2 font-medium">Last Run</th>
                          <th className="pb-2 font-medium text-right">Controls</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-violet-500/10">
                        {schedules.map((s) => (
                          <tr key={s.id}>
                            <td className="py-2.5 text-xs font-medium text-white">{s.name}</td>
                            <td className="py-2.5 font-mono text-xs text-violet-300">
                              {s.cron_expr}
                            </td>
                            <td className="py-2.5 text-xs text-slate-300">
                              {s.action}
                              {s.action === 'backup'
                                ? ` (keep ${s.retention_count || 7})`
                                : s.payload
                                ? ` (${s.payload})`
                                : ''}
                            </td>
                            <td className="py-2.5 font-mono text-xs text-slate-400">
                              {s.last_run_at || 'Never'}
                            </td>
                            <td className="py-2.5 text-right">
                              <div className="inline-flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => void handleToggleSchedule(s)}
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
                                  onClick={() => void handleDeleteSchedule(s.id)}
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

            {/* TAB 5: SUB-USERS / STAFF PERMISSIONS */}
            {activeTab === 'subusers' && (
              <div className="space-y-5">
                <form
                  onSubmit={handleInviteSubuser}
                  className="space-y-3 rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <input
                      type="text"
                      required
                      value={subIdentifier}
                      onChange={(e) => setSubIdentifier(e.target.value)}
                      placeholder="Registered username or email..."
                      className="flex-1 min-w-[220px] rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3.5 py-2 text-sm text-white"
                    />
                    <button
                      type="submit"
                      className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      Grant Access
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-4 text-xs text-slate-300">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={subStartStop}
                        onChange={(e) => setSubStartStop(e.target.checked)}
                        className="accent-violet-600"
                      />
                      Start / Stop / Restart
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={subConsole}
                        onChange={(e) => setSubConsole(e.target.checked)}
                        className="accent-violet-600"
                      />
                      Console & Players
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={subFiles}
                        onChange={(e) => setSubFiles(e.target.checked)}
                        className="accent-violet-600"
                      />
                      Edit Files & Modrinth
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={subBackups}
                        onChange={(e) => setSubBackups(e.target.checked)}
                        className="accent-violet-600"
                      />
                      Manage Backups
                    </label>
                  </div>
                </form>

                {subusers.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-400">
                    No sub-users invited to this server yet.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                          <th className="pb-2 font-medium">Staff User</th>
                          <th className="pb-2 font-medium">Permissions</th>
                          <th className="pb-2 font-medium text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-violet-500/10">
                        {subusers.map((su) => (
                          <tr key={su.id}>
                            <td className="py-2.5">
                              <p className="text-xs font-semibold text-white">{su.username}</p>
                              <p className="text-xs text-slate-400">{su.email}</p>
                            </td>
                            <td className="py-2.5 text-xs text-slate-300">
                              {[
                                su.can_start_stop ? 'Power' : null,
                                su.can_use_console ? 'Console' : null,
                                su.can_edit_files ? 'Files' : null,
                                su.can_manage_backups ? 'Backups' : null,
                              ]
                                .filter(Boolean)
                                .join(' · ') || 'View only'}
                            </td>
                            <td className="py-2.5 text-right">
                              <button
                                type="button"
                                onClick={() => void handleRemoveSubuser(su.id)}
                                className="rounded p-1 text-slate-400 hover:text-red-300"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* TAB 6: FILE MANAGER & CODEMIRROR EDITOR */}
            {activeTab === 'files' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5 text-xs text-slate-300">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingFile(null);
                        void loadFiles('');
                      }}
                      className="font-mono text-violet-300 hover:underline"
                    >
                      /data
                    </button>
                    {currentDir
                      .split('/')
                      .filter(Boolean)
                      .map((part, idx, arr) => {
                        const sub = arr.slice(0, idx + 1).join('/');
                        return (
                          <span key={sub} className="flex items-center gap-1.5">
                            <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
                            <button
                              type="button"
                              onClick={() => {
                                setEditingFile(null);
                                void loadFiles(sub);
                              }}
                              className="font-mono text-violet-300 hover:underline"
                            >
                              {part}
                            </button>
                          </span>
                        );
                      })}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={uploadInputRef}
                      type="file"
                      multiple
                      onChange={handleUploadFiles}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => uploadInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-violet-600/20 whitespace-nowrap shrink-0"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Upload
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewEntryType('file')}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-violet-600/20 whitespace-nowrap shrink-0"
                    >
                      <FilePlus className="h-3.5 w-3.5" />
                      New File
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewEntryType('folder')}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-violet-600/20 whitespace-nowrap shrink-0"
                    >
                      <FolderPlus className="h-3.5 w-3.5" />
                      New Folder
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void apiDownloadFile(
                          `/api/minecraft/servers/${selectedServer.id}/backup`,
                          `${selectedServer.container_name}-backup.zip`
                        )
                      }
                      className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                    >
                      <Archive className="h-3.5 w-3.5" />
                      Zip Backup
                    </button>
                  </div>
                </div>

                {newEntryType && (
                  <form
                    onSubmit={handleCreateEntry}
                    className="flex items-center gap-2 rounded-lg border border-violet-500/25 bg-[#090714]/80 p-3"
                  >
                    <input
                      type="text"
                      required
                      value={newEntryName}
                      onChange={(e) => setNewEntryName(e.target.value)}
                      placeholder={
                        newEntryType === 'folder'
                          ? 'Folder name (e.g. worlds)'
                          : 'File name (e.g. whitelist.json)'
                      }
                      className="w-full rounded border border-violet-500/25 bg-[#0d0a1a] px-3 py-1.5 text-xs text-white focus:border-violet-400 focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="cyber-glow-btn rounded px-3 py-1.5 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                    >
                      Create
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewEntryType(null)}
                      className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300"
                    >
                      Cancel
                    </button>
                  </form>
                )}

                {editingFile ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-violet-300">{editingFile.path}</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleSaveFile()}
                          disabled={savingFile}
                          className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold text-white"
                        >
                          <Save className="h-3.5 w-3.5" />
                          {savingFile ? 'Saving...' : 'Save File'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingFile(null)}
                          className="rounded-lg border border-violet-500/30 px-3 py-1.5 text-xs text-slate-300 hover:bg-violet-600/20"
                        >
                          Close Editor
                        </button>
                      </div>
                    </div>
                    <CodeEditorView
                      filename={editingFile.path}
                      initialValue={editingFile.content}
                      onChange={(val) =>
                        setEditingFile((prev) => (prev ? { ...prev, content: val } : null))
                      }
                      onSave={() => void handleSaveFile()}
                    />
                  </div>
                ) : filesLoading ? (
                  <div className="space-y-2 py-4">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div key={i} className="h-9 animate-pulse rounded bg-violet-950/35" />
                    ))}
                  </div>
                ) : files.length === 0 ? (
                  <div className="py-10 text-center text-sm text-slate-400">Directory is empty.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                          <th className="pb-2.5 font-medium">Name</th>
                          <th className="pb-2.5 font-medium text-right">Size</th>
                          <th className="pb-2.5 font-medium text-right">Modified</th>
                          <th className="pb-2.5 font-medium text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-violet-500/10">
                        {files.map((entry) => (
                          <tr key={entry.path} className="hover:bg-violet-500/10">
                            <td className="py-2">
                              <button
                                type="button"
                                onClick={() => void handleOpenFile(entry)}
                                className="flex items-center gap-2 text-left text-sm text-slate-200 hover:text-violet-300"
                              >
                                {entry.isDirectory ? (
                                  <Folder className="h-4 w-4 text-violet-400 shrink-0" />
                                ) : (
                                  <FileCode2 className="h-4 w-4 text-slate-400 shrink-0" />
                                )}
                                <span className="font-mono text-xs">{entry.name}</span>
                              </button>
                            </td>
                            <td className="py-2 text-right font-mono text-xs text-slate-400 tabular-nums">
                              {entry.isDirectory ? '--' : formatBytes(entry.size)}
                            </td>
                            <td className="py-2 text-right font-mono text-xs text-slate-500 tabular-nums">
                              {new Date(entry.modifiedAt).toLocaleString()}
                            </td>
                            <td className="py-2 text-right">
                              <button
                                type="button"
                                onClick={() => void handleDeleteEntry(entry)}
                                aria-label={`Delete ${entry.name}`}
                                className="rounded p-1 text-slate-400 hover:bg-red-500/15 hover:text-red-300"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* TAB 7: MODRINTH API INSTALLER */}
            {activeTab === 'modrinth' && (
              <div className="space-y-4">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void runModrinthSearch(modQuery, modType);
                  }}
                  className="flex flex-wrap items-center gap-3"
                >
                  <div className="relative flex-1 min-w-[220px]">
                    <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                      type="text"
                      value={modQuery}
                      onChange={(e) => setModQuery(e.target.value)}
                      placeholder="Search Modrinth plugins or mods (e.g. EssentialsX, LuckPerms, Lithium)..."
                      className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 py-2 pr-3 pl-9 text-sm text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-1 rounded-lg bg-[#090714]/80 p-1">
                    {(['plugin', 'mod'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => {
                          setModType(t);
                          void runModrinthSearch(modQuery, t);
                        }}
                        className={`rounded-md px-3 py-1 text-xs font-medium capitalize ${
                          modType === t ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {t}s
                      </button>
                    ))}
                  </div>
                  <button
                    type="submit"
                    disabled={modSearching}
                    className="cyber-glow-btn rounded-lg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                  >
                    {modSearching ? 'Searching...' : 'Search Modrinth'}
                  </button>
                </form>

                {modSearching ? (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} className="h-24 animate-pulse rounded-lg bg-violet-950/35" />
                    ))}
                  </div>
                ) : modHits.length === 0 ? (
                  <div className="py-10 text-center text-sm text-slate-400">
                    No Modrinth results found. Try another keyword.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {modHits.map((hit) => (
                      <div
                        key={hit.project_id}
                        className="flex items-start justify-between gap-3 rounded-lg border border-violet-500/20 bg-[#090714]/60 p-3.5"
                      >
                        <div className="flex items-start gap-3 min-w-0">
                          {hit.icon_url ? (
                            <img
                              src={hit.icon_url}
                              alt={hit.title}
                              referrerPolicy="no-referrer"
                              className="h-10 w-10 rounded-lg object-cover shrink-0 bg-violet-950/50"
                            />
                          ) : (
                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-600/20 text-violet-300 shrink-0">
                              <Package className="h-5 w-5" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <h4 className="truncate text-sm font-semibold text-white">{hit.title}</h4>
                            <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">
                              {hit.description}
                            </p>
                            <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-500">
                              <span>{hit.author}</span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                {hit.downloads.toLocaleString()} downloads
                              </span>
                            </div>
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={installingId === hit.project_id}
                          onClick={() => void handleInstallModrinth(hit)}
                          className="inline-flex items-center gap-1 rounded-lg border border-violet-500/40 bg-violet-600/20 px-3 py-1.5 text-xs font-semibold text-violet-200 hover:bg-violet-600/35 disabled:opacity-50 whitespace-nowrap shrink-0"
                        >
                          <Download className="h-3.5 w-3.5" />
                          {installingId === hit.project_id ? 'Installing...' : 'Install'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB 8: CONFIGURATION, ADMIN LIMITS & DELETE */}
            {activeTab === 'settings' && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4">
                    <p className="text-xs text-slate-400">Container Identifier</p>
                    <p className="mt-1 font-mono text-sm text-white">{selectedServer.container_name}</p>
                  </div>
                  <div className="rounded-lg border border-violet-500/20 bg-[#090714]/60 p-4">
                    <p className="text-xs text-slate-400">Host Data Directory</p>
                    <p className="mt-1 truncate font-mono text-sm text-white">
                      {selectedServer.data_dir}
                    </p>
                  </div>
                </div>

                {isStaff && (
                  <div className="rounded-lg border border-violet-500/25 bg-[#090714]/60 p-4 space-y-4">
                    <h4 className="text-sm font-semibold text-white">
                      Admin Ownership & Resource Limits
                    </h4>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                      <div>
                        <label className="mb-1 block text-xs text-slate-400">Assigned Owner</label>
                        <select
                          value={adminOwnerId}
                          onChange={(e) => setAdminOwnerId(Number(e.target.value))}
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 text-xs text-white"
                        >
                          {allUsers.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.username} ({u.role})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-slate-400">RAM Limit (MB)</label>
                        <input
                          type="number"
                          min={512}
                          value={adminRam}
                          onChange={(e) => setAdminRam(Number(e.target.value))}
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 font-mono text-xs text-white"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-slate-400">CPU Limit (%)</label>
                        <input
                          type="number"
                          min={25}
                          value={adminCpu}
                          onChange={(e) => setAdminCpu(Number(e.target.value))}
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 font-mono text-xs text-white"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-slate-400">
                          Max Allocations
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={adminMaxAllocations}
                          onChange={(e) => setAdminMaxAllocations(Number(e.target.value))}
                          className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 font-mono text-xs text-white"
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={() => void handleAdminUpdate({ applyLimits: true })}
                        className="cyber-glow-btn rounded-lg px-4 py-2 text-xs font-semibold text-white"
                      >
                        Apply Owner & Limits
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void handleAdminUpdate({ isSuspended: !selectedServer.is_suspended })
                        }
                        className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-xs font-semibold text-amber-200"
                      >
                        {selectedServer.is_suspended ? 'Unsuspend Server' : 'Suspend Server'}
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
                  <div>
                    <h4 className="text-sm font-semibold text-red-200">Delete Minecraft Server</h4>
                    <p className="text-xs text-red-300/80">
                      Permanently removes the Docker container, port allocation, and all world files.
                    </p>
                  </div>
                  {!confirmDelete ? (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="rounded-lg border border-red-500/40 bg-red-500/20 px-4 py-2 text-xs font-semibold text-red-200 hover:bg-red-500/30"
                    >
                      Delete Server
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handlePower('delete')}
                        className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700"
                      >
                        Confirm Permanent Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-300"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* DEPLOY SERVER MODAL */}
      {showDeploy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-lg rounded-2xl p-6">
            <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
              <h3 className="text-lg font-semibold text-white">Deploy Minecraft Server</h3>
              <button
                type="button"
                onClick={() => setShowDeploy(false)}
                className="rounded p-1 text-slate-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleDeploy} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">Server Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Survival SMP"
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                />
              </div>

              {nodes.length > 0 && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    Target VPS Node
                  </label>
                  <select
                    value={nodeId}
                    onChange={(e) => setNodeId(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white"
                  >
                    {nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name} ({n.location}) — {n.status === 'online' ? 'Online' : 'Offline'}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {isStaff && allUsers.length > 0 && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    Assign to User
                  </label>
                  <select
                    value={assignOwnerId}
                    onChange={(e) => setAssignOwnerId(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white"
                  >
                    {allUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.username} ({u.role})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">Software</label>
                  <select
                    value={software}
                    onChange={(e) => setSoftware(e.target.value)}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                  >
                    {SOFTWARE_OPTIONS.map((sw) => (
                      <option key={sw} value={sw}>
                        {sw}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">Version</label>
                  <select
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                  >
                    {VERSION_PRESETS.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">RAM (MB)</label>
                  <input
                    type="number"
                    required
                    min={512}
                    max={65536}
                    step={256}
                    value={ramMb}
                    onChange={(e) => setRamMb(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 font-mono text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">CPU (%)</label>
                  <input
                    type="number"
                    required
                    min={25}
                    max={1600}
                    step={25}
                    value={cpuPercent}
                    onChange={(e) => setCpuPercent(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 font-mono text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-300">
                    Primary Allocation (IP:Port)
                  </label>
                  <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                    {availableNodeAllocs.length} pre-allocated free
                  </span>
                </div>
                <select
                  value={primaryAllocationChoice}
                  onChange={(e) => setPrimaryAllocationChoice(e.target.value)}
                  className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3.5 py-2 font-mono text-xs text-white"
                >
                  <option value="auto">Auto-Assign Next Available Port</option>
                  {availableNodeAllocs.map((a) => (
                    <option key={a.id} value={String(a.id)}>
                      {a.ip_alias ? `${a.ip_alias} (${a.ip})` : a.ip}:{a.port} [{a.protocol}]
                      {a.notes ? ` — ${a.notes}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {availableNodeAllocs.filter((a) => String(a.id) !== primaryAllocationChoice).length >
                0 && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    Optional Additional Ports (Geyser, Voice Chat, Dynmap)
                  </label>
                  <div className="max-h-28 overflow-y-auto rounded-lg border border-violet-500/20 bg-[#090714]/80 p-2 space-y-1">
                    {availableNodeAllocs
                      .filter((a) => String(a.id) !== primaryAllocationChoice)
                      .slice(0, 24)
                      .map((a) => {
                        const checked = additionalAllocationIds.includes(a.id);
                        return (
                          <label
                            key={a.id}
                            className="flex items-center justify-between rounded px-2 py-1 text-xs text-slate-300 hover:bg-violet-500/10"
                          >
                            <span className="flex items-center gap-2 font-mono">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setAdditionalAllocationIds((prev) => [...prev, a.id]);
                                  } else {
                                    setAdditionalAllocationIds((prev) =>
                                      prev.filter((id) => id !== a.id)
                                    );
                                  }
                                }}
                                className="h-3.5 w-3.5 accent-violet-600"
                              />
                              {a.ip_alias || a.ip}:{a.port}
                            </span>
                            {a.notes && <span className="text-[11px] text-slate-500">{a.notes}</span>}
                          </label>
                        );
                      })}
                  </div>
                </div>
              )}

              <label className="flex items-center gap-2.5 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={eulaAccepted}
                  onChange={(e) => setEulaAccepted(e.target.checked)}
                  className="h-4 w-4 rounded border-violet-500/40 bg-[#090714] accent-violet-600"
                />
                Auto-accept Mojang Minecraft EULA (EULA=TRUE)
              </label>

              <div className="flex justify-end gap-3 border-t border-violet-500/15 pt-4">
                <button
                  type="button"
                  onClick={() => setShowDeploy(false)}
                  className="rounded-lg border border-violet-500/30 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-violet-600/15"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={deploying}
                  className="cyber-glow-btn rounded-lg px-5 py-2 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {deploying ? 'Deploying...' : 'Deploy Container'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* POINT-IN-TIME RESTORE CONFIRMATION MODAL */}
      {restoreTarget && selectedServer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-md rounded-2xl p-6">
            <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-amber-400" />
                <h3 className="text-base font-semibold text-white">Restore Minecraft Backup</h3>
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
                Restoring <strong className="text-white">{selectedServer.name}</strong> from{' '}
                <span className="font-mono text-violet-300">{restoreTarget.name}</span> will stop
                the server if running, replace active world &amp; config files, and restart it if it
                was online.
              </p>
              <label className="flex items-center gap-2.5 rounded-lg border border-violet-500/20 bg-[#090714]/70 p-3 text-slate-200">
                <input
                  type="checkbox"
                  checked={restoreSafetyBackup}
                  onChange={(e) => setRestoreSafetyBackup(e.target.checked)}
                  className="h-4 w-4 accent-violet-600"
                />
                <span>Create an automatic pre-restore safety backup first</span>
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
                disabled={restoringBackup}
                onClick={() => void handleConfirmRestoreBackup()}
                className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {restoringBackup ? 'Restoring...' : 'Confirm Restore'}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedServer && (
        <AiAssistantDrawer
          open={showAiDrawer}
          onClose={() => setShowAiDrawer(false)}
          agentType="minecraft"
          resourceId={selectedServer.id}
          resourceTitle={selectedServer.name}
          resourceSubtitle={`${selectedServer.software} ${selectedServer.version}`}
          onNotify={onNotify}
          onActionExecuted={() => {
            void onRefresh();
            void loadFiles(currentDir);
            void loadProperties();
            void loadPlayers();
          }}
        />
      )}
    </div>
  );
}
