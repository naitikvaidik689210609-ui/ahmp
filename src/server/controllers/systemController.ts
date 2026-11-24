import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import Docker from 'dockerode';
import { db } from '../db.js';

const execFileAsync = promisify(execFile);

const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
});

let prevCpuInfo: Array<{ idle: number; total: number }> | null = null;
let prevNetSample: { rx: number; tx: number; ts: number } | null = null;

function readCpuTimes(): Array<{ idle: number; total: number }> {
  return os.cpus().map((cpu) => {
    const t = cpu.times;
    const total = t.user + t.nice + t.sys + t.idle + t.irq;
    return { idle: t.idle, total };
  });
}

function computeCpuPercent(): number {
  const current = readCpuTimes();
  if (!prevCpuInfo || prevCpuInfo.length !== current.length) {
    prevCpuInfo = current;
    return 0;
  }

  let idleDiff = 0;
  let totalDiff = 0;
  for (let i = 0; i < current.length; i++) {
    idleDiff += current[i].idle - prevCpuInfo[i].idle;
    totalDiff += current[i].total - prevCpuInfo[i].total;
  }
  prevCpuInfo = current;

  if (totalDiff <= 0) return 0;
  const usage = ((totalDiff - idleDiff) / totalDiff) * 100;
  return Math.max(0, Math.min(100, Number(usage.toFixed(1))));
}

function readMemoryStats(): { totalBytes: number; usedBytes: number; percent: number } {
  const totalBytes = os.totalmem();
  let freeBytes = os.freemem();

  try {
    if (fs.existsSync('/proc/meminfo')) {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const availMatch = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
      if (availMatch) {
        freeBytes = Number(availMatch[1]) * 1024;
      }
    }
  } catch {
    // Fallback to os.freemem()
  }

  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const percent = totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(1)) : 0;
  return { totalBytes, usedBytes, percent };
}

function readDiskStats(): { totalBytes: number; usedBytes: number; percent: number } {
  try {
    const stat = fs.statfsSync('/');
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bavail * stat.bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const percent = totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(1)) : 0;
    return { totalBytes, usedBytes, percent };
  } catch {
    return { totalBytes: 0, usedBytes: 0, percent: 0 };
  }
}

function readNetworkStats(): { rxBytesPerSec: number; txBytesPerSec: number; totalRxBytes: number; totalTxBytes: number } {
  let rx = 0;
  let tx = 0;

  try {
    if (fs.existsSync('/proc/net/dev')) {
      const content = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = content.split('\n').slice(2);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;
        const iface = trimmed.slice(0, colonIdx).trim();
        if (iface === 'lo') continue;
        const parts = trimmed.slice(colonIdx + 1).trim().split(/\s+/);
        if (parts.length >= 9) {
          rx += Number(parts[0]) || 0;
          tx += Number(parts[8]) || 0;
        }
      }
    }
  } catch {
    // Non-Linux or unreadable /proc/net/dev
  }

  const now = Date.now();
  let rxBytesPerSec = 0;
  let txBytesPerSec = 0;

  if (prevNetSample && now > prevNetSample.ts) {
    const dtSec = (now - prevNetSample.ts) / 1000;
    rxBytesPerSec = Math.max(0, Math.round((rx - prevNetSample.rx) / dtSec));
    txBytesPerSec = Math.max(0, Math.round((tx - prevNetSample.tx) / dtSec));
  }

  prevNetSample = { rx, tx, ts: now };
  return { rxBytesPerSec, txBytesPerSec, totalRxBytes: rx, totalTxBytes: tx };
}

export async function checkHostCapabilities(): Promise<{
  dockerAvailable: boolean;
  incusAvailable: boolean;
  hostname: string;
  platform: string;
  arch: string;
  kernel: string;
  cpuCores: number;
}> {
  let dockerAvailable = false;
  let incusAvailable = false;

  try {
    await Promise.race([
      docker.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }

  try {
    await execFileAsync('incus', ['version'], { timeout: 1500 });
    incusAvailable = true;
  } catch {
    incusAvailable = false;
  }

  return {
    dockerAvailable,
    incusAvailable,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    kernel: os.release(),
    cpuCores: os.cpus().length,
  };
}

export interface LiveSystemStats {
  timestamp: number;
  cpuPercent: number;
  cpuCores: number;
  loadAvg: number[];
  memory: {
    totalBytes: number;
    usedBytes: number;
    percent: number;
  };
  disk: {
    totalBytes: number;
    usedBytes: number;
    percent: number;
  };
  network: {
    rxBytesPerSec: number;
    txBytesPerSec: number;
    totalRxBytes: number;
    totalTxBytes: number;
  };
  uptimeSeconds: number;
  counts: {
    minecraftTotal: number;
    minecraftRunning: number;
    vmTotal: number;
    vmRunning: number;
    activeTotal: number;
  };
}

export function collectSystemStats(): LiveSystemStats {
  const cpuPercent = computeCpuPercent();
  const memory = readMemoryStats();
  const disk = readDiskStats();
  const network = readNetworkStats();

  const mcRow = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running FROM minecraft_servers`
    )
    .get() as { total: number; running: number | null };

  const vmRow = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running FROM vm_instances`
    )
    .get() as { total: number; running: number | null };

  const mcRunning = mcRow?.running || 0;
  const vmRunning = vmRow?.running || 0;

  return {
    timestamp: Date.now(),
    cpuPercent,
    cpuCores: os.cpus().length,
    loadAvg: os.loadavg().map((v) => Number(v.toFixed(2))),
    memory,
    disk,
    network,
    uptimeSeconds: Math.floor(os.uptime()),
    counts: {
      minecraftTotal: mcRow?.total || 0,
      minecraftRunning: mcRunning,
      vmTotal: vmRow?.total || 0,
      vmRunning: vmRunning,
      activeTotal: mcRunning + vmRunning,
    },
  };
}
