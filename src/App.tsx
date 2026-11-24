import {
  Activity,
  AlertTriangle,
  Archive,
  Box,
  ClipboardList,
  Globe,
  Info,
  LogOut,
  Menu,
  Plus,
  Search,
  Server,
  Settings,
  Shield,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { AuditLogsView } from './components/AuditLogsView';
import { BackupsView } from './components/BackupsView';
import { CommandPalette } from './components/CommandPalette';
import { IncusView } from './components/IncusView';
import { LoginView } from './components/LoginView';
import { MinecraftView } from './components/MinecraftView';
import { NewMembersView } from './components/NewMembersView';
import { NodesView } from './components/NodesView';
import { OverviewView } from './components/OverviewView';
import { SettingsView } from './components/SettingsView';
import { UsersQuotasView } from './components/UsersQuotasView';
import { apiFetch, setAuthToken, setUnauthorizedHandler } from './lib/api';
import type {
  AnnouncementConfig,
  AuthUser,
  HostCapabilities,
  LiveSystemStats,
  MinecraftServer,
  PanelAppearance,
  PanelBranding,
  UserQuotaSummary,
  VmInstance,
} from './types';

type ActiveSection =
  | 'overview'
  | 'minecraft'
  | 'incus'
  | 'backups'
  | 'nodes'
  | 'new-members'
  | 'users'
  | 'audit'
  | 'settings';

export default function App() {
  const [bootLoading, setBootLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [allowPublicRegistration, setAllowPublicRegistration] = useState(true);
  const [registrationMode, setRegistrationMode] = useState<'instant' | 'approval'>('approval');
  const [pendingMembersCount, setPendingMembersCount] = useState(0);
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState(
    'FB BAHI Panel is currently undergoing maintenance.'
  );
  const [announcement, setAnnouncement] = useState<AnnouncementConfig>({
    enabled: false,
    level: 'info',
    text: '',
  });
  const [vpsRebootWarning, setVpsRebootWarning] = useState('');
  const [branding, setBranding] = useState<PanelBranding>({
    panelName: 'FB BAHI Panel',
    panelSubtitle: 'Game Server & Cloud VM Control',
  });
  const [appearance, setAppearance] = useState<PanelAppearance>({
    theme: 'cyber-purple',
    bgUrl: '',
    bgType: 'none',
    bgOpacity: 0.35,
  });
  const [user, setUser] = useState<AuthUser | null>(null);
  const [quota, setQuota] = useState<UserQuotaSummary | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const [section, setSection] = useState<ActiveSection>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const [socket, setSocket] = useState<Socket | null>(null);
  const [stats, setStats] = useState<LiveSystemStats | null>(null);
  const [history, setHistory] = useState<LiveSystemStats[]>([]);
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(null);

  const [servers, setServers] = useState<MinecraftServer[]>([]);
  const [selectedMcId, setSelectedMcId] = useState<number | null>(null);
  const [deployMcSignal, setDeployMcSignal] = useState(0);

  const [instances, setInstances] = useState<VmInstance[]>([]);
  const [selectedVmId, setSelectedVmId] = useState<number | null>(null);
  const [createVmSignal, setCreateVmSignal] = useState(0);

  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const notify = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => {
      setToast((prev) => (prev?.msg === msg ? null : prev));
    }, 5000);
  }, []);

  const fetchAuthStatus = useCallback(() => {
    return apiFetch<{
      needsSetup: boolean;
      allowPublicRegistration: boolean;
      registrationMode: 'instant' | 'approval';
      maintenanceMode: boolean;
      maintenanceMessage: string;
      announcement: AnnouncementConfig;
      branding: PanelBranding;
      appearance?: PanelAppearance;
      vpsRebootWarning: string;
    }>('/api/auth/status')
      .then((res) => {
        setNeedsSetup(res.needsSetup);
        setAllowPublicRegistration(res.allowPublicRegistration !== false);
        setRegistrationMode(res.registrationMode === 'instant' ? 'instant' : 'approval');
        setMaintenanceMode(res.maintenanceMode);
        setMaintenanceMessage(res.maintenanceMessage);
        setAnnouncement(res.announcement);
        setBranding(res.branding);
        if (res.appearance) {
          setAppearance(res.appearance);
        }
        setVpsRebootWarning(res.vpsRebootWarning || '');
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', appearance.theme || 'cyber-purple');
  }, [appearance.theme]);

  const handleLogout = useCallback(() => {
    setAuthToken(null);
    setToken(null);
    setUser(null);
    setQuota(null);
    setPendingMembersCount(0);
    setSocket((prev) => {
      prev?.disconnect();
      return null;
    });
    void fetchAuthStatus();
  }, [fetchAuthStatus]);

  useEffect(() => {
    setUnauthorizedHandler(handleLogout);
    void fetchAuthStatus().finally(() => setBootLoading(false));
  }, [handleLogout, fetchAuthStatus]);

  // Global Ctrl+K / Cmd+K shortcut for Command Palette
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (user && token) {
          setPaletteOpen((prev) => !prev);
        }
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [user, token]);

  const refreshMe = useCallback(async () => {
    if (!token) return;
    try {
      const res = await apiFetch<{ user: AuthUser; quota: UserQuotaSummary }>('/api/auth/me');
      setUser((prev) => ({
        ...res.user,
        impersonatedBy: prev?.impersonatedBy || res.user.impersonatedBy,
      }));
      setQuota(res.quota);
    } catch {
      // Handled by global 401/503 handler if unauthorized
    }
  }, [token]);

  const refreshWorkloads = useCallback(async () => {
    if (!token) return;
    try {
      const [mcRes, vmRes, capRes, meRes] = await Promise.all([
        apiFetch<{ servers: MinecraftServer[] }>('/api/minecraft/servers'),
        apiFetch<{ instances: VmInstance[] }>('/api/incus/instances'),
        apiFetch<HostCapabilities>('/api/system/capabilities'),
        apiFetch<{ user: AuthUser; quota: UserQuotaSummary }>('/api/auth/me'),
      ]);
      setServers(mcRes.servers);
      setInstances(vmRes.instances);
      setCapabilities(capRes);
      setUser((prev) => ({
        ...meRes.user,
        impersonatedBy: prev?.impersonatedBy || meRes.user.impersonatedBy,
      }));
      setQuota(meRes.quota);
      if (meRes.user.role === 'owner' || meRes.user.role === 'admin') {
        apiFetch<{ pendingCount: number }>('/api/users/new-members')
          .then((nm) => setPendingMembersCount(nm.pendingCount || 0))
          .catch(() => {});
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to refresh workloads', 'error');
    }
  }, [token, notify]);

  useEffect(() => {
    if (!token) return;

    void refreshWorkloads();

    const s = io({
      path: '/socket.io',
      auth: { token },
    });

    s.on('system:stats', (payload: LiveSystemStats) => {
      setStats(payload);
      setHistory((prev) => [...prev.slice(-29), payload]);
    });

    setSocket(s);

    return () => {
      s.disconnect();
      setSocket(null);
    };
  }, [token, refreshWorkloads]);

  function handleAuthSuccess(newToken: string, loggedUser: AuthUser) {
    setAuthToken(newToken);
    setToken(newToken);
    setUser(loggedUser);
    setNeedsSetup(false);
    setSection('overview');
  }

  function handleImpersonateSwitch(newToken: string, targetUser: AuthUser) {
    setAuthToken(newToken);
    setToken(newToken);
    setUser(targetUser);
    setSection('overview');
    notify(`Now viewing panel as ${targetUser.username} (${targetUser.role}).`);
  }

  async function handleExitImpersonation() {
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>(
        '/api/owner/exit-impersonation',
        { method: 'POST' }
      );
      setAuthToken(res.token);
      setToken(res.token);
      setUser(res.user);
      setSection('users');
      notify(`Returned to owner account (${res.user.username}).`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to exit impersonation', 'error');
    }
  }

  if (bootLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0d0a1a] text-sm text-slate-400">
        Initializing {branding.panelName}...
      </div>
    );
  }

  if (!user || !token) {
    return (
      <LoginView
        needsSetup={needsSetup}
        allowPublicRegistration={allowPublicRegistration}
        registrationMode={registrationMode}
        maintenanceMode={maintenanceMode}
        maintenanceMessage={maintenanceMessage}
        branding={branding}
        appearance={appearance}
        onSuccess={handleAuthSuccess}
      />
    );
  }

  const isStaff = user.role === 'owner' || user.role === 'admin';

  const navItems: Array<{
    id: ActiveSection;
    label: string;
    icon: typeof Activity;
    badge?: number;
  }> = [
    { id: 'overview', label: 'Overview', icon: Activity },
    { id: 'minecraft', label: 'Minecraft', icon: Box },
    { id: 'incus', label: 'VMs & LXC', icon: Server },
    { id: 'backups', label: 'Backups & Snapshots', icon: Archive },
    ...(isStaff
      ? [
          { id: 'nodes' as const, label: 'Nodes', icon: Globe },
          {
            id: 'new-members' as const,
            label: 'New Members',
            icon: UserPlus,
            badge: pendingMembersCount,
          },
          { id: 'users' as const, label: 'Users & Quotas', icon: Users },
          { id: 'audit' as const, label: 'Audit Logs', icon: ClipboardList },
        ]
      : []),
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const sectionMeta: Record<ActiveSection, { title: string; ctaLabel?: string; ctaAction?: () => void }> = {
    overview: {
      title: 'Resource Overview',
      ctaLabel: 'Deploy Server',
      ctaAction: () => {
        setSection('minecraft');
        setDeployMcSignal((n) => n + 1);
      },
    },
    minecraft: {
      title: 'Minecraft Manager',
      ctaLabel: 'Deploy Server',
      ctaAction: () => setDeployMcSignal((n) => n + 1),
    },
    incus: {
      title: 'VMs & Containers',
      ctaLabel: 'Launch Instance',
      ctaAction: () => setCreateVmSignal((n) => n + 1),
    },
    backups: { title: 'Backups & Snapshots' },
    nodes: { title: 'Multi-Node VPS Mesh' },
    'new-members': { title: 'New Members & Approvals' },
    users: { title: 'Users & Resource Quotas' },
    audit: { title: 'Audit Logs' },
    settings: { title: 'Panel & Account Settings' },
  };

  const activeSection: ActiveSection =
    !isStaff &&
    (section === 'users' ||
      section === 'audit' ||
      section === 'nodes' ||
      section === 'new-members')
      ? 'overview'
      : section;
  const currentMeta = sectionMeta[activeSection];

  return (
    <div className="relative flex min-h-screen bg-[var(--bg-base)] text-slate-100">
      {/* Custom Media Background (Image / GIF / Video) */}
      {appearance.bgUrl && appearance.bgType !== 'none' && (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
          {appearance.bgType === 'video' ? (
            <video
              key={appearance.bgUrl}
              src={appearance.bgUrl}
              autoPlay
              loop
              muted
              playsInline
              className="h-full w-full object-cover"
              style={{ opacity: appearance.bgOpacity }}
            />
          ) : (
            <img
              key={appearance.bgUrl}
              src={appearance.bgUrl}
              alt=""
              className="h-full w-full object-cover"
              style={{ opacity: appearance.bgOpacity }}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-[#070510]/65 via-[#090714]/55 to-[#070510]/80" />
        </div>
      )}

      {/* Ambient Subtle Glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background:
            'radial-gradient(circle at 12% 10%, rgba(var(--accent-rgb), 0.14), transparent 38%), radial-gradient(circle at 88% 85%, rgba(var(--accent-soft-rgb), 0.1), transparent 40%)',
        }}
      />

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-violet-500/20 bg-[#110d22]/95 backdrop-blur-xl transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-violet-500/15 px-5 py-5">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-violet-500/40 bg-violet-600/20 text-violet-300">
              <Shield className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <span className="block truncate font-display text-base font-bold text-white">
                {branding.panelName}
              </span>
              <span className="block truncate text-xs text-slate-400">
                {branding.panelSubtitle}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="rounded p-1 text-slate-400 hover:text-white lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSection(item.id);
                  setMobileMenuOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'border border-violet-500/40 bg-violet-600/20 text-white'
                    : 'border border-transparent text-slate-400 hover:bg-violet-500/10 hover:text-slate-100'
                }`}
              >
                <span className="flex items-center gap-3">
                  <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-violet-300' : 'text-slate-400'}`} />
                  <span>{item.label}</span>
                </span>
                {item.badge !== undefined && item.badge > 0 && (
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[11px] font-bold text-amber-300 tabular-nums">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-violet-500/15 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">{user.username}</p>
              <p className="truncate text-xs text-slate-400 capitalize">{user.role} Account</p>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              title="Sign Out"
              aria-label="Sign Out"
              className="rounded-lg border border-violet-500/25 p-2 text-slate-300 transition-colors hover:bg-red-500/15 hover:text-red-300"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="relative z-10 flex flex-1 flex-col min-w-0">
        {/* Owner Impersonation Bar */}
        {user.impersonatedBy && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-950/80 px-6 py-2.5 text-xs text-amber-100">
            <span>
              Impersonating <strong>{user.username}</strong> ({user.role}) · Started by Owner{' '}
              <strong>{user.impersonatedBy.username}</strong>
            </span>
            <button
              type="button"
              onClick={() => void handleExitImpersonation()}
              className="rounded-lg border border-amber-400/50 bg-amber-500/20 px-3 py-1 font-semibold text-amber-100 hover:bg-amber-500/30 whitespace-nowrap shrink-0"
            >
              Exit Impersonation
            </button>
          </div>
        )}

        {/* Global Announcement Banner */}
        {announcement.enabled && announcement.text && (
          <div
            className={`flex items-center gap-2.5 border-b px-6 py-2.5 text-xs font-medium ${
              announcement.level === 'critical'
                ? 'border-red-500/40 bg-red-950/75 text-red-100'
                : announcement.level === 'warning'
                ? 'border-amber-500/40 bg-amber-950/70 text-amber-100'
                : 'border-violet-500/30 bg-violet-950/60 text-violet-100'
            }`}
          >
            {announcement.level === 'info' ? (
              <Info className="h-4 w-4 shrink-0 text-violet-300" />
            ) : (
              <AlertTriangle
                className={`h-4 w-4 shrink-0 ${
                  announcement.level === 'critical' ? 'text-red-400' : 'text-amber-400'
                }`}
              />
            )}
            <span>{announcement.text}</span>
          </div>
        )}

        {/* Top Bar Contract: Context Breadcrumb — Search Trigger — Primary Action */}
        <header className="flex items-center justify-between gap-4 border-b border-violet-500/20 bg-[#0f0b1e]/80 px-6 py-4 backdrop-blur-md">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation"
              className="rounded-lg border border-violet-500/25 p-2 text-slate-300 lg:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-2 text-sm truncate">
              <span className="text-slate-400 whitespace-nowrap">{branding.panelName}</span>
              <span className="text-slate-600" aria-hidden="true">/</span>
              <h1 className="font-semibold text-white whitespace-nowrap truncate">
                {currentMeta.title}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-violet-500/25 bg-[#090714]/70 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-violet-400/50 hover:text-white whitespace-nowrap shrink-0"
            >
              <Search className="h-3.5 w-3.5 text-violet-400" />
              <span className="hidden sm:inline">Quick Search</span>
              <kbd className="rounded border border-violet-500/25 bg-[#120d26] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                Ctrl+K
              </kbd>
            </button>

            {currentMeta.ctaLabel && currentMeta.ctaAction && (
              <button
                type="button"
                onClick={currentMeta.ctaAction}
                className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
              >
                <Plus className="h-3.5 w-3.5" />
                {currentMeta.ctaLabel}
              </button>
            )}
          </div>
        </header>

        {/* Main Viewport */}
        <main className="mx-auto w-full max-w-[1400px] flex-1 p-6">
          {activeSection === 'overview' && (
            <OverviewView
              user={user}
              quota={quota}
              vpsRebootWarning={vpsRebootWarning}
              stats={stats}
              history={history}
              capabilities={capabilities}
              servers={servers}
              instances={instances}
              onNavigate={(tab, itemId) => {
                setSection(tab);
                if (tab === 'minecraft' && itemId) setSelectedMcId(itemId);
                if (tab === 'incus' && itemId) setSelectedVmId(itemId);
              }}
            />
          )}

          {activeSection === 'minecraft' && (
            <MinecraftView
              currentUser={user}
              servers={servers}
              selectedId={selectedMcId}
              onSelect={setSelectedMcId}
              onRefresh={refreshWorkloads}
              socket={socket}
              onNotify={notify}
              openDeploySignal={deployMcSignal}
            />
          )}

          {activeSection === 'incus' && (
            <IncusView
              currentUser={user}
              instances={instances}
              selectedId={selectedVmId}
              onSelect={setSelectedVmId}
              onRefresh={refreshWorkloads}
              socket={socket}
              onNotify={notify}
              openCreateSignal={createVmSignal}
            />
          )}

          {activeSection === 'backups' && (
            <BackupsView
              servers={servers}
              instances={instances}
              onRefresh={refreshWorkloads}
              onNotify={notify}
            />
          )}

          {activeSection === 'nodes' && isStaff && (
            <NodesView
              currentUser={user}
              socket={socket}
              onNotify={notify}
              onNavigateToServer={(serverId) => {
                setSection('minecraft');
                setSelectedMcId(serverId);
              }}
            />
          )}

          {activeSection === 'new-members' && isStaff && (
            <NewMembersView
              currentUser={user}
              onPendingCountChange={setPendingMembersCount}
              onNotify={notify}
            />
          )}

          {activeSection === 'users' && isStaff && (
            <UsersQuotasView
              currentUser={user}
              onImpersonate={handleImpersonateSwitch}
              onNotify={notify}
            />
          )}

          {activeSection === 'audit' && isStaff && <AuditLogsView />}

          {activeSection === 'settings' && (
            <SettingsView
              currentUser={user}
              onBrandingChange={setBranding}
              onAppearanceChange={setAppearance}
              onAnnouncementChange={setAnnouncement}
              onRebootWarningChange={setVpsRebootWarning}
              onUserRefresh={refreshMe}
              onNotify={notify}
            />
          )}
        </main>
      </div>

      {/* Global Search Command Palette */}
      <CommandPalette
        open={paletteOpen}
        userRole={user.role}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(targetSection, itemId) => {
          setSection(targetSection);
          if (targetSection === 'minecraft' && itemId) setSelectedMcId(itemId);
          if (targetSection === 'incus' && itemId) setSelectedVmId(itemId);
        }}
      />

      {/* Toast Notification */}
      {toast && (
        <div
          role="status"
          className={`fixed right-5 bottom-5 z-50 flex items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl backdrop-blur-md ${
            toast.type === 'error'
              ? 'border-red-500/40 bg-red-950/90 text-red-100'
              : 'border-violet-500/40 bg-[#171130]/95 text-white'
          }`}
        >
          <span>{toast.msg}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="text-slate-400 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
