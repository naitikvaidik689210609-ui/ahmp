import { ArrowDown, ArrowUp, Copy, Cpu, HardDrive, MemoryStick, Network } from 'lucide-react';
import { formatBytes, formatSpeed, formatUptime } from '../../lib/api';
import type { VmInstance, VmTelemetry } from '../../types';
import { type MetricPoint, ResourceChart } from '../ResourceChart';

interface VpsTelemetryPanelProps {
  instance: VmInstance;
  telemetry: VmTelemetry | null;
  history: MetricPoint[];
  onCopy: (text: string, label: string) => void;
}

function CpuRadialGauge({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (clamped / 100) * circumference;
  const strokeColor =
    clamped >= 85 ? '#ef4444' : clamped >= 65 ? '#f59e0b' : '#a855f7';

  return (
    <div className="relative flex h-24 w-24 shrink-0 items-center justify-center">
      <svg className="h-24 w-24 -rotate-90" viewBox="0 0 92 92">
        <circle
          cx="46"
          cy="46"
          r={radius}
          fill="none"
          stroke="rgba(124, 58, 237, 0.16)"
          strokeWidth="8"
        />
        <circle
          cx="46"
          cy="46"
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          className="transition-all duration-500"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="font-mono text-base font-bold text-white tabular-nums">
          {clamped.toFixed(1)}%
        </span>
        <span className="text-[10px] uppercase tracking-wider text-slate-400">CPU</span>
      </div>
    </div>
  );
}

function UsageBar({
  used,
  total,
  color = 'bg-violet-500',
}: {
  used: number;
  total: number;
  color?: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800/90">
      <div
        className={`h-full rounded-full transition-all duration-300 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function VpsTelemetryPanel({
  instance,
  telemetry,
  history,
  onCopy,
}: VpsTelemetryPanelProps) {
  const cpuPct = telemetry?.cpuPercent ?? 0;
  const ramUsed = telemetry?.ramUsedMb ?? 0;
  const ramLimit = telemetry?.ramLimitMb ?? instance.ram_mb;
  const swapUsed = telemetry?.swapUsedMb ?? 0;
  const swapTotal = telemetry?.swapTotalMb ?? 0;
  const diskUsed = telemetry?.diskUsedGb ?? 0;
  const diskTotal = telemetry?.diskTotalGb ?? instance.disk_gb;
  const rxSpeed = telemetry?.netRxBytesPerSec ?? 0;
  const txSpeed = telemetry?.netTxBytesPerSec ?? 0;
  const rxTotal = telemetry?.netTotalRxBytes ?? 0;
  const txTotal = telemetry?.netTotalTxBytes ?? 0;
  const hostIp = telemetry?.hostIpv4 || instance.host_ipv4 || '127.0.0.1';
  const sshPort = telemetry?.sshPort ?? instance.ssh_port ?? null;
  const internalIp = telemetry?.internalIp || instance.ip_address || 'Pending DHCP';

  return (
    <div className="space-y-5">
      {/* System Identity & Shared IPv4 Strip */}
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-violet-500/20 bg-[#090714]/65 p-4 lg:grid-cols-5">
        <div>
          <span className="block text-[11px] text-slate-400">System Uptime</span>
          <span className="mt-1 block font-mono text-xs font-semibold text-white tabular-nums">
            {telemetry?.live ? formatUptime(telemetry.uptimeSeconds) : 'Offline'}
          </span>
        </div>
        <div>
          <span className="block text-[11px] text-slate-400">OS Kernel</span>
          <span className="mt-1 block truncate font-mono text-xs text-slate-200">
            {telemetry?.kernel && telemetry.kernel !== '--' ? telemetry.kernel : instance.os_template}
          </span>
        </div>
        <div>
          <span className="block text-[11px] text-slate-400">Internal IPv4</span>
          <span className="mt-1 block font-mono text-xs text-violet-300 tabular-nums">
            {internalIp}
          </span>
        </div>
        <div className="col-span-2">
          <span className="block text-[11px] text-slate-400">Public Shared IPv4 &amp; SSH Port</span>
          <div className="mt-1 flex items-center gap-2">
            <span className="truncate font-mono text-xs font-semibold text-cyan-300 tabular-nums">
              {sshPort ? `${hostIp}:${sshPort}` : `${hostIp} (Assign SSH NAT)`}
            </span>
            {sshPort && (
              <button
                type="button"
                onClick={() => onCopy(`ssh root@${hostIp} -p ${sshPort}`, 'SSH command')}
                className="inline-flex items-center gap-1 rounded border border-violet-500/30 px-2 py-0.5 text-[11px] text-violet-200 hover:bg-violet-600/20 whitespace-nowrap shrink-0"
              >
                <Copy className="h-3 w-3" />
                Copy SSH
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Live 1.5s Gauges & Resource Bars */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {/* CPU Gauge */}
        <div className="flex items-center gap-4 rounded-xl border border-violet-500/20 bg-[#090714]/65 p-4">
          <CpuRadialGauge percent={cpuPct} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <Cpu className="h-3.5 w-3.5 text-violet-400" />
              <span>vCPU Compute</span>
            </div>
            <p className="font-mono text-sm font-semibold text-white tabular-nums">
              {instance.vcpu} {instance.vcpu === 1 ? 'Core' : 'Cores'}
            </p>
            <p className="text-[11px] text-slate-400">
              {telemetry?.live ? '1.5s WebSocket stream' : 'Instance stopped / offline'}
            </p>
          </div>
        </div>

        {/* RAM & Swap */}
        <div className="space-y-2.5 rounded-xl border border-violet-500/20 bg-[#090714]/65 p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <MemoryStick className="h-3.5 w-3.5 text-cyan-400" />
              RAM &amp; Swap
            </span>
            <span className="font-mono text-xs font-semibold text-white tabular-nums">
              {ramUsed} / {ramLimit} MB
            </span>
          </div>
          <UsageBar used={ramUsed} total={ramLimit} color="bg-cyan-400" />
          <div className="flex items-center justify-between pt-1 text-[11px] text-slate-400">
            <span>Swap Usage</span>
            <span className="font-mono text-slate-300 tabular-nums">
              {swapTotal > 0 ? `${swapUsed} / ${swapTotal} MB` : 'Disabled / 0 MB'}
            </span>
          </div>
          <UsageBar used={swapUsed} total={Math.max(1, swapTotal)} color="bg-violet-400" />
        </div>

        {/* Disk Usage */}
        <div className="space-y-2.5 rounded-xl border border-violet-500/20 bg-[#090714]/65 p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <HardDrive className="h-3.5 w-3.5 text-violet-400" />
              Root Storage
            </span>
            <span className="font-mono text-xs font-semibold text-white tabular-nums">
              {diskUsed.toFixed(1)} / {diskTotal.toFixed(0)} GB
            </span>
          </div>
          <UsageBar used={diskUsed} total={diskTotal} color="bg-violet-500" />
          <div className="flex items-center justify-between pt-1 text-[11px] text-slate-400">
            <span>Virtualization</span>
            <span className="font-mono uppercase text-slate-300">{instance.type}</span>
          </div>
        </div>

        {/* Live Network Traffic */}
        <div className="space-y-2 rounded-xl border border-violet-500/20 bg-[#090714]/65 p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <Network className="h-3.5 w-3.5 text-emerald-400" />
              Network Traffic
            </span>
            <span className="font-mono text-[11px] text-slate-400">eth0</span>
          </div>
          <div className="grid grid-cols-2 gap-2 pt-0.5">
            <div>
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                <ArrowDown className="h-3 w-3 text-emerald-400" />
                Inbound
              </span>
              <p className="font-mono text-xs font-semibold text-emerald-300 tabular-nums">
                {formatSpeed(rxSpeed)}
              </p>
              <p className="font-mono text-[10px] text-slate-400 tabular-nums">
                Total {formatBytes(rxTotal)}
              </p>
            </div>
            <div>
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                <ArrowUp className="h-3 w-3 text-cyan-400" />
                Outbound
              </span>
              <p className="font-mono text-xs font-semibold text-cyan-300 tabular-nums">
                {formatSpeed(txSpeed)}
              </p>
              <p className="font-mono text-[10px] text-slate-400 tabular-nums">
                Total {formatBytes(txTotal)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 10-Minute Chart.js History */}
      <ResourceChart
        title={`${instance.name} Telemetry History (10m · 1.5s Live Stream)`}
        points={history}
        ramLimitMb={instance.ram_mb}
        live={Boolean(telemetry?.live)}
      />
    </div>
  );
}
