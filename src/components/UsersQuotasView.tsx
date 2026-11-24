import { Ban, CheckCircle, Edit3, LogIn, Plus, Shield, Trash2, Users, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AuthUser, ManagedUser, UserRole } from '../types';

interface UsersQuotasViewProps {
  currentUser: AuthUser;
  onImpersonate: (token: string, user: AuthUser) => void;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export function UsersQuotasView({
  currentUser,
  onImpersonate,
  onNotify,
}: UsersQuotasViewProps) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingUser, setEditingUser] = useState<ManagedUser | null>(null);

  // Create form
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [maxRamMb, setMaxRamMb] = useState(8192);
  const [maxCpuPercent, setMaxCpuPercent] = useState(400);
  const [maxDiskGb, setMaxDiskGb] = useState(50);
  const [maxMcServers, setMaxMcServers] = useState(3);
  const [maxVmInstances, setMaxVmInstances] = useState(2);

  // Edit quota/role form
  const [editRole, setEditRole] = useState<UserRole>('user');
  const [editRam, setEditRam] = useState(8192);
  const [editCpu, setEditCpu] = useState(400);
  const [editDisk, setEditDisk] = useState(50);
  const [editMc, setEditMc] = useState(3);
  const [editVm, setEditVm] = useState(2);

  async function loadUsers() {
    setLoading(true);
    try {
      const res = await apiFetch<{ users: ManagedUser[] }>('/api/users');
      setUsers(res.users);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load users', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  function openEditModal(u: ManagedUser) {
    setEditingUser(u);
    setEditRole(u.role);
    setEditRam(u.max_ram_mb);
    setEditCpu(u.max_cpu_percent);
    setEditDisk(u.max_disk_gb);
    setEditMc(u.max_mc_servers);
    setEditVm(u.max_vm_instances);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username,
          email,
          password,
          role,
          maxRamMb: Number(maxRamMb),
          maxCpuPercent: Number(maxCpuPercent),
          maxDiskGb: Number(maxDiskGb),
          maxMcServers: Number(maxMcServers),
          maxVmInstances: Number(maxVmInstances),
        }),
      });
      setShowCreate(false);
      setUsername('');
      setEmail('');
      setPassword('');
      onNotify(`Created ${role} account '${username}'.`);
      void loadUsers();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create user', 'error');
    }
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editingUser) return;
    try {
      await apiFetch(`/api/users/${editingUser.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          role: editingUser.role === 'owner' ? 'owner' : editRole,
          max_ram_mb: Number(editRam),
          max_cpu_percent: Number(editCpu),
          max_disk_gb: Number(editDisk),
          max_mc_servers: Number(editMc),
          max_vm_instances: Number(editVm),
        }),
      });
      setEditingUser(null);
      onNotify(`Updated permissions & quotas for ${editingUser.username}.`);
      void loadUsers();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update user', 'error');
    }
  }

  async function handleToggleSuspend(u: ManagedUser) {
    try {
      await apiFetch(`/api/users/${u.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_suspended: !u.is_suspended }),
      });
      onNotify(`${u.is_suspended ? 'Unsuspended' : 'Suspended'} ${u.username}.`);
      void loadUsers();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Action failed', 'error');
    }
  }

  async function handleDelete(u: ManagedUser) {
    try {
      await apiFetch(`/api/users/${u.id}`, { method: 'DELETE' });
      onNotify(`Deleted user ${u.username}.`);
      void loadUsers();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  }

  async function handleImpersonate(u: ManagedUser) {
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>(
        `/api/owner/impersonate/${u.id}`,
        { method: 'POST' }
      );
      onImpersonate(res.token, res.user);
      onNotify(`Now viewing panel as ${u.username}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Impersonation failed', 'error');
    }
  }

  return (
    <div className="cyber-glass rounded-xl p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-violet-500/15 pb-4">
        <div className="flex items-center gap-3">
          <Users className="h-5 w-5 text-violet-400" />
          <div>
            <h2 className="text-lg font-semibold text-white">Users, Roles & Resource Quotas</h2>
            <p className="text-sm text-slate-400">
              Manage Owner, Admin, and User plans, resource budgets, and account status
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="cyber-glow-btn inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          Create User
        </button>
      </div>

      {loading ? (
        <div className="space-y-2 py-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-violet-950/35" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                <th className="pb-3 font-medium">Account</th>
                <th className="pb-3 font-medium">Role</th>
                <th className="pb-3 font-medium">RAM Quota</th>
                <th className="pb-3 font-medium">Servers / VMs</th>
                <th className="pb-3 font-medium">State</th>
                <th className="pb-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-violet-500/10">
              {users.map((u) => {
                const canModify =
                  currentUser.role === 'owner' ||
                  (currentUser.role === 'admin' && u.role === 'user');
                return (
                  <tr key={u.id} className="hover:bg-violet-500/5">
                    <td className="py-3 pr-4">
                      <p className="font-semibold text-white">{u.username}</p>
                      <p className="text-xs text-slate-400">{u.email}</p>
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-semibold capitalize ${
                          u.role === 'owner'
                            ? 'text-amber-300'
                            : u.role === 'admin'
                            ? 'text-violet-300'
                            : 'text-slate-300'
                        }`}
                      >
                        <Shield className="h-3.5 w-3.5" />
                        {u.role}
                      </span>
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs text-slate-300 tabular-nums">
                      {u.quota.used.ramMb} / {u.max_ram_mb} MB
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs text-slate-300 tabular-nums">
                      {u.quota.used.mcServers}/{u.max_mc_servers} MC · {u.quota.used.vmInstances}/
                      {u.max_vm_instances} VM
                    </td>
                    <td className="py-3 pr-4 text-xs font-semibold">
                      {u.is_suspended ? (
                        <span className="text-red-400">Suspended</span>
                      ) : (
                        <span className="text-emerald-400">Active</span>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {currentUser.role === 'owner' && u.id !== currentUser.id && (
                          <button
                            type="button"
                            onClick={() => void handleImpersonate(u)}
                            title="Login as User"
                            className="inline-flex items-center gap-1 rounded border border-violet-500/35 px-2.5 py-1 text-xs text-violet-200 hover:bg-violet-600/20 whitespace-nowrap"
                          >
                            <LogIn className="h-3 w-3" />
                            Impersonate
                          </button>
                        )}
                        {canModify && (
                          <button
                            type="button"
                            onClick={() => openEditModal(u)}
                            title="Edit Role & Quota"
                            className="rounded p-1.5 text-slate-300 hover:bg-violet-600/20 hover:text-white"
                          >
                            <Edit3 className="h-4 w-4" />
                          </button>
                        )}
                        {canModify && u.role !== 'owner' && u.id !== currentUser.id && (
                          <button
                            type="button"
                            onClick={() => void handleToggleSuspend(u)}
                            title={u.is_suspended ? 'Unsuspend' : 'Suspend User'}
                            className="rounded p-1.5 text-slate-300 hover:bg-amber-500/15 hover:text-amber-300"
                          >
                            {u.is_suspended ? (
                              <CheckCircle className="h-4 w-4 text-emerald-400" />
                            ) : (
                              <Ban className="h-4 w-4" />
                            )}
                          </button>
                        )}
                        {currentUser.role === 'owner' &&
                          u.role !== 'owner' &&
                          u.id !== currentUser.id && (
                            <button
                              type="button"
                              onClick={() => void handleDelete(u)}
                              title="Delete User"
                              className="rounded p-1.5 text-slate-400 hover:bg-red-500/15 hover:text-red-300"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create User Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-lg rounded-2xl p-6">
            <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
              <h3 className="text-lg font-semibold text-white">Create User Account</h3>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded p-1 text-slate-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-slate-300">Username</label>
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-300">Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-slate-300">Password</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-300">Role</label>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as UserRole)}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3 py-2 text-sm text-white focus:border-violet-400 focus:outline-none"
                  >
                    <option value="user">User (Quota Restricted)</option>
                    {currentUser.role === 'owner' && (
                      <option value="admin">Admin (Node Staff)</option>
                    )}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">RAM (MB)</label>
                  <input
                    type="number"
                    min={512}
                    value={maxRamMb}
                    onChange={(e) => setMaxRamMb(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-2.5 py-1.5 font-mono text-xs text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">CPU (%)</label>
                  <input
                    type="number"
                    min={100}
                    value={maxCpuPercent}
                    onChange={(e) => setMaxCpuPercent(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-2.5 py-1.5 font-mono text-xs text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Disk (GB)</label>
                  <input
                    type="number"
                    min={5}
                    value={maxDiskGb}
                    onChange={(e) => setMaxDiskGb(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-2.5 py-1.5 font-mono text-xs text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Max MC</label>
                  <input
                    type="number"
                    min={0}
                    value={maxMcServers}
                    onChange={(e) => setMaxMcServers(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-2.5 py-1.5 font-mono text-xs text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Max VMs</label>
                  <input
                    type="number"
                    min={0}
                    value={maxVmInstances}
                    onChange={(e) => setMaxVmInstances(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-2.5 py-1.5 font-mono text-xs text-white"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 border-t border-violet-500/15 pt-4">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="rounded-lg border border-violet-500/30 px-4 py-2 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cyber-glow-btn rounded-lg px-5 py-2 text-xs font-semibold text-white"
                >
                  Create Account
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit User Role & Quota Modal */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-md rounded-2xl p-6">
            <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
              <h3 className="text-lg font-semibold text-white">
                Edit Quota & Role · {editingUser.username}
              </h3>
              <button
                type="button"
                onClick={() => setEditingUser(null)}
                className="rounded p-1 text-slate-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4">
              {currentUser.role === 'owner' && editingUser.role !== 'owner' && (
                <div>
                  <label className="mb-1 block text-xs text-slate-300">Account Role</label>
                  <select
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value as UserRole)}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3 py-2 text-sm text-white"
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Max RAM (MB)</label>
                  <input
                    type="number"
                    min={512}
                    value={editRam}
                    onChange={(e) => setEditRam(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3 py-2 font-mono text-sm text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Max CPU (%)</label>
                  <input
                    type="number"
                    min={100}
                    value={editCpu}
                    onChange={(e) => setEditCpu(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3 py-2 font-mono text-sm text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Max Disk (GB)</label>
                  <input
                    type="number"
                    min={5}
                    value={editDisk}
                    onChange={(e) => setEditDisk(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3 py-2 font-mono text-sm text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Max MC Servers</label>
                  <input
                    type="number"
                    min={0}
                    value={editMc}
                    onChange={(e) => setEditMc(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3 py-2 font-mono text-sm text-white"
                  />
                </div>
                <div className="col-span-2">
                  <label className="mb-1 block text-xs text-slate-400">Max LXC / VMs</label>
                  <input
                    type="number"
                    min={0}
                    value={editVm}
                    onChange={(e) => setEditVm(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714]/90 px-3 py-2 font-mono text-sm text-white"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 border-t border-violet-500/15 pt-4">
                <button
                  type="button"
                  onClick={() => setEditingUser(null)}
                  className="rounded-lg border border-violet-500/30 px-4 py-2 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cyber-glow-btn rounded-lg px-5 py-2 text-xs font-semibold text-white"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
