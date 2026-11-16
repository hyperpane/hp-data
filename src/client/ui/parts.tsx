// Small parts every view uses that are Data’s own: a kind’s tile, an
// error, a value viewer, counts and durations in words. (Toolbars, status
// bars, splits, tabs and pickers are the kit’s.)

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { NodeButton, cn } from '@hyperpane/ui';
import type { Kind } from '../../shared/kinds.ts';
import type { Cell } from '../../shared/types.ts';
import { editable, formatSize, isBytes } from './cells.ts';

/** A kind's monogram on its color: the tile on cards, in the tree. */
export function KindTile({ kind, size = 28, className }: { kind: Pick<Kind, 'color' | 'glyph' | 'name'>; size?: number; className?: string }) {
  const light = isLight(kind.color);
  return (
    <span
      aria-hidden
      className={cn('inline-flex flex-none items-center justify-center font-semibold tracking-tight', className)}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.26),
        fontSize: Math.round(size * 0.42),
        background: `linear-gradient(135deg, ${kind.color}, color-mix(in srgb, ${kind.color} 72%, #000))`,
        color: light ? '#111' : '#fff',
        boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.14)',
      }}
    >
      {kind.glyph}
    </span>
  );
}

function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}

export function ErrorBox({ error, onClose, className }: { error: string; onClose?(): void; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 border-l-2 border-[#f85149] bg-[color-mix(in_srgb,#f85149_10%,transparent)] px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-[var(--node-fg)] select-text',
        className,
      )}
    >
      <span className="min-w-0 flex-1">{error}</span>
      {onClose && (
        <button type="button" aria-label="Dismiss" className="text-[var(--node-muted)] hover:text-[var(--node-fg)]" onClick={onClose}>
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** A cell's whole value, over the view: text, pretty JSON, or bytes. */
export function ValueViewer({
  title,
  value,
  onClose,
  copy,
  onSave,
}: {
  title: string;
  value: Cell;
  onClose(): void;
  copy(text: string, what?: string): void;
  onSave?(text: string): void;
}) {
  const text = value === null ? '' : editable(value);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-6" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-full w-[min(720px,100%)] flex-col overflow-hidden rounded-lg border border-[var(--node-border)] bg-[var(--node-bg)] shadow-2xl">
        <div className="flex h-9 flex-none items-center gap-2 border-b border-[var(--node-border)] px-3">
          <span className="truncate font-medium">{title}</span>
          <span className="text-[10.5px] text-[var(--node-muted)]">
            {value === null ? 'NULL' : isBytes(value) ? formatSize(value.size) : `${text.length.toLocaleString()} characters`}
          </span>
          <div className="ml-auto flex gap-1">
            <NodeButton onClick={() => copy(draft, 'the value')}>Copy</NodeButton>
            {onSave && (
              <NodeButton
                disabled={draft === text}
                onClick={() => {
                  onSave(draft);
                  onClose();
                }}
              >
                Apply
              </NodeButton>
            )}
            <NodeButton onClick={onClose}>Close</NodeButton>
          </div>
        </div>
        <textarea
          spellCheck={false}
          readOnly={!onSave}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
          className="min-h-[240px] flex-1 resize-none bg-transparent p-3 font-mono text-[12px] text-[var(--node-fg)] outline-none"
        />
      </div>
    </div>
  );
}

/** A count in words: "1 row", "3 rows". */
export const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** ms in a few characters: "84 ms", "1.2 s". */
export const ms = (n: number) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`);
