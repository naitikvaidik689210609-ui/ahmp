import { Box, Search, Server, Settings, User, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { GlobalSearchResults, UserRole } from '../types';

interface CommandPaletteProps {
  open: boolean;
  userRole: UserRole;
  onClose: () => void;
  onNavigate: (
    section:
      | 'overview'
      | 'minecraft'
      | 'incus'
      | 'backups'
      | 'nodes'
      | 'new-members'
      | 'users'
      | 'audit'
      | 'settings',
    itemId?: number
  ) => void;
}

export function CommandPalette({
  open,
  userRole,
  onClose,
  onNavigate,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GlobalSearchResults>({
    servers: [],
    instances: [],
    users: [],
  });
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 20);
    } else {
      setQuery('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      apiFetch<GlobalSearchResults>(`/api/search?q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (active) setResults(res);
        })
        .catch(() => {})
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 120);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, open]);

  if (!open) return null;

  const isStaff = userRole === 'owner' || userRole === 'admin';
  type PaletteSection =
    | 'overview'
    | 'minecraft'
    | 'incus'
    | 'backups'
    | 'nodes'
    | 'new-members'
    | 'users'
    | 'audit'
    | 'settings';
  const basePages: Array<{ label: string; section: PaletteSection }> = [
    { label: 'Resource Overview', section: 'overview' },
    { label: 'Minecraft Manager', section: 'minecraft' },
    { label: 'VMs & LXC Containers', section: 'incus' },
    { label: 'Backups & Snapshots', section: 'backups' },
    ...(isStaff
      ? [
          { label: 'VPS Nodes & Agents', section: 'nodes' as const },
          { label: 'New Members & Approvals', section: 'new-members' as const },
          { label: 'Users & Resource Quotas', section: 'users' as const },
          { label: 'Security & Audit Logs', section: 'audit' as const },
        ]
      : []),
    { label: 'Panel & Profile Settings', section: 'settings' },
  ];
  const quickPages = basePages.filter(
    (p) => !query.trim() || p.label.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-20 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="cyber-glass w-full max-w-xl overflow-hidden rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-violet-500/20 px-4 py-3">
          <Search className="h-4 w-4 text-violet-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to server, VM, user, or setting..."
            className="w-full bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[420px] overflow-y-auto p-3 space-y-4">
          {loading && <p className="px-2 text-xs text-slate-400">Searching...</p>}

          {results.servers.length > 0 && (
            <div>
              <p className="mb-1.5 px-2 text-xs font-medium text-slate-400">Minecraft Servers</p>
              <div className="space-y-1">
                {results.servers.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      onNavigate('minecraft', s.id);
                      onClose();
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-violet-600/20"
                  >
                    <span className="flex items-center gap-2.5">
                      <Box className="h-4 w-4 text-violet-400" />
                      <span>{s.name}</span>
                    </span>
                    <span className="font-mono text-xs text-slate-400">
                      {s.software} · :{s.port}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.instances.length > 0 && (
            <div>
              <p className="mb-1.5 px-2 text-xs font-medium text-slate-400">LXC & KVM Instances</p>
              <div className="space-y-1">
                {results.instances.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => {
                      onNavigate('incus', i.id);
                      onClose();
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-violet-600/20"
                  >
                    <span className="flex items-center gap-2.5">
                      <Server className="h-4 w-4 text-violet-400" />
                      <span>{i.name}</span>
                    </span>
                    <span className="font-mono text-xs text-slate-400">
                      {i.type.toUpperCase()} · {i.os_template}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.users.length > 0 && (
            <div>
              <p className="mb-1.5 px-2 text-xs font-medium text-slate-400">Users</p>
              <div className="space-y-1">
                {results.users.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => {
                      onNavigate('users');
                      onClose();
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-violet-600/20"
                  >
                    <span className="flex items-center gap-2.5">
                      <User className="h-4 w-4 text-violet-400" />
                      <span>{u.username}</span>
                    </span>
                    <span className="text-xs text-slate-400 capitalize">
                      {u.role} · {u.email}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {quickPages.length > 0 && (
            <div>
              <p className="mb-1.5 px-2 text-xs font-medium text-slate-400">Navigation</p>
              <div className="space-y-1">
                {quickPages.map((p) => (
                  <button
                    key={p.section}
                    type="button"
                    onClick={() => {
                      onNavigate(p.section);
                      onClose();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-violet-600/20"
                  >
                    <Settings className="h-4 w-4 text-slate-400" />
                    <span>{p.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
