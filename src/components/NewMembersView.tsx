import {
  Ban,
  CheckCircle2,
  Shield,
  SlidersHorizontal,
  Trash2,
  UserCheck,
  UserPlus,
  X,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AuthUser, ManagedUser, UserRole } from '../types';

interface NewMembersViewProps {
  currentUser: AuthUser;
  onPendingCountChange?: (count: number) => void;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export function NewMembersView({
  currentUser,
  onPendingCountChange,
  onNotify,
}: NewMembersViewProps) {
  const [members, setMembers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'active' | 'suspended'>('all');

  // Approve + Assign Starter Quota Modal
  const [approveTarget, setApproveTarget] = useState<ManagedUser | null>(null);
  const [starterRamMb, setStarterRamMb] = useState(8192);
  const [starterCpuPercent, setStarterCpuPercent] = useState(400);
  const [starterDiskGb, setStarterDiskGb] = useState(50);
  const [starterMcServers, setStarterMcServers] = useState(3);
  const [starterVmInstances, setStarterVmInstances] = useState(2);
  const [submitting, setSubmitting] = useState(false);

  const isOwner = currentUser.role === 'owner';

  const loadMembers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ members: ManagedUser[]; pendingCount: number }>(
        '/api/users/new-members'
      );
      setMembers(res.members);
      onPendingCountChange?.(res.pendingCount);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load members list', 'error');
    } finally {
      setLoading(false);
    }
  }, [onNotify, onPendingCountChange]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  const counts = useMemo(() => {
    const pending = members.filter((m) => m.status === 'pending').length;
    const suspended = members.filter(
      (m) => m.status === 'suspended' || m.is_suspended === 1
    ).length;
    const active = members.length - pending - suspended;
    return { pending, active, suspended };
  }, [members]);

  const filteredMembers = useMemo(() => {
    return members.filter((m) => {
      const effectiveStatus = m.status || (m.is_suspended ? 'suspended' : 'active');
      if (filter === 'all') return true;
      return effectiveStatus === filter;
    });
  }, [members, filter]);

  async function handleQuickApprove(member: ManagedUser) {
    try {
      await apiFetch(`/api/users/${member.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      onNotify(`Approved account '${member.username}'.`);
      await loadMembers();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to approve user', 'error');
    }
  }

  function openQuotaModal(member: ManagedUser) {
    setApproveTarget(member);
    setStarterRamMb(member.max_ram_mb || 8192);
    setStarterCpuPercent(member.max_cpu_percent || 400);
    setStarterDiskGb(member.max_disk_gb || 50);
    setStarterMcServers(member.max_mc_servers ?? 3);
    setStarterVmInstances(member.max_vm_instances ?? 2);
  }

  async function handleSubmitQuotaApprove(e: FormEvent) {
    e.preventDefault();
    if (!approveTarget) return;
    setSubmitting(true);
    try {
      if (approveTarget.status === 'pending') {
        await apiFetch(`/api/users/${approveTarget.id}/approve`, {
          method: 'POST',
          body: JSON.stringify({
            max_ram_mb: Number(starterRamMb),
            max_cpu_percent: Number(starterCpuPercent),
            max_disk_gb: Number(starterDiskGb),
            max_mc_servers: Number(starterMcServers),
            max_vm_instances: Number(starterVmInstances),
          }),
        });
        onNotify(`Approved '${approveTarget.username}' with starter resource quota.`);
      } else {
        await apiFetch(`/api/users/${approveTarget.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            max_ram_mb: Number(starterRamMb),
            max_cpu_percent: Number(starterCpuPercent),
            max_disk_gb: Number(starterDiskGb),
            max_mc_servers: Number(starterMcServers),
            max_vm_instances: Number(starterVmInstances),
          }),
        });
        onNotify(`Updated starter quota for '${approveTarget.username}'.`);
      }
      setApproveTarget(null);
      await loadMembers();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update member quota', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleChangeRole(member: ManagedUser, nextRole: UserRole) {
    try {
      await apiFetch(`/api/users/${member.id}`, {
        method: 'PUT',
        body: JSON.stringify({ role: nextRole }),
      });
      onNotify(`Changed role of '${member.username}' to ${nextRole}.`);
      await loadMembers();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to change role', 'error');
    }
  }

  async function handleToggleSuspend(member: ManagedUser) {
    const currentlySuspended = member.status === 'suspended' || member.is_suspended === 1;
    try {
      await apiFetch(`/api/users/${member.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_suspended: !currentlySuspended }),
      });
      onNotify(
        currentlySuspended
          ? `Re-activated '${member.username}'.`
          : `Suspended '${member.username}'.`
      );
      await loadMembers();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update suspension status', 'error');
    }
  }

  async function handleRejectDelete(member: ManagedUser) {
    try {
      await apiFetch(`/api/users/${member.id}/reject`, { method: 'POST' });
      onNotify(`Rejected and removed '${member.username}'.`);
      await loadMembers();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to reject member', 'error');
    }
  }

  return (
    <div className="space-y-6">
      {/* KPI Summary */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="cyber-glass rounded-xl p-4">
          <p className="text-xs text-slate-400">Pending Approvals</p>
          <p className="mt-1 font-mono text-2xl font-bold text-amber-300 tabular-nums">
            {counts.pending}
          </p>
          <p className="mt-1 text-xs text-slate-400">Awaiting Owner/Admin activation</p>
        </div>

        <div className="cyber-glass rounded-xl p-4">
          <p className="text-xs text-slate-400">Active Members</p>
          <p className="mt-1 font-mono text-2xl font-bold text-emerald-300 tabular-nums">
            {counts.active}
          </p>
          <p className="mt-1 text-xs text-slate-400">Approved &amp; active accounts</p>
        </div>

        <div className="cyber-glass rounded-xl p-4">
          <p className="text-xs text-slate-400">Suspended Accounts</p>
          <p className="mt-1 font-mono text-2xl font-bold text-red-300 tabular-nums">
            {counts.suspended}
          </p>
          <p className="mt-1 text-xs text-slate-400">Blocked from login &amp; API tokens</p>
        </div>
      </div>

      {/* Member Queue Table */}
      <div className="cyber-glass rounded-xl p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-violet-500/15 pb-4">
          <div className="flex items-center gap-2.5">
            <UserPlus className="h-5 w-5 text-violet-400" />
            <div>
              <h2 className="text-base font-semibold text-white">New Members &amp; Approvals</h2>
              <p className="text-xs text-slate-400">
                Sorted with pending approvals first, then newest signups
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-[#090714]/80 p-1">
            {(
              [
                ['all', `All (${members.length})`],
                ['pending', `Pending (${counts.pending})`],
                ['active', `Active (${counts.active})`],
                ['suspended', `Suspended (${counts.suspended})`],
              ] as const
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={`rounded-md px-3 py-1 text-xs font-medium whitespace-nowrap ${
                  filter === k ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="space-y-2 py-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-violet-950/35" />
            ))}
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-400">
            No accounts match the selected filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                  <th className="pb-2.5 font-medium">Member</th>
                  <th className="pb-2.5 font-medium">Registration IP</th>
                  <th className="pb-2.5 font-medium">Signed Up</th>
                  <th className="pb-2.5 font-medium">Status</th>
                  <th className="pb-2.5 font-medium">Role</th>
                  <th className="pb-2.5 font-medium">Starter Quota</th>
                  <th className="pb-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-violet-500/10">
                {filteredMembers.map((m) => {
                  const effStatus = m.status || (m.is_suspended ? 'suspended' : 'active');
                  const isTargetOwner = m.role === 'owner';
                  const isSelf = m.id === currentUser.id;
                  const canModify =
                    !isTargetOwner && !isSelf && (isOwner || m.role === 'user');

                  return (
                    <tr key={m.id} className="hover:bg-violet-500/5">
                      <td className="py-3 pr-3">
                        <p className="text-xs font-semibold text-white">{m.username}</p>
                        <p className="text-xs text-slate-400">{m.email}</p>
                      </td>
                      <td className="py-3 pr-3 font-mono text-xs text-slate-300">
                        {m.registration_ip || 'CLI / Admin'}
                      </td>
                      <td className="py-3 pr-3 font-mono text-xs text-slate-400 tabular-nums">
                        {m.created_at ? new Date(m.created_at).toLocaleString() : '--'}
                      </td>
                      <td className="py-3 pr-3">
                        <span
                          className={`text-xs font-semibold capitalize ${
                            effStatus === 'pending'
                              ? 'text-amber-300'
                              : effStatus === 'suspended'
                              ? 'text-red-400'
                              : 'text-emerald-400'
                          }`}
                        >
                          {effStatus}
                        </span>
                      </td>
                      <td className="py-3 pr-3">
                        {isOwner && !isTargetOwner && !isSelf ? (
                          <select
                            value={m.role}
                            onChange={(e) => void handleChangeRole(m, e.target.value as UserRole)}
                            className="rounded border border-violet-500/25 bg-[#090714] px-2 py-1 text-xs text-white capitalize"
                          >
                            <option value="user">user</option>
                            <option value="admin">admin</option>
                          </select>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs capitalize text-slate-300">
                            {m.role === 'owner' && <Shield className="h-3 w-3 text-violet-400" />}
                            {m.role}
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-3 font-mono text-xs text-slate-300 tabular-nums">
                        {m.max_ram_mb}MB · {m.max_mc_servers}MC / {m.max_vm_instances}VM
                      </td>
                      <td className="py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          {effStatus === 'pending' && (
                            <button
                              type="button"
                              onClick={() => void handleQuickApprove(m)}
                              className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 whitespace-nowrap shrink-0"
                            >
                              <UserCheck className="h-3 w-3" />
                              Approve
                            </button>
                          )}

                          {canModify && (
                            <button
                              type="button"
                              onClick={() => openQuotaModal(m)}
                              title={
                                effStatus === 'pending'
                                  ? 'Approve with Custom Starter Plan'
                                  : 'Assign Starter Plan / Quota'
                              }
                              className="inline-flex items-center gap-1 rounded border border-violet-500/35 bg-violet-600/15 px-2.5 py-1 text-xs font-medium text-violet-200 hover:bg-violet-600/30 whitespace-nowrap shrink-0"
                            >
                              <SlidersHorizontal className="h-3 w-3" />
                              {effStatus === 'pending' ? 'Approve + Quota' : 'Quota'}
                            </button>
                          )}

                          {canModify && effStatus !== 'pending' && (
                            <button
                              type="button"
                              onClick={() => void handleToggleSuspend(m)}
                              title={effStatus === 'suspended' ? 'Unsuspend' : 'Suspend'}
                              className="rounded border border-amber-500/35 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/20 whitespace-nowrap shrink-0"
                            >
                              {effStatus === 'suspended' ? (
                                <span className="inline-flex items-center gap-1">
                                  <CheckCircle2 className="h-3 w-3" />
                                  Activate
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1">
                                  <Ban className="h-3 w-3" />
                                  Suspend
                                </span>
                              )}
                            </button>
                          )}

                          {canModify && (
                            <button
                              type="button"
                              onClick={() => void handleRejectDelete(m)}
                              title={effStatus === 'pending' ? 'Reject & Delete' : 'Delete Account'}
                              className="rounded p-1 text-slate-400 hover:bg-red-500/15 hover:text-red-300"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
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
      </div>

      {/* Approve / Assign Starter Plan Modal */}
      {approveTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="cyber-glass w-full max-w-md rounded-2xl p-6">
            <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
              <div>
                <h3 className="text-base font-semibold text-white">
                  {approveTarget.status === 'pending'
                    ? `Approve & Assign Starter Plan`
                    : `Update Starter Plan Quota`}
                </h3>
                <p className="text-xs text-slate-400">
                  Member: {approveTarget.username} ({approveTarget.email})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setApproveTarget(null)}
                className="rounded p-1 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmitQuotaApprove} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-slate-300">Max RAM (MB)</label>
                  <input
                    type="number"
                    min={512}
                    step={256}
                    value={starterRamMb}
                    onChange={(e) => setStarterRamMb(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 font-mono text-sm text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-300">Max CPU (%)</label>
                  <input
                    type="number"
                    min={100}
                    step={50}
                    value={starterCpuPercent}
                    onChange={(e) => setStarterCpuPercent(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 font-mono text-sm text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-300">Max Disk (GB)</label>
                  <input
                    type="number"
                    min={5}
                    value={starterDiskGb}
                    onChange={(e) => setStarterDiskGb(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 font-mono text-sm text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-300">Max Minecraft Servers</label>
                  <input
                    type="number"
                    min={0}
                    value={starterMcServers}
                    onChange={(e) => setStarterMcServers(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 font-mono text-sm text-white"
                  />
                </div>
                <div className="col-span-2">
                  <label className="mb-1 block text-xs text-slate-300">Max LXC / KVM VMs</label>
                  <input
                    type="number"
                    min={0}
                    value={starterVmInstances}
                    onChange={(e) => setStarterVmInstances(Number(e.target.value))}
                    className="w-full rounded-lg border border-violet-500/25 bg-[#090714] px-3 py-2 font-mono text-sm text-white"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 border-t border-violet-500/15 pt-4">
                <button
                  type="button"
                  onClick={() => setApproveTarget(null)}
                  className="rounded-lg border border-violet-500/30 px-4 py-2 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="cyber-glow-btn rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {submitting
                    ? 'Saving...'
                    : approveTarget.status === 'pending'
                    ? 'Approve & Save Quota'
                    : 'Save Quota'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
