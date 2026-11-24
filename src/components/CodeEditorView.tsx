import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

interface CodeEditorViewProps {
  filename: string;
  initialValue: string;
  onChange: (value: string) => void;
  onSave?: () => void;
}

export function CodeEditorView({
  filename,
  initialValue,
  onChange,
  onSave,
}: CodeEditorViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;

    const lower = filename.toLowerCase();
    const langExt = lower.endsWith('.json')
      ? [json()]
      : lower.endsWith('.yml') || lower.endsWith('.yaml')
      ? [yaml()]
      : [];

    const saveKeymap = keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          onSaveRef.current?.();
          return true;
        },
      },
    ]);

    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        basicSetup,
        oneDark,
        ...langExt,
        saveKeymap,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent,
    });

    return () => {
      view.destroy();
    };
  }, [filename, initialValue]);

  return (
    <div
      ref={hostRef}
      className="h-[420px] w-full overflow-hidden rounded-lg border border-violet-500/25 bg-[#0b0816]"
    />
  );
}
