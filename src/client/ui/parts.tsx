// Small parts every view uses: a kind's tile, a toolbar, a splitter, a
// status line, an error, a value viewer, a select that fits a toolbar.

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { NodeButton, cn } from '@hyperpane/ui';
import type { Kind } from '../../shared/kinds.ts';
import type { Cell } from '../../shared/types.ts';
import { editable, formatSize, isBytes } from './cells.ts';
import { useKept } from '../lib/hooks.ts';

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

/** A row of controls at the top of a view. */
export function Toolbar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex h-9 flex-none items-center gap-1 border-b border-[var(--node-border)] px-2', className)}>{children}</div>;
}

/** A line at the bottom: what was done, how long it took. */
export function StatusLine({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex h-6 flex-none items-center gap-3 border-t border-[var(--node-border)] px-2 text-[10.5px] text-[var(--node-muted)]', className)}>{children}</div>;
}

export function ErrorBox({ error, onClose, className }: { error: string; onClose?(): void; className?: string }) {
  return (
    <div className={cn('flex items-start gap-2 border-l-2 border-[#f85149] bg-[color-mix(in_srgb,#f85149_10%,transparent)] px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-[var(--node-fg)] select-text', className)}>
      <span className="min-w-0 flex-1">{error}</span>
      {onClose && (
        <button type="button" aria-label="Dismiss" className="text-[var(--node-muted)] hover:text-[var(--node-fg)]" onClick={onClose}>
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** A line between two panes that's easy to catch: 1px drawn, 9px to
 * grab, lit while hovered or dragged. Double-click puts it back. */
export function Handle({ dir, onDrag, onReset, title = 'Drag to resize; double-click for the usual size' }: { dir: 'row' | 'column'; onDrag(dx: number, dy: number, done: boolean): void; onReset?(): void; title?: string }) {
  const row = dir === 'row';
  const [active, setActive] = useState(false);
  return (
    <div className={cn('relative z-20 flex-none bg-[var(--node-border)]', row ? 'w-px' : 'h-px', active && 'bg-[var(--node-accent)]')}>
      <div
        role="separator"
        aria-orientation={row ? 'vertical' : 'horizontal'}
        title={title}
        className={cn('absolute transition-colors hover:bg-[color-mix(in_srgb,var(--node-accent)_45%,transparent)]', row ? 'inset-y-0 -left-1 w-[9px] cursor-col-resize' : 'inset-x-0 -top-1 h-[9px] cursor-row-resize', active && 'bg-[color-mix(in_srgb,var(--node-accent)_45%,transparent)]')}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const x = e.clientX;
          const y = e.clientY;
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          setActive(true);
          const move = (ev: PointerEvent) => onDrag(ev.clientX - x, ev.clientY - y, false);
          const up = (ev: PointerEvent) => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('pointercancel', up);
            setActive(false);
            onDrag(ev.clientX - x, ev.clientY - y, true);
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
          el.addEventListener('pointercancel', up);
        }}
        onDoubleClick={onReset}
      />
    </div>
  );
}

/** Two panes and a handle between them, the split kept per `id`; neither
 * pane gets smaller than `min`. */
export function Split({ id, dir, first, second, initial, min = 80, className }: { id: string; dir: 'row' | 'column'; first: React.ReactNode; second: React.ReactNode; initial: number; min?: number; className?: string }) {
  const [size, setSize] = useKept(`data.split.${id}`, initial);
  const box = useRef<HTMLDivElement>(null);
  const row = dir === 'row';
  const start = useRef(size);
  const total = () => (row ? box.current?.clientWidth : box.current?.clientHeight) ?? 10_000;
  const shown = Math.max(min, Math.min(size, total() - min));
  return (
    <div ref={box} className={cn('flex min-h-0 min-w-0 flex-1', row ? 'flex-row' : 'flex-col', className)}>
      <div className="flex min-h-0 min-w-0 flex-none flex-col" style={row ? { width: shown } : { height: shown }}>
        {first}
      </div>
      <Handle
        dir={dir}
        onDrag={(dx, dy, done) => {
          const next = Math.max(min, Math.min(total() - min, Math.round(start.current + (row ? dx : dy))));
          setSize(next);
          if (done) start.current = next;
        }}
        onReset={() => ((start.current = initial), setSize(initial))}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{second}</div>
    </div>
  );
}

/** A select that fits a toolbar: the app's look, the platform's list. */
export function MiniSelect<T extends string>({ value, options, onChange, title, className }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; title?: string; className?: string }) {
  return (
    <label title={title} className={cn('relative inline-flex h-6 items-center rounded-[5px] border border-[var(--node-border)] pr-5 pl-2 text-[11px] hover:bg-[color-mix(in_srgb,var(--node-fg)_5%,transparent)]', className)}>
      <span className="max-w-[180px] truncate">{options.find((o) => o.value === value)?.label ?? value}</span>
      <ChevronDown className="pointer-events-none absolute right-1 size-3 text-[var(--node-muted)]" />
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className="absolute inset-0 cursor-pointer opacity-0">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A cell's whole value, over the view: text, pretty JSON, or bytes. */
export function ValueViewer({ title, value, onClose, copy, onSave }: { title: string; value: Cell; onClose(): void; copy(text: string, what?: string): void; onSave?(text: string): void }) {
  const text = value === null ? '' : editable(value);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-6" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-full w-[min(720px,100%)] flex-col overflow-hidden rounded-lg border border-[var(--node-border)] bg-[var(--node-bg)] shadow-2xl">
        <div className="flex h-9 flex-none items-center gap-2 border-b border-[var(--node-border)] px-3">
          <span className="truncate font-medium">{title}</span>
          <span className="text-[10.5px] text-[var(--node-muted)]">{value === null ? 'NULL' : isBytes(value) ? formatSize(value.size) : `${text.length.toLocaleString()} characters`}</span>
          <div className="ml-auto flex gap-1">
            <NodeButton onClick={() => copy(draft, 'the value')}>Copy</NodeButton>
            {onSave && (
              <NodeButton disabled={draft === text} onClick={() => (onSave(draft), onClose())}>
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
