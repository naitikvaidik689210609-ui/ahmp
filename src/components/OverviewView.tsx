import {
  Activity,
  AlertTriangle,
  Box,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  Network,
  Server,
  TerminalSquare,
} from 'lucide-react';
import { formatBytes, formatSpeed, formatUptime } from '../lib/api';
import type {
  AuthUser,
  HostCapabilities,
  LiveSystemStats,
  MinecraftServer,
  UserQuotaSummary,
  VmInstance,
} from '../types';

interface OverviewViewProps {
  user: AuthUser;
  quota: UserQuotaSummary | null;
  vpsRebootWarning: string;
  stats: LiveSystemStats | null;
  history: LiveSystemStats[];
  capabilities: HostCapabilities | null;
  servers: MinecraftServer[];
  instances: VmInstance[];
  onNavigate: (tab: 'minecraft' | 'incus', itemId?: number) => void;
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) {
    return <div className="h-10 w-full rounded bg-violet-950/30" />;
  }
  const width = 200;
  const height = 40;
  const max = Math.max(100, ...values);
  const points = values
    .map((v, idx) => {
      const x = (idx / (values.length - 1)) * width;
      const y = height - (Math.min(max, Math.max(0, v)) / max) * (height - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-10 w-full overflow-visible">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

function QuotaBar({
  label,
  usedText,
  percent,
}: {
  label: string;
  usedText: string;
  percent: number;
}) {
  const clamped = Math.min(100, Math.max(0, percent));
  const barColor =
    clamped >= 90 ? 'bg-red-500' : clamped >= 75 ? 'bg-amber-500' : 'bg-violet-500';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono text-slate-200 tabular-nums">{usedText}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800/80">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

export function OverviewView({
  user,
  quota,
  vpsRebootWarning,
  stats,
  history,
  capabilities,
  servers,
  instances,
  onNavigate,
}: OverviewViewProps) {
  const cpuSeries = history.map((h) => h.cpuPercent);
  const ramSeries = history.map((h) => h.memory.percent);

  return (
    <div className="space-y-6">
      {vpsRebootWarning && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-5 py-3.5 text-sm text-amber-200">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
          <div>
            <span className="font-semibold">Scheduled Host Notice: </span>
            <span>{vpsRebootWarning}</span>
          </div>
        </div>
      )}

      {/* Host Hardware & Runtime Summary */}
      <div className="cyber-glass rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">
              Host Telemetry {capabilities ? `· ${capabilities.hostname}` : ''}
            </h2>
            <p className="mt-0.5 text-sm text-slate-400">
              {capabilities
                ? `${capabilities.platform} · ${capabilities.arch} · ${capabilities.cpuCores} vCPU Cores`
                : 'Streaming live host resource telemetry every 2 seconds'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-6 text-xs">
            <div className="flex items-center gap-2">
              <Box className="h-4 w-4 text-violet-400" />
              <span className="text-slate-400">Docker Engine:</span>
              <span
                className={
                  capabilities?.dockerAvailable ? 'font-semibold text-emerald-400' : 'font-semibold text-amber-400'
                }
              >
                {capabilities?.dockerAvailable ? 'Connected' : 'Socket Unavailable'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-violet-400" />
              <span className="text-slate-400">Incus Daemon:</span>
              <span
                className={
                  capabilities?.incusAvailable ? 'font-semibold text-emerald-400' : 'font-semibold text-amber-400'
                }
              >
                {capabilities?.incusAvailable ? 'Connected' : 'CLI Unavailable'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-violet-400" />
              <span className="text-slate-400">Uptime:</span>
              <span className="font-mono font-semibold text-slate-200 tabular-nums">
                {stats ? formatUptime(stats.uptimeSeconds) : '--'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 4 Primary Resource Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="cyber-glass rounded-xl p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">CPU Utilization</span>
            <Cpu className="h-4 w-4 text-violet-400" />
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-semibold text-white tabular-nums">
              {stats ? `${stats.cpuPercent.toFixed(1)}%` : '--'}
            </span>
            <span className="font-mono text-xs text-slate-400 tabular-nums">
              Load {stats ? stats.loadAvg.join(' / ') : '--'}
            </span>
          </div>
          <div className="mt-3">
            <Sparkline values={cpuSeries} color="#a855f7" />
          </div>
        </div>

        <div className="cyber-glass rounded-xl p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Memory Usage</span>
            <MemoryStick className="h-4 w-4 text-violet-400" />
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-semibold text-white tabular-nums">
              {stats ? `${stats.memory.percent.toFixed(1)}%` : '--'}
            </span>
            <span className="font-mono text-xs text-slate-400 tabular-nums">
              {stats
                ? `${formatBytes(stats.memory.usedBytes)} / ${formatBytes(stats.memory.totalBytes)}`
                : '--'}
            </span>
          </div>
          <div className="mt-3">
            <Sparkline values={ramSeries} color="#38bdf8" />
          </div>
        </div>

        <div className="cyber-glass rounded-xl p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Root Filesystem</span>
            <HardDrive className="h-4 w-4 text-violet-400" />
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-semibold text-white tabular-nums">
              {stats ? `${stats.disk.percent.toFixed(1)}%` : '--'}
            </span>
            <span className="font-mono text-xs text-slate-400 tabular-nums">
              {stats
                ? `${formatBytes(stats.disk.usedBytes)} / ${formatBytes(stats.disk.totalBytes)}`
                : '--'}
            </span>
          </div>
          <div className="mt-5 h-2 w-full overflow-hidden rounded-full bg-slate-800/80">
            <div
              className="h-full rounded-full bg-violet-500 transition-all duration-300"
              style={{ width: `${Math.min(100, stats?.disk.percent || 0)}%` }}
            />
          </div>
        </div>

        <div className="cyber-glass rounded-xl p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">Network I/O & Active Nodes</span>
            <Network className="h-4 w-4 text-violet-400" />
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-semibold text-white tabular-nums">
              {stats ? `${stats.counts.activeTotal}` : '0'}
            </span>
            <span className="text-xs text-slate-400">
              {stats
                ? `${stats.counts.minecraftRunning}/${stats.counts.minecraftTotal} MC · ${stats.counts.vmRunning}/${stats.counts.vmTotal} VM`
                : '--'}
            </span>
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-violet-500/15 pt-2.5 font-mono text-xs text-slate-300 tabular-nums">
            <span>RX {stats ? formatSpeed(stats.network.rxBytesPerSec) : '0 KB/s'}</span>
            <span>TX {stats ? formatSpeed(stats.network.txBytesPerSec) : '0 KB/s'}</span>
          </div>
        </div>
      </div>

      {/* Your Resource Quota Card */}
      {quota && (
        <div className="cyber-glass rounded-xl p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-violet-500/15 pb-3">
            <div className="flex items-center gap-2.5">
              <Gauge className="h-5 w-5 text-violet-400" />
              <div>
                <h3 className="text-base font-semibold text-white">Your Resource Quota</h3>
                <p className="text-xs text-slate-400">
                  Account role: <span className="capitalize text-violet-300">{user.role}</span>
                  {user.role !== 'user' ? ' · Unlimited host provisioning enabled for staff' : ''}
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-5">
            <QuotaBar
              label="RAM Allocated"
              usedText={`${(quota.used.ramMb / 1024).toFixed(1)} GB / ${(quota.limits.maxRamMb / 1024).toFixed(1)} GB`}
              percent={(quota.used.ramMb / Math.max(1, quota.limits.maxRamMb)) * 100}
            />
            <QuotaBar
              label="CPU Budget"
              usedText={`${quota.used.cpuPercent}% / ${quota.limits.maxCpuPercent}%`}
              percent={(quota.used.cpuPercent / Math.max(1, quota.limits.maxCpuPercent)) * 100}
            />
            <QuotaBar
              label="Disk Storage"
              usedText={`${quota.used.diskGb} GB / ${quota.limits.maxDiskGb} GB`}
              percent={(quota.used.diskGb / Math.max(1, quota.limits.maxDiskGb)) * 100}
            />
            <QuotaBar
              label="Minecraft Servers"
              usedText={`${quota.used.mcServers} / ${quota.limits.maxMcServers}`}
              percent={(quota.used.mcServers / Math.max(1, quota.limits.maxMcServers)) * 100}
            />
            <QuotaBar
              label="LXC / VM Instances"
              usedText={`${quota.used.vmInstances} / ${quota.limits.maxVmInstances}`}
              percent={(quota.used.vmInstances / Math.max(1, quota.limits.maxVmInstances)) * 100}
            />
          </div>
        </div>
      )}

      {/* Active Workloads Split Tables */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="cyber-glass rounded-xl p-5">
          <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
            <div>
              <h3 className="text-base font-semibold text-white">Minecraft Servers</h3>
              <p className="text-xs text-slate-400">Docker containers powered by itzg/minecraft-server</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('minecraft')}
              className="rounded-lg border border-violet-500/30 px-3 py-1.5 text-xs font-medium text-violet-300 transition-colors hover:bg-violet-600/20 whitespace-nowrap shrink-0"
            >
              Manage All
            </button>
          </div>

          {servers.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-slate-400">No Minecraft servers deployed yet.</p>
              <button
                type="button"
                onClick={() => onNavigate('minecraft')}
                className="cyber-glow-btn mt-3 rounded-lg px-4 py-2 text-xs font-semibold text-white"
              >
                Deploy Minecraft Server
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                    <th className="pb-2.5 font-medium">Server</th>
                    <th className="pb-2.5 font-medium">Runtime</th>
                    <th className="pb-2.5 font-medium text-right">Port</th>
                    <th className="pb-2.5 font-medium text-right">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-violet-500/10">
                  {servers.slice(0, 6).map((srv) => (
                    <tr
                      key={srv.id}
                      onClick={() => onNavigate('minecraft', srv.id)}
                      className="cursor-pointer transition-colors hover:bg-violet-500/10"
                    >
                      <td className="py-2.5 font-medium text-white">{srv.name}</td>
                      <td className="py-2.5 text-xs text-slate-400">
                        {srv.software} · {srv.version}
                      </td>
                      <td className="py-2.5 text-right font-mono text-xs text-slate-300 tabular-nums">
                        {srv.port}
                      </td>
                      <td
                        className={`py-2.5 text-right text-xs font-semibold ${
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
                          ? 'Running'
                          : 'Stopped'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="cyber-glass rounded-xl p-5">
          <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
            <div>
              <h3 className="text-base font-semibold text-white">VMs & LXC Containers</h3>
              <p className="text-xs text-slate-400">Incus Linux containers and KVM virtual machines</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('incus')}
              className="rounded-lg border border-violet-500/30 px-3 py-1.5 text-xs font-medium text-violet-300 transition-colors hover:bg-violet-600/20 whitespace-nowrap shrink-0"
            >
              Manage All
            </button>
          </div>

          {instances.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-slate-400">No LXC containers or KVM VMs launched yet.</p>
              <button
                type="button"
                onClick={() => onNavigate('incus')}
                className="cyber-glow-btn mt-3 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white"
              >
                <TerminalSquare className="h-3.5 w-3.5" />
                Launch Instance
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                    <th className="pb-2.5 font-medium">Instance</th>
                    <th className="pb-2.5 font-medium">OS / Type</th>
                    <th className="pb-2.5 font-medium text-right">Resources</th>
                    <th className="pb-2.5 font-medium text-right">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-violet-500/10">
                  {instances.slice(0, 6).map((inst) => (
                    <tr
                      key={inst.id}
                      onClick={() => onNavigate('incus', inst.id)}
                      className="cursor-pointer transition-colors hover:bg-violet-500/10"
                    >
                      <td className="py-2.5 font-medium text-white">{inst.name}</td>
                      <td className="py-2.5 text-xs text-slate-400">
                        {inst.os_template} · {inst.type.toUpperCase()}
                      </td>
                      <td className="py-2.5 text-right font-mono text-xs text-slate-300 tabular-nums">
                        {inst.vcpu}c / {inst.ram_mb}MB
                      </td>
                      <td
                        className={`py-2.5 text-right text-xs font-semibold ${
                          inst.is_suspended
                            ? 'text-red-400'
                            : inst.status === 'running'
                            ? 'text-emerald-400'
                            : 'text-slate-400'
                        }`}
                      >
                        {inst.is_suspended
                          ? 'Suspended'
                          : inst.status === 'running'
                          ? 'Running'
                          : 'Stopped'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
