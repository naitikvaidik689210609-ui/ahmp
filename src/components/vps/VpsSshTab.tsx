import { Copy, Eye, EyeOff, KeyRound, Plus, RefreshCw, Shield, Terminal, Trash2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { apiFetch, copyToClipboard } from '../../lib/api';
import type { VmInstance, VmSshDetails } from '../../types';

interface VpsSshTabProps {
  instance: VmInstance;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onOpenConsole: () => void;
}

export function VpsSshTab({ instance, onNotify, onOpenConsole }: VpsSshTabProps) {
  const [details, setDetails] = useState<VmSshDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [resettingPass, setResettingPass] = useState(false);
  const [keyLabel, setKeyLabel] = useState('');
  const [keyPublic, setKeyPublic] = useState('');
  const [addingKey, setAddingKey] = useState(false);

  const loadDetails = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<VmSshDetails>(`/api/incus/instances/${instance.id}/ssh`);
      setDetails(data);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load SSH access details', 'error');
    } finally {
      setLoading(false);
    }
  }, [instance.id, onNotify]);

  useEffect(() => {
    void loadDetails();
  }, [loadDetails]);

  async function handleResetPassword(e: FormEvent) {
    e.preventDefault();
    setResettingPass(true);
    try {
      const res = await apiFetch<{ appliedLive: boolean }>(
        `/api/incus/instances/${instance.id}/ssh/password`,
        {
          method: 'POST',
          body: JSON.stringify({ password: newPassword }),
        }
      );
      setNewPassword('');
      await loadDetails();
      onNotify(
        res.appliedLive
          ? 'Root password reset and applied inside running VPS.'
          : 'Root password updated in panel vault (start VPS to sync).'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to reset root password', 'error');
    } finally {
      setResettingPass(false);
    }
  }

  async function handleAddKey(e: FormEvent) {
    e.preventDefault();
    setAddingKey(true);
    try {
      const res = await apiFetch<{ syncedLive: boolean }>(
        `/api/incus/instances/${instance.id}/ssh/keys`,
        {
          method: 'POST',
          body: JSON.stringify({ label: keyLabel, publicKey: keyPublic }),
        }
      );
      setKeyLabel('');
      setKeyPublic('');
      await loadDetails();
      onNotify(
        res.syncedLive
          ? 'SSH public key added and written to /root/.ssh/authorized_keys.'
          : 'SSH public key saved (will sync into container on next live OS boot).'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to add SSH key', 'error');
    } finally {
      setAddingKey(false);
    }
  }

  async function handleDeleteKey(keyId: number) {
    try {
      await apiFetch(`/api/incus/instances/${instance.id}/ssh/keys/${keyId}`, {
        method: 'DELETE',
      });
      await loadDetails();
      onNotify('SSH public key removed.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to remove SSH key', 'error');
    }
  }

  const hostIp = details?.hostIpv4 || instance.host_ipv4 || '127.0.0.1';
  const sshPort = details?.sshPort || instance.ssh_port || 22;
  const sshCmd = `ssh root@${hostIp} -p ${sshPort}`;

  return (
    <div className="space-y-6">
      {/* SSH Connection Details */}
      <div className="rounded-xl border border-violet-500/20 bg-[#090714]/65 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-violet-500/15 pb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">SSH Connection Details</h3>
            <p className="text-xs text-slate-400">
              OpenSSH is configured on boot with Shared IPv4 NAT forwarding to container port 22.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenConsole}
              className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-600/20 whitespace-nowrap shrink-0"
            >
              <Terminal className="h-3.5 w-3.5" />
              Open Web Console
            </button>
            <button
              type="button"
              onClick={() => void loadDetails()}
              className="rounded-lg border border-violet-500/25 p-1.5 text-slate-300 hover:text-white"
              title="Refresh SSH Details"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2">
            <label className="mb-1 block text-xs text-slate-400">Terminal Connect Command</label>
            <div className="flex items-center gap-2 rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2">
              <code className="flex-1 truncate font-mono text-xs text-cyan-300">{sshCmd}</code>
              <button
                type="button"
                onClick={() => {
                  void copyToClipboard(sshCmd).then((ok) => {
                    onNotify(ok ? 'Copied SSH command.' : 'Clipboard unavailable.', ok ? 'success' : 'error');
                  });
                }}
                className="inline-flex items-center gap-1 rounded border border-violet-500/30 px-2.5 py-1 text-xs text-violet-200 hover:bg-violet-600/20 whitespace-nowrap shrink-0"
              >
                <Copy className="h-3 w-3" />
                Copy
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-slate-400">Shared IPv4 : Port</label>
            <div className="rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 font-mono text-xs text-white tabular-nums">
              {hostIp}:{sshPort}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-slate-400">Root Password</label>
            <div className="flex items-center gap-2 rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2">
              <span className="flex-1 font-mono text-xs text-white">
                {details?.rootPassword
                  ? showPass
                    ? details.rootPassword
                    : '••••••••••••••••'
                  : 'Not stored — set below'}
              </span>
              {details?.rootPassword && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowPass((s) => !s)}
                    className="rounded p-1 text-slate-400 hover:text-white"
                    title={showPass ? 'Hide password' : 'Reveal password'}
                  >
                    {showPass ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void copyToClipboard(details.rootPassword).then((ok) => {
                        onNotify(ok ? 'Copied root password.' : 'Clipboard unavailable.', ok ? 'success' : 'error');
                      });
                    }}
                    className="rounded p-1 text-slate-400 hover:text-white"
                    title="Copy password"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>

          <form onSubmit={handleResetPassword} className="flex items-end gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-xs text-slate-400">Reset Root Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="New root password (min 6 chars)"
                className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 text-xs text-white focus:border-violet-400 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={resettingPass}
              className="cyber-glow-btn rounded-lg px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {resettingPass ? 'Updating...' : 'Reset Password'}
            </button>
          </form>
        </div>
      </div>

      {/* SSH Public Keys Manager */}
      <div className="rounded-xl border border-violet-500/20 bg-[#090714]/65 p-5 space-y-4">
        <div className="flex items-center gap-2 border-b border-violet-500/15 pb-3">
          <KeyRound className="h-4 w-4 text-violet-400" />
          <h3 className="text-sm font-semibold text-white">Authorized SSH Public Keys</h3>
        </div>

        <form onSubmit={handleAddKey} className="grid grid-cols-1 gap-3 sm:grid-cols-12">
          <div className="sm:col-span-3">
            <label className="mb-1 block text-xs text-slate-400">Key Label</label>
            <input
              type="text"
              required
              value={keyLabel}
              onChange={(e) => setKeyLabel(e.target.value)}
              placeholder="MacBook Pro ed25519"
              className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 text-xs text-white"
            />
          </div>
          <div className="sm:col-span-7">
            <label className="mb-1 block text-xs text-slate-400">Public Key (~/.ssh/id_ed25519.pub)</label>
            <input
              type="text"
              required
              value={keyPublic}
              onChange={(e) => setKeyPublic(e.target.value)}
              placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI..."
              className="w-full rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3 py-2 font-mono text-xs text-white"
            />
          </div>
          <div className="flex items-end sm:col-span-2">
            <button
              type="submit"
              disabled={addingKey}
              className="cyber-glow-btn inline-flex w-full items-center justify-center gap-1 rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              {addingKey ? 'Syncing...' : 'Add Key'}
            </button>
          </div>
        </form>

        {!details || details.keys.length === 0 ? (
          <p className="py-5 text-center text-xs text-slate-400">
            No SSH public keys added yet. Password authentication is active by default.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-violet-500/15 text-slate-400">
                  <th className="pb-2 font-medium">Label</th>
                  <th className="pb-2 font-medium">SHA256 Fingerprint</th>
                  <th className="pb-2 font-medium">Added</th>
                  <th className="pb-2 text-right font-medium">Remove</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-violet-500/10">
                {details.keys.map((k) => (
                  <tr key={k.id}>
                    <td className="py-2.5 font-medium text-white">
                      <span className="inline-flex items-center gap-1.5">
                        <Shield className="h-3.5 w-3.5 text-emerald-400" />
                        {k.label}
                      </span>
                    </td>
                    <td className="py-2.5 font-mono text-slate-300">{k.fingerprint}</td>
                    <td className="py-2.5 font-mono text-slate-400 tabular-nums">
                      {new Date(k.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => void handleDeleteKey(k.id)}
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
    </div>
  );
}
