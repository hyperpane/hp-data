// Small parts every view uses that are Data’s own: a kind’s tile, an
// error, a value viewer, counts and durations in words. (Toolbars, status
// bars, splits, tabs and pickers are the kit’s.)

import { useEffect, useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import { NodeButton, ToolButton, cn } from '@hyperpane/ui';
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
        background: kind.color,
        color: light ? '#111' : '#fff',
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

/** A field's soft fill, as the kit's NodeInput has it: for a Picker or a
 * text area beside the kit's fields. */
export const softField =
  'border-transparent bg-[color-mix(in_srgb,var(--node-fg)_6%,transparent)] hover:border-transparent hover:bg-[color-mix(in_srgb,var(--node-fg)_9%,transparent)]';

/** A text area for code (statements, a key, JSON) with the field's look. */
export const codeArea =
  'rounded-control border border-transparent bg-[color-mix(in_srgb,var(--node-fg)_6%,transparent)] px-2 py-1.5 font-mono text-xs text-[var(--node-fg)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--node-muted)] hover:bg-[color-mix(in_srgb,var(--node-fg)_9%,transparent)] focus:border-[var(--node-accent)] focus:bg-transparent focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--node-accent)_22%,transparent)]';

/** What failed, along the top of a view: a quiet red band, one line under it. */
export function ErrorBox({ error, onClose, className }: { error: string; onClose?(): void; className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-none items-start gap-2 border-b border-[var(--node-border)] bg-[color-mix(in_srgb,var(--ansi-1)_8%,transparent)] px-2.5 py-1.5 text-xs whitespace-pre-wrap text-[var(--node-fg)] select-text',
        className,
      )}
    >
      <TriangleAlert className="mt-[7px] size-3.5 flex-none text-[var(--ansi-1)]" />
      <span className="min-w-0 flex-1 py-1.5 leading-4">{error}</span>
      {onClose && <ToolButton label="Dismiss" icon={X} onClick={onClose} />}
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
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-6 max-sm:p-3"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="rounded-surface flex max-h-full w-[min(720px,100%)] flex-col overflow-hidden border border-[var(--node-border)] bg-[var(--node-bg)]">
        <div className="flex h-10 flex-none items-center gap-2 border-b border-[var(--node-border)] ps-3 pe-2.5">
          <span className="truncate font-medium">{title}</span>
          <span className="flex-none text-2xs text-[var(--node-muted)]">
            {value === null ? 'NULL' : isBytes(value) ? formatSize(value.size) : `${text.length.toLocaleString()} characters`}
          </span>
          <div className="ms-auto flex flex-none gap-1">
            <NodeButton variant="ghost" onClick={() => copy(draft, 'the value')}>
              Copy
            </NodeButton>
            <NodeButton variant={onSave ? 'ghost' : 'default'} onClick={onClose}>
              Close
            </NodeButton>
            {onSave && (
              <NodeButton
                variant="primary"
                disabled={draft === text}
                onClick={() => {
                  onSave(draft);
                  onClose();
                }}
              >
                Apply
              </NodeButton>
            )}
          </div>
        </div>
        <textarea
          spellCheck={false}
          readOnly={!onSave}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
          className="min-h-[240px] flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-5 text-[var(--node-fg)] outline-none"
        />
      </div>
    </div>
  );
}

/** A count in words: "1 row", "3 rows". */
export const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** ms in a few characters: "84 ms", "1.2 s". */
export const ms = (n: number) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`);

/** A row's look in a list or a tree: hovered, or selected (the accent's
 * selection while its list, a `group/list`, has the keys; quieter when not). */
export const rowState = (selected: boolean) =>
  selected ? 'bg-[var(--node-selection-inactive)] group-focus-within/list:bg-[var(--node-selection)]' : 'hover:bg-[var(--node-hover)]';
