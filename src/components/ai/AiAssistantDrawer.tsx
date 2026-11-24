import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Eraser,
  Maximize2,
  Minimize2,
  Send,
  ShieldCheck,
  Terminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../lib/api';
import type {
  AiAgentType,
  AiChatMessage,
  AiConfirmationMode,
  AiToolAction,
} from '../../types';
import { AiMessageContent } from './AiMessageContent';

interface AiAssistantDrawerProps {
  open: boolean;
  onClose: () => void;
  agentType: AiAgentType;
  resourceId: number;
  resourceTitle: string;
  resourceSubtitle: string;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onActionExecuted?: () => void;
}

const MC_QUICK_PROMPTS = [
  {
    label: 'Analyze Latest Crash / Console Logs',
    prompt:
      'Analyze the last 100 lines of console logs for errors, crashes, plugin conflicts, or TPS lag spikes and suggest exact fixes.',
    analyzeLogs: true,
    primary: true,
  },
  {
    label: 'Optimize Lag & TPS',
    prompt: 'Review my server software and suggest Paper/Purpur optimizations without breaking farms.',
    analyzeLogs: false,
    primary: false,
  },
  {
    label: 'Best SMP Plugins',
    prompt: 'Recommend essential SMP plugins compatible with my server version and offer to install them.',
    analyzeLogs: false,
    primary: false,
  },
  {
    label: 'Write Custom Sword Skript',
    prompt: 'Write a clean custom lightning sword Skript and offer to save it into plugins/Skript/scripts/.',
    analyzeLogs: false,
    primary: false,
  },
];

const VPS_QUICK_PROMPTS = [
  {
    label: 'Diagnose VPS Health',
    prompt: 'Run a full health check on CPU, RAM, disk space, top processes, and failed services.',
    analyzeLogs: false,
    primary: true,
  },
  {
    label: 'Install Docker + Compose',
    prompt: 'Install Docker Engine and Docker Compose on this VPS.',
    analyzeLogs: false,
    primary: false,
  },
  {
    label: 'Host Node.js Bot 24/7',
    prompt: 'Install Node.js + PM2 and show me how to run my Discord bot 24/7 with auto-restart.',
    analyzeLogs: false,
    primary: false,
  },
  {
    label: 'Expose Port 8080 (NAT)',
    prompt: 'Forward internal port 8080 on my Shared IPv4 address.',
    analyzeLogs: false,
    primary: false,
  },
];

function ActionCard({
  action,
  busy,
  onDecision,
}: {
  action: AiToolAction;
  busy: boolean;
  onDecision?: (decision: 'approve' | 'reject') => void;
}) {
  const [expanded, setExpanded] = useState(action.status === 'executed' && Boolean(action.output));

  const statusTone =
    action.status === 'executed'
      ? 'border-emerald-500/35 bg-emerald-500/10'
      : action.status === 'failed'
      ? 'border-red-500/35 bg-red-500/10'
      : action.status === 'rejected'
      ? 'border-slate-600/40 bg-slate-900/60'
      : action.riskLevel === 'high'
      ? 'border-amber-500/45 bg-amber-500/10'
      : 'border-violet-500/35 bg-violet-500/10';

  const badgeLabel =
    action.status === 'executed'
      ? `✓ ${action.summary || action.title}`
      : action.status === 'failed'
      ? `Failed: ${action.title}`
      : action.status === 'rejected'
      ? `Rejected: ${action.title}`
      : action.title;

  return (
    <div className={`rounded-lg border p-3 text-xs ${statusTone}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-1.5 font-medium text-white">
            {action.status === 'executed' ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            ) : action.status === 'failed' ? (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />
            ) : action.status === 'rejected' ? (
              <X className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            ) : (
              <Wrench className="h-3.5 w-3.5 shrink-0 text-violet-300" />
            )}
            <span className="break-words">{badgeLabel}</span>
          </div>
          <p className="text-[11px] text-slate-300">{action.description}</p>
          {action.status === 'pending' && action.riskLevel === 'high' && (
            <p className="text-[11px] font-medium text-amber-300">
              High-impact action · Explicit confirmation required
            </p>
          )}
          {action.error && <p className="text-[11px] text-red-300">{action.error}</p>}
        </div>

        {(action.output || Object.keys(action.args || {}).length > 0) && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-slate-300 hover:bg-white/10 whitespace-nowrap shrink-0"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {expanded ? 'Hide' : 'Details'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-2 space-y-1.5">
          {Object.keys(action.args || {}).length > 0 && (
            <pre className="max-h-28 overflow-auto rounded bg-[#070511] p-2 font-mono text-[11px] text-violet-200">
              {JSON.stringify(action.args, null, 2)}
            </pre>
          )}
          {action.output && (
            <pre className="max-h-44 overflow-auto rounded bg-[#070511] p-2 font-mono text-[11px] text-emerald-200 whitespace-pre-wrap break-words">
              {action.output}
            </pre>
          )}
        </div>
      )}

      {action.status === 'pending' && onDecision && (
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision('approve')}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/45 bg-emerald-600/25 px-3 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-600/40 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Check className="h-3.5 w-3.5" />
            {busy ? 'Running...' : 'Approve & Run'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision('reject')}
            className="inline-flex items-center gap-1 rounded-md border border-red-500/35 bg-red-500/15 px-3 py-1 text-xs font-medium text-red-200 hover:bg-red-500/25 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <X className="h-3.5 w-3.5" />
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

export function AiAssistantDrawer({
  open,
  onClose,
  agentType,
  resourceId,
  resourceTitle,
  resourceSubtitle,
  onNotify,
  onActionExecuted,
}: AiAssistantDrawerProps) {
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [activeModel, setActiveModel] = useState('gpt-4o-mini');
  const [confirmationMode, setConfirmationMode] = useState<AiConfirmationMode>('ask');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [expandedWidth, setExpandedWidth] = useState(false);

  const scrollBottomRef = useRef<HTMLDivElement | null>(null);

  const loadHistory = useCallback(async () => {
    if (!open || !resourceId) return;
    setLoadingHistory(true);
    try {
      const res = await apiFetch<{
        messages: AiChatMessage[];
        configured: boolean;
        model: string;
      }>(`/api/ai/${agentType}/${resourceId}/history`);
      setMessages(res.messages);
      setConfigured(res.configured);
      setActiveModel(res.model);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load AI chat history', 'error');
    } finally {
      setLoadingHistory(false);
    }
  }, [agentType, onNotify, open, resourceId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, open]);

  useEffect(() => {
    scrollBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  async function sendPrompt(text: string, analyzeLogs = false) {
    const clean = text.trim();
    if (!clean || sending) return;

    setSending(true);
    if (!analyzeLogs) setInput('');
    try {
      const res = await apiFetch<{
        userMessage: AiChatMessage;
        assistantMessage: AiChatMessage;
      }>(`/api/ai/${agentType}/${resourceId}/chat`, {
        method: 'POST',
        body: JSON.stringify({
          message: clean,
          confirmationMode,
          analyzeLogs,
        }),
      });
      setMessages((prev) => [...prev, res.userMessage, res.assistantMessage]);
      if (res.assistantMessage.tool_actions.some((a) => a.status === 'executed')) {
        onActionExecuted?.();
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'AI request failed', 'error');
    } finally {
      setSending(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await sendPrompt(input, false);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendPrompt(input, false);
    }
  }

  async function handleActionDecision(
    messageId: number,
    actionId: string,
    decision: 'approve' | 'reject'
  ) {
    setResolvingId(actionId);
    try {
      const res = await apiFetch<{ message: AiChatMessage }>(
        `/api/ai/${agentType}/${resourceId}/actions/${messageId}/${actionId}`,
        {
          method: 'POST',
          body: JSON.stringify({ decision }),
        }
      );
      setMessages((prev) => prev.map((m) => (m.id === res.message.id ? res.message : m)));
      const acted = res.message.pending_actions.find((a) => a.id === actionId);
      if (acted?.status === 'executed') {
        onNotify(acted.summary || 'Action executed successfully.');
        onActionExecuted?.();
      } else if (acted?.status === 'failed') {
        onNotify(acted.error || 'Action failed.', 'error');
      } else if (acted?.status === 'rejected') {
        onNotify('Action cancelled.');
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to process action', 'error');
    } finally {
      setResolvingId(null);
    }
  }

  async function handleClearChat() {
    try {
      await apiFetch(`/api/ai/${agentType}/${resourceId}/history`, { method: 'DELETE' });
      setMessages([]);
      onNotify('Chat history cleared.');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to clear chat', 'error');
    }
  }

  if (!open) return null;

  const isMc = agentType === 'minecraft';
  const quickPrompts = isMc ? MC_QUICK_PROMPTS : VPS_QUICK_PROMPTS;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-xs"
      onClick={onClose}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        className={`flex h-full w-full flex-col border-l border-violet-500/30 bg-[#0d0a1a] shadow-2xl transition-all duration-200 ${
          expandedWidth ? 'max-w-3xl' : 'max-w-xl'
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-violet-500/20 bg-[#120d26] px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-violet-500/40 bg-violet-600/20 text-violet-300">
                {isMc ? <Bot className="h-4 w-4" /> : <Terminal className="h-4 w-4" />}
              </div>
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-white">
                  {isMc ? 'MC AI Assistant' : 'VPS / VM AI SysAdmin'}
                </h3>
                <p className="truncate text-xs text-slate-400">
                  {resourceTitle} <span aria-hidden="true">·</span> {resourceSubtitle}{' '}
                  <span aria-hidden="true">·</span>{' '}
                  <span className="font-mono text-violet-300">{activeModel}</span>
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void handleClearChat()}
              title="Clear Chat"
              className="inline-flex items-center gap-1 rounded-lg border border-violet-500/25 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-red-500/15 hover:text-red-200 whitespace-nowrap shrink-0"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear Chat
            </button>
            <button
              type="button"
              onClick={() => setExpandedWidth((v) => !v)}
              aria-label={expandedWidth ? 'Compact drawer width' : 'Expand drawer width'}
              className="rounded-lg border border-violet-500/25 p-1.5 text-slate-300 hover:bg-violet-500/15 hover:text-white"
            >
              {expandedWidth ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close AI Assistant"
              className="rounded-lg border border-violet-500/25 p-1.5 text-slate-300 hover:bg-violet-500/15 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Action Confirmation Mode Bar + Quick Actions */}
        <div className="space-y-2.5 border-b border-violet-500/15 bg-[#090714]/80 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs text-slate-400">
              <ShieldCheck className="h-3.5 w-3.5 text-violet-400" />
              Action Confirmation Mode
            </span>
            <div className="inline-flex rounded-lg border border-violet-500/25 bg-[#0d0a1a] p-0.5">
              <button
                type="button"
                onClick={() => setConfirmationMode('ask')}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  confirmationMode === 'ask'
                    ? 'bg-violet-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Ask Before Running
              </button>
              <button
                type="button"
                onClick={() => setConfirmationMode('auto')}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  confirmationMode === 'auto'
                    ? 'bg-cyan-600/80 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Auto-Execute Safe
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {quickPrompts.map((qp) => (
              <button
                key={qp.label}
                type="button"
                disabled={sending || !configured}
                onClick={() => void sendPrompt(qp.prompt, qp.analyzeLogs)}
                className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-45 whitespace-nowrap shrink-0 ${
                  qp.primary
                    ? 'border-cyan-500/40 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25'
                    : 'border-violet-500/25 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20'
                }`}
              >
                {qp.label}
              </button>
            ))}
          </div>
        </div>

        {/* Missing Key Notice */}
        {!configured && (
          <div className="mx-5 mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            OpenAI API key is not configured yet. Ask the Panel Owner to set{' '}
            <code className="font-mono text-white">OPENAI_API_KEY</code> in{' '}
            <strong>Owner Settings</strong> or <code className="font-mono text-white">.env</code>.
          </div>
        )}

        {/* Messages Scroll Area */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {loadingHistory ? (
            <div className="space-y-3 py-4">
              {Array.from({ length: 3 }).map((_, idx) => (
                <div key={idx} className="h-16 animate-pulse rounded-xl bg-violet-950/35" />
              ))}
            </div>
          ) : messages.length === 0 ? (
            <div className="rounded-xl border border-violet-500/20 bg-[#120d26]/65 p-5 text-center">
              <p className="text-sm font-semibold text-white">
                {isMc ? 'Ready to manage your Minecraft Server' : 'Ready to manage your Cloud VPS'}
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                {isMc
                  ? 'Ask in English, Hindi, or Hinglish to diagnose crashes, install Modrinth plugins/mods, tune Paper/Spigot configs, write Skripts, or run console commands.'
                  : 'Ask in English, Hindi, or Hinglish to install Docker/Node/Nginx/MySQL, diagnose CPU/RAM spikes, edit configs, expose Shared IPv4 ports, or troubleshoot services.'}
              </p>
            </div>
          ) : (
            messages.map((msg) => {
              const isUser = msg.role === 'user';
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[92%] rounded-xl border px-4 py-3 ${
                      isUser
                        ? 'border-violet-500/45 bg-violet-600/20 text-white'
                        : 'border-violet-500/20 bg-[#120d26]/85 text-slate-200'
                    }`}
                  >
                    {isUser ? (
                      <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{msg.content}</p>
                    ) : (
                      <div className="space-y-3">
                        <AiMessageContent content={msg.content} />

                        {msg.tool_actions.length > 0 && (
                          <div className="space-y-2 border-t border-violet-500/15 pt-2.5">
                            {msg.tool_actions.map((act) => (
                              <ActionCard key={act.id} action={act} busy={false} />
                            ))}
                          </div>
                        )}

                        {msg.pending_actions.length > 0 && (
                          <div className="space-y-2 border-t border-violet-500/15 pt-2.5">
                            {msg.pending_actions.map((act) => (
                              <ActionCard
                                key={act.id}
                                action={act}
                                busy={resolvingId === act.id}
                                onDecision={(decision) =>
                                  void handleActionDecision(msg.id, act.id, decision)
                                }
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <span className="mt-1 px-1 text-[10px] text-slate-500 tabular-nums">
                    {isUser ? 'You' : isMc ? 'MC AI Assistant' : 'VPS AI SysAdmin'} ·{' '}
                    {msg.created_at}
                  </span>
                </div>
              );
            })
          )}

          {sending && (
            <div className="flex items-start">
              <div className="rounded-xl border border-violet-500/25 bg-[#120d26]/85 px-4 py-3 text-xs text-violet-200">
                Thinking &amp; inspecting live {isMc ? 'server' : 'VPS'} state...
              </div>
            </div>
          )}
          <div ref={scrollBottomRef} />
        </div>

        {/* Chat Input Footer */}
        <form
          onSubmit={handleSubmit}
          className="border-t border-violet-500/20 bg-[#090714] px-5 py-3.5"
        >
          <div className="flex items-end gap-2">
            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!configured || sending}
              placeholder={
                isMc
                  ? 'Ask in English, Hindi, or Hinglish... (e.g. "Install EssentialsX and optimize view-distance")'
                  : 'Ask in English, Hindi, or Hinglish... (e.g. "Install Nginx and forward port 80")'
              }
              className="flex-1 resize-none rounded-lg border border-violet-500/25 bg-[#0d0a1a] px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:border-violet-400 focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!configured || sending || !input.trim()}
              className="cyber-glow-btn inline-flex h-[54px] items-center gap-1.5 rounded-lg px-4 text-xs font-semibold text-white disabled:opacity-45 whitespace-nowrap shrink-0"
            >
              <Send className="h-3.5 w-3.5" />
              Send
            </button>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500">
            <span>Enter to send · Shift+Enter for newline</span>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => void handleClearChat()}
                className="inline-flex items-center gap-1 text-slate-400 hover:text-white"
              >
                <Eraser className="h-3 w-3" />
                Reset conversation
              </button>
            )}
          </div>
        </form>
      </aside>
    </div>
  );
}
