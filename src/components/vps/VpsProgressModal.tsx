import { CheckCircle2, Loader2, Server, X, XCircle } from 'lucide-react';
import type { ProvisionProgressEvent } from '../../types';

interface VpsProgressModalProps {
  title: string;
  event: ProvisionProgressEvent | null;
  onClose: () => void;
}

const DEFAULT_STEPS = [
  'Pulling OS Image (Ubuntu / Debian / AlmaLinux / Alpine)...',
  'Allocating vCPU, RAM & Disk Storage...',
  'Configuring Network & Shared IPv4 NAT Rules...',
  'Setting Root Password & SSH Server...',
  'VPS Online & Ready!',
];

export function VpsProgressModal({ title, event, onClose }: VpsProgressModalProps) {
  if (!event) return null;

  const isDone = event.status === 'done';
  const isError = event.status === 'error';
  const pct = isError ? 100 : Math.min(100, Math.round((event.step / event.totalSteps) * 100));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="cyber-glass w-full max-w-lg rounded-2xl p-6">
        <div className="mb-4 flex items-center justify-between border-b border-violet-500/15 pb-3">
          <div className="flex items-center gap-2.5">
            <Server className="h-5 w-5 text-violet-400" />
            <h3 className="text-base font-semibold text-white">{title}</h3>
          </div>
          {(isDone || isError) && (
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-slate-400 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="mb-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className={isError ? 'font-medium text-red-300' : 'font-medium text-violet-200'}>
              {event.label}
            </span>
            <span className="font-mono text-slate-300 tabular-nums">
              Step {event.step}/{event.totalSteps} · {pct}%
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-900">
            <div
              className={`h-full transition-all duration-300 ${
                isError ? 'bg-red-500' : isDone ? 'bg-emerald-500' : 'bg-violet-500'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <div className="divide-y divide-violet-500/10 rounded-lg border border-violet-500/20 bg-[#090714]/70">
          {DEFAULT_STEPS.map((defaultLabel, idx) => {
            const stepNum = idx + 1;
            const completed = isDone ? stepNum <= event.step : stepNum < event.step;
            const current = !isDone && !isError && stepNum === event.step;
            const failed = isError && stepNum === event.step;
            const displayLabel = stepNum === event.step && event.label ? event.label : defaultLabel;

            return (
              <div key={stepNum} className="flex items-center gap-3 px-3.5 py-2.5 text-xs">
                {failed ? (
                  <XCircle className="h-4 w-4 shrink-0 text-red-400" />
                ) : completed ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                ) : current ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-violet-400" />
                ) : (
                  <span className="inline-block h-4 w-4 shrink-0 rounded-full border border-slate-700" />
                )}
                <span
                  className={
                    failed
                      ? 'text-red-300'
                      : completed
                      ? 'text-slate-200'
                      : current
                      ? 'font-medium text-white'
                      : 'text-slate-500'
                  }
                >
                  {displayLabel}
                </span>
              </div>
            );
          })}
        </div>

        {event.detail && (
          <div
            className={`mt-4 rounded-lg border px-3.5 py-2.5 font-mono text-xs ${
              isError
                ? 'border-red-500/30 bg-red-500/10 text-red-200'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
            }`}
          >
            {event.detail}
          </div>
        )}

        {(isDone || isError) && (
          <div className="mt-5 flex justify-end border-t border-violet-500/15 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="cyber-glow-btn rounded-lg px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0"
            >
              {isError ? 'Dismiss' : 'Continue to VPS Dashboard'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
