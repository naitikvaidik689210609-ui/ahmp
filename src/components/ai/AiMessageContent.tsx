import { Check, Copy } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { copyToClipboard } from '../../lib/api';

interface AiMessageContentProps {
  content: string;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let keyCounter = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      tokens.push(text.slice(lastIdx, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      tokens.push(
        <strong key={`b-${keyCounter++}`} className="font-semibold text-white">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      tokens.push(
        <code
          key={`c-${keyCounter++}`}
          className="rounded border border-violet-500/25 bg-[#090714] px-1.5 py-0.5 font-mono text-[11px] text-cyan-300"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (match[2] && match[3]) {
      tokens.push(
        <a
          key={`a-${keyCounter++}`}
          href={match[3]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan-300 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-200"
        >
          {match[2]}
        </a>
      );
    }
    lastIdx = match.index + token.length;
  }

  if (lastIdx < text.length) {
    tokens.push(text.slice(lastIdx));
  }
  return tokens;
}

function highlightCodeLine(line: string, lang: string, lineIndex: number): ReactNode {
  const trimmed = line.trim();
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('//') ||
    (lang === 'properties' && trimmed.startsWith('!'))
  ) {
    return (
      <span key={lineIndex} className="text-slate-500">
        {line}
      </span>
    );
  }

  if (lang === 'yaml' || lang === 'yml' || lang === 'properties') {
    const sep = lang === 'properties' ? '=' : ':';
    const idx = line.indexOf(sep);
    if (idx > 0) {
      const k = line.slice(0, idx);
      const rest = line.slice(idx);
      return (
        <span key={lineIndex}>
          <span className="text-violet-300">{k}</span>
          <span className="text-slate-400">{rest[0]}</span>
          <span className="text-emerald-300">{rest.slice(1)}</span>
        </span>
      );
    }
  }

  return <span key={lineIndex}>{line}</span>;
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const ok = await copyToClipboard(code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  const lines = code.split('\n');

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-violet-500/25 bg-[#070511]">
      <div className="flex items-center justify-between border-b border-violet-500/15 bg-[#0d0a1a] px-3 py-1.5 text-[11px] text-slate-400">
        <span className="font-mono uppercase">{lang || 'text'}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-slate-300 hover:bg-violet-500/20 hover:text-white whitespace-nowrap shrink-0"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-slate-200">
        <code>
          {lines.map((ln, i) => (
            <span key={i} className="block">
              {highlightCodeLine(ln, lang.toLowerCase(), i)}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export function AiMessageContent({ content }: AiMessageContentProps) {
  const segments = content.split(/(```[\s\S]*?```)/g).filter(Boolean);

  return (
    <div className="space-y-2 text-[13px] leading-relaxed text-slate-200">
      {segments.map((seg, idx) => {
        if (seg.startsWith('```') && seg.endsWith('```')) {
          const inner = seg.slice(3, -3);
          const firstNewline = inner.indexOf('\n');
          const lang = firstNewline >= 0 ? inner.slice(0, firstNewline).trim() : 'text';
          const code = (firstNewline >= 0 ? inner.slice(firstNewline + 1) : inner).replace(/\n$/, '');
          return <CodeBlock key={`code-${idx}`} code={code} lang={lang} />;
        }

        const blocks = seg.split(/\n{2,}/).filter((b) => b.trim() !== '');
        return (
          <div key={`txt-${idx}`} className="space-y-2">
            {blocks.map((block, bIdx) => {
              const lines = block.split('\n');
              const isUl = lines.every((l) => /^\s*[-*]\s+/.test(l));
              const isOl = lines.every((l) => /^\s*\d+\.\s+/.test(l));

              if (isUl) {
                return (
                  <ul key={bIdx} className="list-disc space-y-1 pl-5 text-slate-200">
                    {lines.map((l, lIdx) => (
                      <li key={lIdx}>{renderInlineMarkdown(l.replace(/^\s*[-*]\s+/, ''))}</li>
                    ))}
                  </ul>
                );
              }

              if (isOl) {
                return (
                  <ol key={bIdx} className="list-decimal space-y-1 pl-5 text-slate-200">
                    {lines.map((l, lIdx) => (
                      <li key={lIdx}>{renderInlineMarkdown(l.replace(/^\s*\d+\.\s+/, ''))}</li>
                    ))}
                  </ol>
                );
              }

              return (
                <div key={bIdx} className="space-y-1">
                  {lines.map((line, lIdx) => {
                    if (line.startsWith('### ')) {
                      return (
                        <h4 key={lIdx} className="pt-1 text-xs font-semibold text-violet-200">
                          {renderInlineMarkdown(line.slice(4))}
                        </h4>
                      );
                    }
                    if (line.startsWith('## ') || line.startsWith('# ')) {
                      return (
                        <h3 key={lIdx} className="pt-1 text-sm font-semibold text-white">
                          {renderInlineMarkdown(line.replace(/^#{1,2}\s+/, ''))}
                        </h3>
                      );
                    }
                    return (
                      <p key={lIdx} className="break-words">
                        {renderInlineMarkdown(line)}
                      </p>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
