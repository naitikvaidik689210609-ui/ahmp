import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Title,
  Tooltip,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler,
  Legend
);

export interface MetricPoint {
  label: string;
  cpuPercent: number;
  ramUsedMb: number;
}

interface ResourceChartProps {
  title: string;
  points: MetricPoint[];
  ramLimitMb: number;
  live: boolean;
}

export function ResourceChart({ title, points, ramLimitMb, live }: ResourceChartProps) {
  const data = {
    labels: points.map((p) => p.label),
    datasets: [
      {
        label: 'CPU %',
        data: points.map((p) => p.cpuPercent),
        borderColor: '#a855f7',
        backgroundColor: 'rgba(168, 85, 247, 0.14)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
        fill: true,
        yAxisID: 'yCpu',
      },
      {
        label: 'RAM (MB)',
        data: points.map((p) => p.ramUsedMb),
        borderColor: '#38bdf8',
        backgroundColor: 'rgba(56, 189, 248, 0.08)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
        fill: true,
        yAxisID: 'yRam',
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: {
        labels: {
          color: '#cbd5e1',
          boxWidth: 12,
          font: { size: 11, family: '"JetBrains Mono", monospace' },
        },
      },
      tooltip: {
        backgroundColor: '#130f26',
        borderColor: 'rgba(124, 58, 237, 0.45)',
        borderWidth: 1,
      },
    },
    scales: {
      x: {
        ticks: { color: '#64748b', maxTicksLimit: 8, font: { size: 10 } },
        grid: { color: 'rgba(124, 58, 237, 0.08)' },
      },
      yCpu: {
        type: 'linear' as const,
        position: 'left' as const,
        min: 0,
        suggestedMax: 100,
        ticks: { color: '#c084fc', font: { size: 10 } },
        grid: { color: 'rgba(124, 58, 237, 0.1)' },
      },
      yRam: {
        type: 'linear' as const,
        position: 'right' as const,
        min: 0,
        suggestedMax: Math.max(512, ramLimitMb),
        ticks: { color: '#38bdf8', font: { size: 10 } },
        grid: { drawOnChartArea: false },
      },
    },
  };

  return (
    <div className="rounded-xl border border-violet-500/20 bg-[#090714]/70 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold text-white">{title}</span>
        <span className="font-mono text-xs text-slate-400">
          {live ? 'Live 10m telemetry window' : 'Daemon inactive · Waiting for runtime'}
        </span>
      </div>
      <div className="h-52 w-full">
        <Line data={data} options={options} />
      </div>
    </div>
  );
}
