import {
  AlertTriangle,
  Bell,
  Bot,
  Check,
  Cloud,
  Copy,
  Globe,
  Image as ImageIcon,
  Key,
  KeyRound,
  Mail,
  Network,
  Palette,
  Plus,
  Save,
  Send,
  ShieldAlert,
  Smartphone,
  Trash2,
  Upload,
  UserPlus,
} from 'lucide-react';
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, copyToClipboard } from '../lib/api';
import type {
  AnnouncementConfig,
  ApiKeyItem,
  AuthUser,
  PanelAppearance,
  PanelBranding,
  PanelSettings,
  PortAllocation,
  PortPoolItem,
  UiThemeId,
} from '../types';

const UI_THEME_PRESETS: Array<{ id: UiThemeId; label: string; color: string }> = [
  { id: 'cyber-purple', label: 'Cyber Purple', color: '#7c3aed' },
  { id: 'emerald-matrix', label: 'Emerald Matrix', color: '#10b981' },
  { id: 'crimson-core', label: 'Crimson Core', color: '#e11d48' },
  { id: 'ocean-cyan', label: 'Ocean Cyan', color: '#06b6d4' },
  { id: 'amber-gold', label: 'Amber Gold', color: '#d97706' },
];

interface SettingsViewProps {
  currentUser: AuthUser;
  onBrandingChange: (branding: PanelBranding) => void;
  onAppearanceChange: (appearance: PanelAppearance) => void;
  onAnnouncementChange: (announcement: AnnouncementConfig) => void;
  onRebootWarningChange: (warning: string) => void;
  onUserRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export function SettingsView({
  currentUser,
  onBrandingChange,
  onAppearanceChange,
  onAnnouncementChange,
  onRebootWarningChange,
  onUserRefresh,
  onNotify,
}: SettingsViewProps) {
  const isStaff = currentUser.role === 'owner' || currentUser.role === 'admin';
  const isOwner = currentUser.role === 'owner';

  const [settings, setSettings] = useState<PanelSettings>({
    panel_name: 'FB BAHI Panel',
    panel_subtitle: 'Game Server & Cloud VM Control',
    discord_webhook_url: '',
    webhook_on_start: '1',
    webhook_on_stop: '1',
    webhook_on_crash: '1',
    maintenance_mode: '0',
    maintenance_message: 'FB BAHI Panel is currently undergoing scheduled maintenance.',
    announcement_enabled: '0',
    announcement_level: 'info',
    announcement_text: '',
    smtp_host: '',
    smtp_port: '587',
    smtp_user: '',
    smtp_pass: '',
    smtp_from: '',
    vps_reboot_warning: '',
    allow_public_registration: '1',
    registration_mode: 'approval',
    telegram_bot_token: '',
    telegram_chat_id: '',
    cloud_provider: 'none',
    cloud_endpoint: '',
    cloud_region: 'auto',
    cloud_bucket: '',
    cloud_access_key: '',
    cloud_secret_key: '',
    cloud_rclone_remote: '',
    cloud_rclone_folder: 'fb-bahi-backups',
    cloud_auto_upload: '0',
    openai_api_key: '',
    openai_model: 'gpt-4o-mini',
    ui_theme: 'cyber-purple',
    custom_bg_url: '',
    custom_bg_type: 'none',
    custom_bg_opacity: '0.35',
  });
  const [saving, setSaving] = useState(false);
  const [uploadingBg, setUploadingBg] = useState(false);
  const bgFileInputRef = useRef<HTMLInputElement | null>(null);
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [testingCloud, setTestingCloud] = useState(false);
  const [testingOpenAi, setTestingOpenAi] = useState(false);

  // Change password form
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');

  // 2FA TOTP state
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [totpSecret, setTotpSecret] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [disable2faPassword, setDisable2faPassword] = useState('');
  const [loading2fa, setLoading2fa] = useState(false);

  // Owner API keys
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdRawKey, setCreatedRawKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Owner Global Port Pools
  const [portPools, setPortPools] = useState<PortPoolItem[]>([]);
  const [allocatedPorts, setAllocatedPorts] = useState<PortAllocation[]>([]);
  const [poolLabel, setPoolLabel] = useState('');
  const [poolStart, setPoolStart] = useState(25565);
  const [poolEnd, setPoolEnd] = useState(25650);
  const [poolProtocol, setPoolProtocol] = useState<'tcp' | 'udp' | 'both'>('tcp');

  const loadAll = useCallback(async () => {
    try {
      const sRes = await apiFetch<{ settings: PanelSettings }>('/api/settings');
      setSettings((prev) => ({
        ...prev,
        ...sRes.settings,
        smtp_pass: sRes.settings.smtp_pass ? '********' : '',
        telegram_bot_token: sRes.settings.telegram_bot_token ? '********' : '',
        cloud_secret_key: sRes.settings.cloud_secret_key ? '********' : '',
        openai_api_key: sRes.settings.openai_api_key ? '********' : '',
      }));

      if (isStaff) {
        const poolRes = await apiFetch<{ pools: PortPoolItem[]; allocated: PortAllocation[] }>(
          '/api/owner/port-pools'
        );
        setPortPools(poolRes.pools);
        setAllocatedPorts(poolRes.allocated);
      }

      if (isOwner) {
        const keyRes = await apiFetch<{ keys: ApiKeyItem[] }>('/api/owner/api-keys');
        setApiKeys(keyRes.keys);
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load settings', 'error');
    }
  }, [isOwner, isStaff, onNotify]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function handleSaveSettings(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiFetch<{ settings: PanelSettings }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      });
      setSettings((prev) => ({
        ...prev,
        ...res.settings,
        smtp_pass: res.settings.smtp_pass ? '********' : '',
        telegram_bot_token: res.settings.telegram_bot_token ? '********' : '',
        cloud_secret_key: res.settings.cloud_secret_key ? '********' : '',
        openai_api_key: res.settings.openai_api_key ? '********' : '',
      }));
      onBrandingChange({
        panelName: res.settings.panel_name,
        panelSubtitle: res.settings.panel_subtitle,
      });
      onAppearanceChange({
        theme: (res.settings.ui_theme as UiThemeId) || 'cyber-purple',
        bgUrl: res.settings.custom_bg_url || '',
        bgType:
          (['none', 'image', 'gif', 'video'].includes(res.settings.custom_bg_type || '')
            ? res.settings.custom_bg_type
            : 'none') as PanelAppearance['bgType'],
        bgOpacity: Number(res.settings.custom_bg_opacity || '0.35') || 0.35,
      });
      onAnnouncementChange({
        enabled: res.settings.announcement_enabled === '1',
        level:
          (res.settings.announcement_level as 'info' | 'warning' | 'critical') || 'info',
        text: res.settings.announcement_text || '',
      });
      onRebootWarningChange(res.settings.vps_reboot_warning || '');
      onNotify('Panel settings saved.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleUploadBackground(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingBg(true);
    try {
      const form = new FormData();
      form.append('background', file);
      const res = await apiFetch<{
        bgUrl: string;
        bgType: PanelAppearance['bgType'];
        settings: PanelSettings;
      }>('/api/settings/background', {
        method: 'POST',
        body: form,
      });
      setSettings((prev) => ({
        ...prev,
        custom_bg_url: res.bgUrl,
        custom_bg_type: res.bgType,
      }));
      onAppearanceChange({
        theme: (res.settings.ui_theme as UiThemeId) || 'cyber-purple',
        bgUrl: res.bgUrl,
        bgType: res.bgType,
        bgOpacity: Number(res.settings.custom_bg_opacity || '0.35') || 0.35,
      });
      onNotify('Custom background uploaded and activated.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to upload background', 'error');
    } finally {
      setUploadingBg(false);
    }
  }

  async function handleResetBackground() {
    setUploadingBg(true);
    try {
      const res = await apiFetch<{ settings: PanelSettings }>('/api/settings/background', {
        method: 'DELETE',
      });
      setSettings((prev) => ({
        ...prev,
        custom_bg_url: '',
        custom_bg_type: 'none',
      }));
      onAppearanceChange({
        theme: (res.settings.ui_theme as UiThemeId) || 'cyber-purple',
        bgUrl: '',
        bgType: 'none',
        bgOpacity: Number(res.settings.custom_bg_opacity || '0.35') || 0.35,
      });
      onNotify('Custom background removed.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to remove background', 'error');
    } finally {
      setUploadingBg(false);
    }
  }

  async function handleTestWebhook() {
    setTestingWebhook(true);
    try {
      await apiFetch('/api/settings/test-webhook', { method: 'POST' });
      onNotify('Test Discord alert sent successfully.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Webhook test failed', 'error');
    } finally {
      setTestingWebhook(false);
    }
  }

  async function handleTestTelegram() {
    setTestingTelegram(true);
    try {
      await apiFetch('/api/settings/test-telegram', { method: 'POST' });
      onNotify('Test Telegram message sent successfully.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Telegram test failed (save settings first)', 'error');
    } finally {
      setTestingTelegram(false);
    }
  }

  async function handleTestCloud() {
    setTestingCloud(true);
    try {
      const res = await apiFetch<{ ok: boolean; details: string }>('/api/settings/test-cloud', {
        method: 'POST',
      });
      onNotify(res.details || 'Cloud backup storage connection verified.');
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Cloud connection test failed (save settings first)',
        'error'
      );
    } finally {
      setTestingCloud(false);
    }
  }

  async function handleTestOpenAi() {
    setTestingOpenAi(true);
    try {
      const res = await apiFetch<{ ok: boolean; message: string }>('/api/settings/test-openai', {
        method: 'POST',
        body: JSON.stringify({
          apiKey: settings.openai_api_key,
          model: settings.openai_model,
        }),
      });
      onNotify(res.message || 'OpenAI API key verified.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'OpenAI connection test failed', 'error');
    } finally {
      setTestingOpenAi(false);
    }
  }

  async function handlePasswordChange(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword: nextPassword }),
      });
      setCurrentPassword('');
      setNextPassword('');
      onNotify('Password updated.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Password change failed', 'error');
    }
  }

  async function handleInit2fa() {
    setLoading2fa(true);
    try {
      const res = await apiFetch<{ secret: string; qrDataUrl: string }>('/api/auth/2fa/setup', {
        method: 'POST',
      });
      setTotpSecret(res.secret);
      setQrDataUrl(res.qrDataUrl);
      setTotpCode('');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to initialize 2FA', 'error');
    } finally {
      setLoading2fa(false);
    }
  }

  async function handleEnable2fa(e: FormEvent) {
    e.preventDefault();
    setLoading2fa(true);
    try {
      await apiFetch('/api/auth/2fa/enable', {
        method: 'POST',
        body: JSON.stringify({ code: totpCode }),
      });
      setQrDataUrl(null);
      setTotpSecret(null);
      setTotpCode('');
      await onUserRefresh();
      onNotify('Two-Factor Authentication enabled.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Invalid 2FA code', 'error');
    } finally {
      setLoading2fa(false);
    }
  }

  async function handleDisable2fa(e: FormEvent) {
    e.preventDefault();
    setLoading2fa(true);
    try {
      await apiFetch('/api/auth/2fa/disable', {
        method: 'POST',
        body: JSON.stringify({ password: disable2faPassword }),
      });
      setDisable2faPassword('');
      await onUserRefresh();
      onNotify('Two-Factor Authentication disabled.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to disable 2FA', 'error');
    } finally {
      setLoading2fa(false);
    }
  }

  async function handleCreateApiKey(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ rawKey: string }>('/api/owner/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: newKeyName }),
      });
      setCreatedRawKey(res.rawKey);
      setCopiedKey(false);
      setNewKeyName('');
      onNotify('API key created. Copy the secret now—it will not be shown again.');
      void loadAll();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create API key', 'error');
    }
  }

  async function handleDeleteApiKey(id: number) {
    try {
      await apiFetch(`/api/owner/api-keys/${id}`, { method: 'DELETE' });
      onNotify('API key revoked.');
      void loadAll();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to revoke key', 'error');
    }
  }

  async function handleAddPortPool(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/owner/port-pools', {
        method: 'POST',
        body: JSON.stringify({
          label: poolLabel,
          startPort: Number(poolStart),
          endPort: Number(poolEnd),
          protocol: poolProtocol,
        }),
      });
      setPoolLabel('');
      onNotify('Global port pool added.');
      void loadAll();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to add port pool', 'error');
    }
  }

  async function handleDeletePortPool(id: number) {
    try {
      await apiFetch(`/api/owner/port-pools/${id}`, { method: 'DELETE' });
      onNotify('Port pool deleted.');
      void loadAll();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete port pool', 'error');
    }
  }

  return (
    <div className="space-y-6">
      {/* Row 1: Personal Security (Password + 2FA TOTP) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <form onSubmit={handlePasswordChange} className="cyber-glass rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2.5 border-b border-violet-500/15 pb-3">
            <Key className="h-5 w-5 text-violet-400" />
            <div>
              <h2 className="text-base font-semibold text-white">Account Password</h2>
              <p className="text-xs text-slate-400">
                Signed in as {currentUser.username} · <span className="capitalize">{currentUser.role}</span>
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Current Password
              </label>
              <input
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                New Password
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={nextPassword}
                onChange={(e) => setNextPassword(e.target.value)}
                className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
              />
            </div>
          </div>

          <button
            type="submit"
            className="rounded-lg border border-violet-500/35 bg-violet-600/20 px-4 py-2 text-xs font-semibold text-violet-200 hover:bg-violet-600/30 whitespace-nowrap shrink-0"
          >
            Update Password
          </button>
        </form>

        {/* TOTP Two-Factor Authentication */}
        <div className="cyber-glass rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-violet-500/15 pb-3">
            <div className="flex items-center gap-2.5">
              <Smartphone className="h-5 w-5 text-violet-400" />
              <div>
                <h2 className="text-base font-semibold text-white">Two-Factor Authentication (2FA)</h2>
                <p className="text-xs text-slate-400">
                  Protect your account with a TOTP authenticator app
                </p>
              </div>
            </div>
            <span
              className={`text-xs font-semibold ${
                currentUser.totp_enabled ? 'text-emerald-400' : 'text-slate-400'
              }`}
            >
              {currentUser.totp_enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>

          {currentUser.totp_enabled ? (
            <form onSubmit={handleDisable2fa} className="space-y-3">
              <p className="text-xs text-slate-300">
                2FA is active on your account. Enter your password below to disable it.
              </p>
              <div className="flex flex-wrap gap-2">
                <input
                  type="password"
                  required
                  value={disable2faPassword}
                  onChange={(e) => setDisable2faPassword(e.target.value)}
                  placeholder="Confirm current password"
                  className="flex-1 min-w-[200px] rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={loading2fa}
                  className="rounded-lg border border-red-500/40 bg-red-600/20 px-4 py-2 text-xs font-semibold text-red-200 hover:bg-red-600/30 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  Disable 2FA
                </button>
              </div>
            </form>
          ) : qrDataUrl && totpSecret ? (
            <form onSubmit={handleEnable2fa} className="space-y-4">
              <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
                <img
                  src={qrDataUrl}
                  alt="2FA Authenticator QR Code"
                  className="h-32 w-32 shrink-0 rounded-lg border border-violet-500/30 bg-white p-1.5"
                />
                <div className="space-y-2 text-xs text-slate-300">
                  <p>Scan this QR code in Google Authenticator, Authy, or 1Password.</p>
                  <p className="text-slate-400">Manual Setup Key:</p>
                  <code className="block rounded border border-violet-500/25 bg-[#090714] px-2.5 py-1 font-mono text-xs text-violet-300 break-all">
                    {totpSecret}
                  </code>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  required
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="Enter 6-digit code"
                  className="w-44 rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3.5 py-2 font-mono text-sm tracking-widest text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={loading2fa}
                  className="cyber-glow-btn rounded-lg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                >
                  Verify & Enable
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setQrDataUrl(null);
                    setTotpSecret(null);
                  }}
                  className="rounded-lg border border-violet-500/25 px-3 py-2 text-xs text-slate-300 hover:bg-violet-500/10 whitespace-nowrap shrink-0"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-slate-400">
                Require a one-time 6-digit verification code from your phone whenever you sign in.
              </p>
              <button
                type="button"
                onClick={handleInit2fa}
                disabled={loading2fa}
                className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
              >
                <Smartphone className="h-3.5 w-3.5" />
                Setup 2FA Authenticator
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Staff Controls: Branding, Webhooks & Owner Enterprise Config */}
      {isStaff && (
        <form onSubmit={handleSaveSettings} className="space-y-6">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Branding & Discord Webhooks */}
            <div className="cyber-glass rounded-xl p-6 space-y-5">
              <div className="flex items-center justify-between border-b border-violet-500/15 pb-4">
                <div className="flex items-center gap-2.5">
                  <Bell className="h-5 w-5 text-violet-400" />
                  <div>
                    <h2 className="text-base font-semibold text-white">Branding & Discord Alerts</h2>
                    <p className="text-xs text-slate-400">
                      Panel identity and container lifecycle webhook alerts
                    </p>
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={saving}
                  className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    Panel Name
                  </label>
                  <input
                    type="text"
                    required
                    value={settings.panel_name}
                    onChange={(e) => setSettings({ ...settings, panel_name: e.target.value })}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    Panel Subtitle
                  </label>
                  <input
                    type="text"
                    value={settings.panel_subtitle}
                    onChange={(e) => setSettings({ ...settings, panel_subtitle: e.target.value })}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">
                  Discord Webhook URL
                </label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={settings.discord_webhook_url}
                    onChange={(e) =>
                      setSettings({ ...settings, discord_webhook_url: e.target.value })
                    }
                    placeholder="https://discord.com/api/webhooks/..."
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3.5 py-2 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleTestWebhook}
                    disabled={testingWebhook || !settings.discord_webhook_url}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 px-3.5 py-2 text-xs font-medium text-violet-200 hover:bg-violet-600/20 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Send className="h-3.5 w-3.5" />
                    Test
                  </button>
                </div>
              </div>

              <div className="space-y-2 border-t border-violet-500/15 pt-4">
                <p className="text-xs font-medium text-slate-300">Alert Triggers</p>
                <label className="flex items-center gap-2.5 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={settings.webhook_on_start === '1'}
                    onChange={(e) =>
                      setSettings({ ...settings, webhook_on_start: e.target.checked ? '1' : '0' })
                    }
                    className="h-4 w-4 rounded border-violet-500/40 bg-[#090714] accent-violet-600"
                  />
                  Notify on server or VM start / deploy
                </label>
                <label className="flex items-center gap-2.5 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={settings.webhook_on_stop === '1'}
                    onChange={(e) =>
                      setSettings({ ...settings, webhook_on_stop: e.target.checked ? '1' : '0' })
                    }
                    className="h-4 w-4 rounded border-violet-500/40 bg-[#090714] accent-violet-600"
                  />
                  Notify on graceful server or VM stop
                </label>
                <label className="flex items-center gap-2.5 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={settings.webhook_on_crash === '1'}
                    onChange={(e) =>
                      setSettings({ ...settings, webhook_on_crash: e.target.checked ? '1' : '0' })
                    }
                    className="h-4 w-4 rounded border-violet-500/40 bg-[#090714] accent-violet-600"
                  />
                  Notify on force kill or unexpected crash
                </label>
              </div>

              {/* GUI Color Theme & Custom Media Background */}
              <div className="space-y-4 border-t border-violet-500/15 pt-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-xs font-medium text-slate-200">
                    <Palette className="h-4 w-4 text-violet-400" />
                    GUI Color Theme &amp; Custom Media Background
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {UI_THEME_PRESETS.map((preset) => {
                    const selected = (settings.ui_theme || 'cyber-purple') === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => {
                          setSettings({ ...settings, ui_theme: preset.id });
                          onAppearanceChange({
                            theme: preset.id,
                            bgUrl: settings.custom_bg_url || '',
                            bgType:
                              (['none', 'image', 'gif', 'video'].includes(
                                settings.custom_bg_type || ''
                              )
                                ? settings.custom_bg_type
                                : 'none') as PanelAppearance['bgType'],
                            bgOpacity: Number(settings.custom_bg_opacity || '0.35') || 0.35,
                          });
                        }}
                        className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors ${
                          selected
                            ? 'border-white/50 bg-white/10 text-white font-semibold'
                            : 'border-violet-500/20 bg-[#090714]/60 text-slate-300 hover:border-violet-400/40'
                        }`}
                      >
                        <span
                          className="h-3 w-3 shrink-0 rounded-full"
                          style={{ backgroundColor: preset.color }}
                        />
                        <span className="truncate">{preset.label}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="space-y-2.5 rounded-lg border border-violet-500/20 bg-[#090714]/50 p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
                      <ImageIcon className="h-3.5 w-3.5 text-violet-400" />
                      Custom Background (Image / GIF / MP4 / WebM)
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        ref={bgFileInputRef}
                        type="file"
                        accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.webm"
                        onChange={(e) => void handleUploadBackground(e)}
                        className="hidden"
                      />
                      <button
                        type="button"
                        disabled={uploadingBg}
                        onClick={() => bgFileInputRef.current?.click()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/35 bg-violet-600/20 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-600/30 disabled:opacity-50 whitespace-nowrap shrink-0"
                      >
                        <Upload className="h-3.5 w-3.5" />
                        {uploadingBg ? 'Uploading...' : 'Upload Media'}
                      </button>
                      {settings.custom_bg_url && (
                        <button
                          type="button"
                          disabled={uploadingBg}
                          onClick={() => void handleResetBackground()}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-500/35 px-2.5 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/15 disabled:opacity-50 whitespace-nowrap shrink-0"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Clear
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-center">
                    <div className="sm:col-span-2">
                      <input
                        type="text"
                        value={settings.custom_bg_url || ''}
                        onChange={(e) =>
                          setSettings({ ...settings, custom_bg_url: e.target.value })
                        }
                        placeholder="Uploaded path or https://... (.png, .gif, .mp4)"
                        className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-1.5 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400 whitespace-nowrap">
                        Opacity {Math.round((Number(settings.custom_bg_opacity || 0.35) || 0.35) * 100)}%
                      </span>
                      <input
                        type="range"
                        min={0.1}
                        max={0.85}
                        step={0.05}
                        value={Number(settings.custom_bg_opacity || 0.35) || 0.35}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSettings({ ...settings, custom_bg_opacity: val });
                          onAppearanceChange({
                            theme: (settings.ui_theme as UiThemeId) || 'cyber-purple',
                            bgUrl: settings.custom_bg_url || '',
                            bgType:
                              (['none', 'image', 'gif', 'video'].includes(
                                settings.custom_bg_type || ''
                              )
                                ? settings.custom_bg_type
                                : 'none') as PanelAppearance['bgType'],
                            bgOpacity: Number(val) || 0.35,
                          });
                        }}
                        className="w-full accent-violet-500"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Owner-Only Maintenance, Announcements, SMTP & Host Warning */}
            {isOwner && (
              <div className="cyber-glass rounded-xl p-6 space-y-5">
                <div className="flex items-center justify-between border-b border-violet-500/15 pb-4">
                  <div className="flex items-center gap-2.5">
                    <ShieldAlert className="h-5 w-5 text-violet-400" />
                    <div>
                      <h2 className="text-base font-semibold text-white">
                        Owner System Controls
                      </h2>
                      <p className="text-xs text-slate-400">
                        Maintenance lockout, announcements, host warnings & SMTP
                      </p>
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={saving}
                    className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                  >
                    <Save className="h-3.5 w-3.5" />
                    {saving ? 'Saving...' : 'Save Global'}
                  </button>
                </div>

                {/* Maintenance Mode */}
                <div className="space-y-2.5 rounded-lg border border-violet-500/20 bg-[#090714]/50 p-3.5">
                  <label className="flex items-center justify-between text-sm font-medium text-white">
                    <span className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-400" />
                      Maintenance Mode (Lock Regular Users)
                    </span>
                    <input
                      type="checkbox"
                      checked={settings.maintenance_mode === '1'}
                      onChange={(e) =>
                        setSettings({ ...settings, maintenance_mode: e.target.checked ? '1' : '0' })
                      }
                      className="h-4 w-4 rounded border-violet-500/40 bg-[#090714] accent-amber-500"
                    />
                  </label>
                  <input
                    type="text"
                    value={settings.maintenance_message || ''}
                    onChange={(e) =>
                      setSettings({ ...settings, maintenance_message: e.target.value })
                    }
                    placeholder="Maintenance notice displayed to locked users..."
                    className="w-full rounded-lg border border-violet-500/20 bg-[#090714]/80 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                  />
                </div>

                {/* Global Announcement Banner */}
                <div className="space-y-2.5 rounded-lg border border-violet-500/20 bg-[#090714]/50 p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-sm font-medium text-white">
                      <Globe className="h-4 w-4 text-violet-400" />
                      Global Announcement Banner
                    </label>
                    <div className="flex items-center gap-3">
                      <select
                        value={settings.announcement_level || 'info'}
                        onChange={(e) =>
                          setSettings({ ...settings, announcement_level: e.target.value })
                        }
                        className="rounded border border-violet-500/25 bg-[#090714] px-2 py-1 text-xs text-white focus:outline-none"
                      >
                        <option value="info">Info</option>
                        <option value="warning">Warning</option>
                        <option value="critical">Critical</option>
                      </select>
                      <input
                        type="checkbox"
                        checked={settings.announcement_enabled === '1'}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            announcement_enabled: e.target.checked ? '1' : '0',
                          })
                        }
                        className="h-4 w-4 rounded border-violet-500/40 bg-[#090714] accent-violet-600"
                      />
                    </div>
                  </div>
                  <input
                    type="text"
                    value={settings.announcement_text || ''}
                    onChange={(e) =>
                      setSettings({ ...settings, announcement_text: e.target.value })
                    }
                    placeholder="e.g. Scheduled kernel security update tonight at 03:00 UTC."
                    className="w-full rounded-lg border border-violet-500/20 bg-[#090714]/80 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                  />
                </div>

                {/* VPS Reboot Warning */}
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    VPS Host Reboot / Shutdown Warning Banner (Dashboard)
                  </label>
                  <input
                    type="text"
                    value={settings.vps_reboot_warning || ''}
                    onChange={(e) =>
                      setSettings({ ...settings, vps_reboot_warning: e.target.value })
                    }
                    placeholder="Leave empty to hide, or enter host reboot window notice"
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                  />
                </div>

                {/* Public Registration & Member Onboarding */}
                <div className="space-y-3 rounded-lg border border-violet-500/20 bg-[#090714]/50 p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-sm font-medium text-white">
                      <UserPlus className="h-4 w-4 text-violet-400" />
                      Allow Public Account Registration
                    </label>
                    <input
                      type="checkbox"
                      checked={settings.allow_public_registration === '1'}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          allow_public_registration: e.target.checked ? '1' : '0',
                        })
                      }
                      className="h-4 w-4 rounded border-violet-500/40 bg-[#090714] accent-violet-600"
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:items-center">
                    <span className="text-xs text-slate-400">Registration Mode</span>
                    <select
                      value={settings.registration_mode || 'approval'}
                      onChange={(e) =>
                        setSettings({ ...settings, registration_mode: e.target.value })
                      }
                      className="rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-1.5 text-xs text-white focus:border-violet-400 focus:outline-none"
                    >
                      <option value="approval">Approval Required (Pending Queue)</option>
                      <option value="instant">Instant Access (Starter Quota)</option>
                    </select>
                  </div>
                </div>

                {/* Telegram Bot Alerts */}
                <div className="border-t border-violet-500/15 pt-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-xs font-medium text-slate-300">
                      <Send className="h-3.5 w-3.5 text-cyan-400" />
                      Telegram Bot Alerts (Registrations &amp; Server Events)
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleTestTelegram()}
                      disabled={testingTelegram || !settings.telegram_bot_token || !settings.telegram_chat_id}
                      className="inline-flex items-center gap-1 rounded border border-cyan-500/35 px-2.5 py-1 text-xs font-medium text-cyan-200 hover:bg-cyan-500/15 disabled:opacity-40 whitespace-nowrap shrink-0"
                    >
                      <Send className="h-3 w-3" />
                      {testingTelegram ? 'Sending...' : 'Test Telegram'}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <input
                      type="password"
                      value={settings.telegram_bot_token || ''}
                      onChange={(e) =>
                        setSettings({ ...settings, telegram_bot_token: e.target.value })
                      }
                      placeholder="Bot Token (123456:ABC-DEF...)"
                      className="rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-1.5 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                    <input
                      type="text"
                      value={settings.telegram_chat_id || ''}
                      onChange={(e) =>
                        setSettings({ ...settings, telegram_chat_id: e.target.value })
                      }
                      placeholder="Chat ID (e.g. -1001234567890)"
                      className="rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-1.5 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                  </div>
                </div>

                {/* SMTP Email Alerts */}
                <div className="border-t border-violet-500/15 pt-4">
                  <div className="mb-2.5 flex items-center gap-2 text-xs font-medium text-slate-300">
                    <Mail className="h-3.5 w-3.5 text-violet-400" />
                    <span>SMTP Email Alert Configuration</span>
                  </div>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                    <input
                      type="text"
                      value={settings.smtp_host || ''}
                      onChange={(e) => setSettings({ ...settings, smtp_host: e.target.value })}
                      placeholder="smtp.mailgun.org"
                      className="rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                    <input
                      type="text"
                      value={settings.smtp_port || ''}
                      onChange={(e) => setSettings({ ...settings, smtp_port: e.target.value })}
                      placeholder="587"
                      className="rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-1.5 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                    <input
                      type="text"
                      value={settings.smtp_from || ''}
                      onChange={(e) => setSettings({ ...settings, smtp_from: e.target.value })}
                      placeholder="noreply@panel.local"
                      className="rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                    <input
                      type="text"
                      value={settings.smtp_user || ''}
                      onChange={(e) => setSettings({ ...settings, smtp_user: e.target.value })}
                      placeholder="SMTP Username"
                      className="sm:col-span-2 rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                    <input
                      type="password"
                      value={settings.smtp_pass || ''}
                      onChange={(e) => setSettings({ ...settings, smtp_pass: e.target.value })}
                      placeholder="SMTP Password"
                      className="rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Owner-Only AI Agents (OpenAI Integration) */}
          {isOwner && (
            <div className="cyber-glass rounded-xl p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-violet-500/15 pb-4">
                <div className="flex items-center gap-2.5">
                  <Bot className="h-5 w-5 text-violet-400" />
                  <div>
                    <h2 className="text-base font-semibold text-white">
                      AI Agents (OpenAI API Integration)
                    </h2>
                    <p className="text-xs text-slate-400">
                      Powers MC AI Assistant &amp; VPS / VM AI SysAdmin ·{' '}
                      <span className="text-slate-300">
                        {settings.openai_configured === '1'
                          ? `Active (${
                              settings.openai_source === 'env' ? '.env' : 'Encrypted Vault'
                            })`
                          : 'Not Configured'}
                      </span>
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleTestOpenAi()}
                    disabled={
                      testingOpenAi ||
                      (!settings.openai_api_key && settings.openai_configured !== '1')
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/35 px-3.5 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-500/15 disabled:opacity-40 whitespace-nowrap shrink-0"
                  >
                    <Bot className="h-3.5 w-3.5" />
                    {testingOpenAi ? 'Testing...' : 'Test OpenAI Key'}
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                  >
                    <Save className="h-3.5 w-3.5" />
                    {saving ? 'Saving...' : 'Save AI Config'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="md:col-span-2">
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    OpenAI API Key (Stored Encrypted on Backend · Never Sent to Browser)
                  </label>
                  <input
                    type="password"
                    value={settings.openai_api_key || ''}
                    onChange={(e) => setSettings({ ...settings, openai_api_key: e.target.value })}
                    placeholder={
                      settings.openai_source === 'env'
                        ? 'Loaded from .env (OPENAI_API_KEY) — enter key here to override'
                        : 'sk-... (clear field & save to revert to .env)'
                    }
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3.5 py-2 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    OpenAI Model
                  </label>
                  <select
                    value={settings.openai_model || 'gpt-4o-mini'}
                    onChange={(e) => setSettings({ ...settings, openai_model: e.target.value })}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                  >
                    <option value="gpt-4o-mini">gpt-4o-mini (Fast &amp; Cost-Efficient)</option>
                    <option value="gpt-4o">gpt-4o (Flagship Reasoning)</option>
                    <option value="gpt-4.1-mini">gpt-4.1-mini</option>
                    <option value="gpt-4.1">gpt-4.1</option>
                    <option value="o4-mini">o4-mini</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Owner-Only Off-Site Cloud Backup Storage */}
          {isOwner && (
            <div className="cyber-glass rounded-xl p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-violet-500/15 pb-4">
                <div className="flex items-center gap-2.5">
                  <Cloud className="h-5 w-5 text-cyan-400" />
                  <div>
                    <h2 className="text-base font-semibold text-white">
                      Automated Cloud Backup Storage (S3 / R2 / B2 / Google Drive)
                    </h2>
                    <p className="text-xs text-slate-400">
                      Offload Minecraft .tar.gz &amp; Incus archives off-site and restore seamlessly
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleTestCloud()}
                    disabled={testingCloud || !settings.cloud_provider || settings.cloud_provider === 'none'}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/35 px-3.5 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-500/15 disabled:opacity-40 whitespace-nowrap shrink-0"
                  >
                    <Cloud className="h-3.5 w-3.5" />
                    {testingCloud ? 'Testing...' : 'Test Cloud Connection'}
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                  >
                    <Save className="h-3.5 w-3.5" />
                    {saving ? 'Saving...' : 'Save Cloud Config'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    Storage Provider
                  </label>
                  <select
                    value={settings.cloud_provider || 'none'}
                    onChange={(e) => setSettings({ ...settings, cloud_provider: e.target.value })}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3.5 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                  >
                    <option value="none">Disabled (Local Vault Only)</option>
                    <option value="s3">AWS S3 / Compatible</option>
                    <option value="r2">Cloudflare R2</option>
                    <option value="b2">Backblaze B2 (S3 API)</option>
                    <option value="gdrive">Google Drive (via rclone)</option>
                  </select>
                </div>

                <div className="flex items-end md:col-span-2">
                  <label className="flex w-full items-center justify-between rounded-lg border border-violet-500/20 bg-[#090714]/60 px-4 py-2.5 text-xs text-slate-200">
                    <span>
                      Auto-upload newly created manual &amp; scheduled backups to cloud storage
                    </span>
                    <input
                      type="checkbox"
                      checked={settings.cloud_auto_upload === '1'}
                      onChange={(e) =>
                        setSettings({ ...settings, cloud_auto_upload: e.target.checked ? '1' : '0' })
                      }
                      className="h-4 w-4 rounded border-violet-500/40 bg-[#090714] accent-cyan-500"
                    />
                  </label>
                </div>
              </div>

              {(settings.cloud_provider === 's3' ||
                settings.cloud_provider === 'r2' ||
                settings.cloud_provider === 'b2') && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">
                      S3 Endpoint URL {settings.cloud_provider === 's3' ? '(Optional for AWS)' : ''}
                    </label>
                    <input
                      type="url"
                      value={settings.cloud_endpoint || ''}
                      onChange={(e) =>
                        setSettings({ ...settings, cloud_endpoint: e.target.value })
                      }
                      placeholder={
                        settings.cloud_provider === 'r2'
                          ? 'https://<account>.r2.cloudflarestorage.com'
                          : settings.cloud_provider === 'b2'
                          ? 'https://s3.us-west-004.backblazeb2.com'
                          : 'https://s3.amazonaws.com'
                      }
                      className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-2 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Region</label>
                    <input
                      type="text"
                      value={settings.cloud_region || 'auto'}
                      onChange={(e) => setSettings({ ...settings, cloud_region: e.target.value })}
                      placeholder="auto or us-east-1"
                      className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-2 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Bucket Name</label>
                    <input
                      type="text"
                      value={settings.cloud_bucket || ''}
                      onChange={(e) => setSettings({ ...settings, cloud_bucket: e.target.value })}
                      placeholder="fb-bahi-backups"
                      className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-2 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Access Key ID</label>
                    <input
                      type="text"
                      value={settings.cloud_access_key || ''}
                      onChange={(e) =>
                        setSettings({ ...settings, cloud_access_key: e.target.value })
                      }
                      placeholder="AKIA..."
                      className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-2 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-xs text-slate-400">Secret Access Key</label>
                    <input
                      type="password"
                      value={settings.cloud_secret_key || ''}
                      onChange={(e) =>
                        setSettings({ ...settings, cloud_secret_key: e.target.value })
                      }
                      placeholder="Secret key (stored encrypted in panel DB)"
                      className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-2 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                  </div>
                </div>
              )}

              {settings.cloud_provider === 'gdrive' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">
                      rclone Remote Name (configured on VPS host)
                    </label>
                    <input
                      type="text"
                      value={settings.cloud_rclone_remote || ''}
                      onChange={(e) =>
                        setSettings({ ...settings, cloud_rclone_remote: e.target.value })
                      }
                      placeholder="gdrive"
                      className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-2 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">
                      Remote Destination Folder
                    </label>
                    <input
                      type="text"
                      value={settings.cloud_rclone_folder || 'fb-bahi-backups'}
                      onChange={(e) =>
                        setSettings({ ...settings, cloud_rclone_folder: e.target.value })
                      }
                      placeholder="fb-bahi-backups"
                      className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-2 font-mono text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </form>
      )}

      {/* Owner API Keys & Global Port Allocation Pools */}
      {isStaff && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {isOwner && (
            <div className="cyber-glass rounded-xl p-6 space-y-4">
              <div className="flex items-center gap-2.5 border-b border-violet-500/15 pb-3">
                <KeyRound className="h-5 w-5 text-violet-400" />
                <div>
                  <h2 className="text-base font-semibold text-white">Owner API Keys</h2>
                  <p className="text-xs text-slate-400">
                    Authenticate external automation scripts via <code className="text-violet-300">x-api-key</code> header
                  </p>
                </div>
              </div>

              {createdRawKey && (
                <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 space-y-1.5">
                  <p className="text-xs font-semibold text-emerald-300">
                    New API Key Generated (copy now—hidden on refresh):
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 truncate rounded bg-[#090714] px-2.5 py-1.5 font-mono text-xs text-white">
                      {createdRawKey}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        void copyToClipboard(createdRawKey).then((ok) => {
                          if (ok) setCopiedKey(true);
                        });
                      }}
                      className="inline-flex items-center gap-1 rounded border border-emerald-500/40 px-2.5 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20 whitespace-nowrap shrink-0"
                    >
                      {copiedKey ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      {copiedKey ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              <form onSubmit={handleCreateApiKey} className="flex gap-2">
                <input
                  type="text"
                  required
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="Key label (e.g. WHMCS Billing Sync)"
                  className="flex-1 rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                />
                <button
                  type="submit"
                  className="cyber-glow-btn inline-flex items-center gap-1 rounded-lg px-3.5 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Generate
                </button>
              </form>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-violet-500/15 text-slate-400">
                      <th className="pb-2 font-medium">Label</th>
                      <th className="pb-2 font-medium">Prefix</th>
                      <th className="pb-2 font-medium">Last Used</th>
                      <th className="pb-2 font-medium text-right">Revoke</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-violet-500/10">
                    {apiKeys.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-4 text-center text-slate-500">
                          No active API keys.
                        </td>
                      </tr>
                    ) : (
                      apiKeys.map((k) => (
                        <tr key={k.id}>
                          <td className="py-2 font-medium text-white">{k.name}</td>
                          <td className="py-2 font-mono text-violet-300">{k.key_prefix}...</td>
                          <td className="py-2 text-slate-400">
                            {k.last_used_at ? k.last_used_at : 'Never'}
                          </td>
                          <td className="py-2 text-right">
                            <button
                              type="button"
                              onClick={() => void handleDeleteApiKey(k.id)}
                              aria-label={`Revoke ${k.name}`}
                              className="rounded p-1 text-slate-400 hover:bg-red-500/15 hover:text-red-300"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Global Port Allocation Pools */}
          <div className={`cyber-glass rounded-xl p-6 space-y-4 ${!isOwner ? 'lg:col-span-2' : ''}`}>
            <div className="flex items-center justify-between border-b border-violet-500/15 pb-3">
              <div className="flex items-center gap-2.5">
                <Network className="h-5 w-5 text-violet-400" />
                <div>
                  <h2 className="text-base font-semibold text-white">Global Port Allocation Pools</h2>
                  <p className="text-xs text-slate-400">
                    Managed host port ranges ({allocatedPorts.length} active bindings)
                  </p>
                </div>
              </div>
            </div>

            {isOwner && (
              <form
                onSubmit={handleAddPortPool}
                className="grid grid-cols-1 gap-2 sm:grid-cols-5"
              >
                <input
                  type="text"
                  required
                  value={poolLabel}
                  onChange={(e) => setPoolLabel(e.target.value)}
                  placeholder="Pool name (e.g. Game Node 1)"
                  className="sm:col-span-2 rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                />
                <input
                  type="number"
                  required
                  min={1024}
                  max={65535}
                  value={poolStart}
                  onChange={(e) => setPoolStart(Number(e.target.value))}
                  className="rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-2 font-mono text-xs text-white focus:border-violet-400 focus:outline-none"
                />
                <input
                  type="number"
                  required
                  min={1024}
                  max={65535}
                  value={poolEnd}
                  onChange={(e) => setPoolEnd(Number(e.target.value))}
                  className="rounded-lg border border-violet-500/25 bg-[#090714]/80 px-3 py-2 font-mono text-xs text-white focus:border-violet-400 focus:outline-none"
                />
                <div className="flex gap-1.5">
                  <select
                    value={poolProtocol}
                    onChange={(e) =>
                      setPoolProtocol(e.target.value as 'tcp' | 'udp' | 'both')
                    }
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/80 px-2 py-2 text-xs text-white focus:border-violet-400 focus:outline-none"
                  >
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                    <option value="both">Both</option>
                  </select>
                  <button
                    type="submit"
                    className="cyber-glow-btn inline-flex items-center justify-center rounded-lg px-3 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </form>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-violet-500/15 text-slate-400">
                    <th className="pb-2 font-medium">Pool Label</th>
                    <th className="pb-2 font-medium">Range</th>
                    <th className="pb-2 font-medium">Protocol</th>
                    {isOwner && <th className="pb-2 font-medium text-right">Remove</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-violet-500/10">
                  {portPools.map((pool) => (
                    <tr key={pool.id}>
                      <td className="py-2 font-medium text-white">{pool.label}</td>
                      <td className="py-2 font-mono text-violet-300 tabular-nums">
                        {pool.start_port} – {pool.end_port}
                      </td>
                      <td className="py-2 font-mono uppercase text-slate-300">{pool.protocol}</td>
                      {isOwner && (
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            onClick={() => void handleDeletePortPool(pool.id)}
                            aria-label={`Delete ${pool.label}`}
                            className="rounded p-1 text-slate-400 hover:bg-red-500/15 hover:text-red-300"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
