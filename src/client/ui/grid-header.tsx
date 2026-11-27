// The grid's header: each column's name, type and key, the order it's
// sorted by, and a handle on its right edge to drag its width (double-click
// fits it to what it shows).

import { ArrowDown, ArrowUp, Key } from '@hyperpane/icons';
import { cn, styles } from '@hyperpane/ui';
import type { Cell, Column } from '../../shared/types.ts';
import { HEAD, MIN_W, NUM_W, initialWidth } from './grid-model.ts';

export function GridHeader({
  columns,
  all,
  total,
  w,
  setWidths,
  order,
  onSort,
}: {
  columns: Column[];
  all: Cell[][];
  total: number;
  w(i: number): number;
  setWidths(f: (ws: number[]) => number[]): void;
  order?: { column: string; desc: boolean }[];
  onSort?(column: string, add: boolean): void;
}) {
  const sortOf = (name: string) => order?.find((o) => o.column === name);
  const p = { onSort };
  return (
    <div
      className={cn(styles.stickyTop, 'z-20 flex min-w-full bg-[var(--node-bg)] shadow-[inset_0_-1px_0_var(--data-line-strong)]')}
      style={{ height: HEAD, width: total }}
    >
      <div className="sticky left-0 z-30 flex-none bg-[var(--node-bg)] shadow-[inset_-1px_0_0_var(--data-line),inset_0_-1px_0_var(--data-line-strong)]" style={{ width: NUM_W }} />
      {columns.map((c, i) => {
        const s = sortOf(c.name);
        return (
          <div
            key={c.name + i}
            title={[c.name, c.type, c.key ? 'primary key' : null, c.nullable === false ? 'not null' : null].filter(Boolean).join(' · ')}
            className={cn(
              'group/head relative flex flex-none items-center gap-1.5 px-3 text-xs font-medium text-[var(--node-fg)]',
              p.onSort && 'cursor-pointer transition-colors duration-100 hover:bg-[var(--data-row-hover)]',
            )}
            style={{ width: w(i) }}
            onClick={(e) => p.onSort?.(c.name, e.shiftKey)}
          >
            {c.key && <Key className="size-3.5 flex-none text-[var(--data-key)]" />}
            <span className="truncate">{c.name}</span>
            {c.type && <span className="truncate text-[11px] font-normal text-[var(--node-muted)]">{c.type}</span>}
            {s &&
              (s.desc ? (
                <ArrowDown className="ms-auto size-3.5 flex-none text-[var(--node-accent)]" />
              ) : (
                <ArrowUp className="ms-auto size-3.5 flex-none text-[var(--node-accent)]" />
              ))}
            <div
              className="absolute top-0 right-[-3px] z-10 h-full w-[6px] cursor-col-resize after:absolute after:inset-y-2 after:left-[2.5px] after:w-px after:bg-[var(--data-line)] after:content-[''] hover:after:inset-y-0 hover:after:w-0.5 hover:after:bg-[var(--node-accent)] touch:right-[-8px] touch:w-4"
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setWidths((ws) => ws.map((x, j) => (j === i ? initialWidth(c, all, i) : x)));
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                const start = e.clientX;
                const from = w(i);
                const el = e.currentTarget;
                el.setPointerCapture(e.pointerId);
                const mv = (ev: PointerEvent) =>
                  setWidths((ws) => columns.map((_, j) => (j === i ? Math.max(MIN_W, from + ev.clientX - start) : (ws[j] ?? 120))));
                const up = () => {
                  el.removeEventListener('pointermove', mv);
                  el.removeEventListener('pointerup', up);
                };
                el.addEventListener('pointermove', mv);
                el.addEventListener('pointerup', up);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
