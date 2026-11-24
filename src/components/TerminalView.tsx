import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

interface TerminalViewProps {
  interactive?: boolean;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onReady?: (write: (chunk: string) => void, clear: () => void, getDims?: () => { cols: number; rows: number }) => void;
  className?: string;
}

export function TerminalView({
  interactive = false,
  onData,
  onResize,
  onReady,
  className = 'h-[400px]',
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onReadyRef = useRef(onReady);

  onDataRef.current = onData;
  onResizeRef.current = onResize;
  onReadyRef.current = onReady;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: interactive,
      disableStdin: !interactive,
      convertEol: true,
      scrollback: 3000,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.38,
      theme: {
        background: '#090714',
        foreground: '#e2e8f0',
        cursor: '#a855f7',
        cursorAccent: '#090714',
        selectionBackground: 'rgba(124, 58, 237, 0.35)',
        black: '#1e1b2e',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#f1f5f9',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    try {
      fitAddon.fit();
      onResizeRef.current?.(term.cols, term.rows);
    } catch {
      // Initial mount inside hidden container; ResizeObserver will fit once visible
    }
    const rafId = requestAnimationFrame(() => {
      try {
        fitAddon.fit();
        onResizeRef.current?.(term.cols, term.rows);
      } catch {
        // ignore
      }
    });

    const disposable = term.onData((chunk) => {
      if (interactive) {
        onDataRef.current?.(chunk);
      }
    });

    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        onResizeRef.current?.(term.cols, term.rows);
      } catch {
        // Ignore resize errors during unmount
      }
    });
    observer.observe(el);

    onReadyRef.current?.(
      (chunk: string) => term.write(chunk),
      () => term.clear(),
      () => ({ cols: term.cols, rows: term.rows })
    );

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      disposable.dispose();
      term.dispose();
    };
  }, [interactive]);

  return (
    <div
      ref={containerRef}
      className={`w-full overflow-hidden rounded-lg border border-violet-500/25 bg-[#090714] p-2 ${className}`}
    />
  );
}
