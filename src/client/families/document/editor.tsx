// A document in an editor, over the tab: to insert a new one (or a copy)
// or change one. ⌘S or ⌘Enter saves; the server reads the text as relaxed
// JSON (MongoDB's shell literals too) and says what's wrong with it.

import { useState } from 'react';
import { NodeButton } from '@hyperpane/ui';
import { CodeEditor } from '../../ui/code.tsx';
import { ErrorBox } from '../../ui/parts.tsx';

export interface Editing {
  /** Insert (a new document, or a copy), or replace the one with this key. */
  mode: 'insert' | 'replace';
  text: string;
  key?: Record<string, unknown>;
  title: string;
}

export function DocEditor({ editing, readOnly, onSave, onClose, hint }: { editing: Editing; readOnly: boolean; onSave(text: string): Promise<void>; onClose(): void; hint?: string }) {
  const [text, setText] = useState(editing.text);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (t = text) => {
    if (readOnly || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(t);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-6"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div className="flex h-[min(620px,100%)] w-[min(760px,100%)] flex-col overflow-hidden rounded-lg border border-[var(--node-border)] bg-[var(--node-bg)] shadow-2xl">
        <div className="flex h-9 flex-none items-center gap-2 border-b border-[var(--node-border)] px-3">
          <span className="truncate font-medium">{editing.title}</span>
          {hint && <span className="truncate text-[10.5px] text-[var(--node-muted)]">{hint}</span>}
          <div className="ml-auto flex flex-none gap-1">
            <NodeButton onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</NodeButton>
            {!readOnly && (
              <NodeButton disabled={busy} onClick={() => void save()} className="border-[var(--node-accent)] text-[var(--node-accent)]">
                {busy ? 'Saving…' : editing.mode === 'insert' ? 'Insert' : 'Save'}
              </NodeButton>
            )}
          </div>
        </div>
        {error && <ErrorBox error={error} onClose={() => setError(null)} />}
        <CodeEditor value={text} onChange={setText} language="json" readOnly={readOnly} autoFocus onRun={() => void save()} onSave={() => void save()} className="min-h-0 flex-1" />
      </div>
    </div>
  );
}
