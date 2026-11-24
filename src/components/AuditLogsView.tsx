import { RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AuditLog } from '../types';

export function AuditLogsView() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadLogs(searchTerm = query) {
    setLoading(true);
    setError(null);
    try {
      const url = searchTerm
        ? `/api/audit-logs?q=${encodeURIComponent(searchTerm)}`
        : '/api/audit-logs';
      const data = await apiFetch<{ logs: AuditLog[] }>(url);
      setLogs(data.logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit logs.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadLogs('');
  }, []);

  return (
    <div className="cyber-glass rounded-xl p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4 border-b border-violet-500/15 pb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Security & Audit Logs</h2>
          <p className="text-sm text-slate-400">
            Immutable trail of logins, power actions, file edits, and configuration changes
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                void loadLogs(e.target.value);
              }}
              placeholder="Filter user, action, target..."
              className="w-64 rounded-lg border border-violet-500/25 bg-[#090714]/80 py-2 pr-3 pl-9 text-sm text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => void loadLogs(query)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-violet-600/20 whitespace-nowrap shrink-0"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-2 py-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-violet-950/35" />
          ))}
        </div>
      ) : logs.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-400">No matching audit entries found.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-violet-500/15 text-xs text-slate-400">
                <th className="pb-3 font-medium">Timestamp</th>
                <th className="pb-3 font-medium">User</th>
                <th className="pb-3 font-medium">Action</th>
                <th className="pb-3 font-medium">Target</th>
                <th className="pb-3 font-medium">Details</th>
                <th className="pb-3 font-medium text-right">IP Address</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-violet-500/10">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-violet-500/5">
                  <td className="py-2.5 pr-4 font-mono text-xs text-slate-400 tabular-nums whitespace-nowrap">
                    {log.created_at}
                  </td>
                  <td className="py-2.5 pr-4 font-medium text-white whitespace-nowrap">{log.username}</td>
                  <td className="py-2.5 pr-4 font-mono text-xs text-violet-300 whitespace-nowrap">
                    {log.action}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-xs text-slate-300 whitespace-nowrap">
                    {log.target}
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-slate-400">{log.details}</td>
                  <td className="py-2.5 text-right font-mono text-xs text-slate-500 tabular-nums whitespace-nowrap">
                    {log.ip_address || '--'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
