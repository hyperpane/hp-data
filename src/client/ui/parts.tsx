// Small parts every view uses that are Data’s own: a kind’s tile, an
// error, a value viewer, counts and durations in words. (Toolbars, status
// bars, splits, tabs and pickers are the kit’s.)

import { useEffect, useState } from 'react';
import { TriangleAlert, X } from '@hyperpane/icons';
import { IconTile, NodeButton, Spinner, ToolButton, cn } from '@hyperpane/ui';
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
  'border-transparent bg-[var(--data-fill)] hover:border-transparent hover:bg-[var(--data-fill-hover)]';

/** A text area for code (statements, a key, JSON) with the field's look. */
export const codeArea =
  'rounded-control border border-transparent bg-[var(--data-fill)] px-2.5 py-2 font-mono text-xs leading-5 text-[var(--node-fg)] outline-none transition-[border-color,box-shadow,background-color] duration-100 placeholder:text-[var(--node-muted)] hover:bg-[var(--data-fill-hover)] focus:border-[color-mix(in_srgb,var(--node-accent)_75%,transparent)] focus:bg-transparent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--node-accent)_16%,transparent)]';

/** What failed, along the top of a view: a card tinted red, its icon on a
 * round tile, the message (selectable), and a way to put it away. */
export function ErrorBox({ error, onClose, className }: { error: string; onClose?(): void; className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-card mx-2 mt-2 flex flex-none items-start gap-2.5 bg-[color-mix(in_srgb,var(--data-error)_9%,transparent)] py-2 ps-2.5 pe-1.5 text-[13px] text-[var(--node-fg)] ring-1 ring-[color-mix(in_srgb,var(--data-error)_20%,transparent)] ring-inset select-text',
        className,
      )}
    >
      <span className="mt-0.5 grid size-5 flex-none place-items-center rounded-full bg-[color-mix(in_srgb,var(--data-error)_16%,transparent)] text-[var(--data-error)]">
        <TriangleAlert className="size-3" />
      </span>
      <span className="min-w-0 flex-1 py-px leading-5 break-words whitespace-pre-wrap">{error}</span>
      {onClose && <ToolButton label="Dismiss" icon={X} className="-my-0.5" onClick={onClose} />}
    </div>
  );
}

/** A message in the middle of a pane: an icon on a soft tile, a short
 * title, a muted line, and what can be done (one primary at most). */
export function Blank({
  icon,
  title,
  children,
  actions,
  error,
  className,
}: {
  icon?: React.ReactNode;
  title?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  error?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto p-6 text-center', className)}>
      {icon && <IconTile icon={icon} size="lg" tint={error ? 'var(--data-error)' : undefined} />}
      {(title || children) && (
        <div className="flex max-w-80 flex-col gap-1">
          {title && <div className="text-[13px] font-medium text-[var(--node-fg)]">{title}</div>}
          {children && <div className="text-xs leading-relaxed text-[var(--node-muted)] [overflow-wrap:anywhere]">{children}</div>}
        </div>
      )}
      {actions && <div className="flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

/** Loading, in the middle of a pane: a spinner and a word. */
export function Loading({ children = 'Loading' }: { children?: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[13px] text-[var(--node-muted)]">
      <Spinner size="xs" />
      {children}
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
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-6 backdrop-blur-[2px] max-sm:p-3"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="rounded-panel flex max-h-full w-[min(720px,100%)] flex-col overflow-hidden bg-[var(--node-bg)] shadow-dialog ring-1 ring-[var(--data-line-strong)]">
        <div className="flex h-11 flex-none items-center gap-2 border-b border-[var(--data-line)] ps-4 pe-2">
          <span className="truncate text-[13px] font-medium">{title}</span>
          <span className="flex-none text-xs text-[var(--node-muted)] tabular-nums">
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
          className="min-h-[240px] flex-1 resize-none bg-transparent px-4 py-3 font-mono text-xs leading-5 text-[var(--node-fg)] outline-none"
        />
      </div>
    </div>
  );
}

/** A count in words: "1 row", "3 rows". */
export const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** ms in a few characters: "84 ms", "1.2 s". */
export const ms = (n: number) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`);

/** A row's look in a list or a tree: hovered, or picked (a soft accent
 * pill while its list, a `group/list`, has the keys; quieter when not). */
export const rowState = (selected: boolean) =>
  selected
    ? 'bg-[var(--data-selected-quiet)] group-focus-within/list:bg-[var(--data-selected)]'
    : 'hover:bg-[var(--node-hover)]';
