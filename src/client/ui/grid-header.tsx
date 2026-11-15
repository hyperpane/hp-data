// The grid's header: each column's name, type and key, the order it's
// sorted by, and a handle on its right edge to drag its width (double-click
// fits it to what it shows).

import { ArrowDown, ArrowUp, Key } from 'lucide-react';
import { cn, styles } from '@hyperpane/ui';
import type { Cell, Column } from '../../shared/types.ts';
import { MIN_W, NUM_W, ROW, initialWidth } from './grid-model.ts';

export function GridHeader({ columns, all, total, w, setWidths, order, onSort }: { columns: Column[]; all: Cell[][]; total: number; w(i: number): number; setWidths(f: (ws: number[]) => number[]): void; order?: { column: string; desc: boolean }[]; onSort?(column: string, add: boolean): void }) {
  const sortOf = (name: string) => order?.find((o) => o.column === name);
  const p = { onSort };
  return (
        <div className={cn(styles.stickyTop, 'z-20 flex bg-[var(--node-bg)]')} style={{ height: ROW, width: total }}>
          <div className="sticky left-0 z-30 flex-none border-r border-b border-[var(--node-border)] bg-[var(--node-bg)]" style={{ width: NUM_W }} />
          {columns.map((c, i) => {
            const s = sortOf(c.name);
            return (
              <div
                key={c.name + i}
                title={[c.name, c.type, c.key ? 'primary key' : null, c.nullable === false ? 'not null' : null].filter(Boolean).join(' · ')}
                className={cn('relative flex flex-none items-center gap-1 border-r border-b border-[var(--node-border)] px-2 font-sans font-medium', p.onSort && 'cursor-pointer hover:bg-[color-mix(in_srgb,var(--node-fg)_5%,transparent)]')}
                style={{ width: w(i) }}
                onClick={(e) => p.onSort?.(c.name, e.shiftKey)}
              >
                {c.key && <Key className="size-3 flex-none text-[#e3b341]" />}
                <span className="truncate">{c.name}</span>
                {c.type && <span className="truncate text-[10px] font-normal text-[var(--node-muted)]">{c.type}</span>}
                {s && (s.desc ? <ArrowDown className="ml-auto size-3 flex-none text-[var(--node-accent)]" /> : <ArrowUp className="ml-auto size-3 flex-none text-[var(--node-accent)]" />)}
                <div
                  className="absolute top-0 right-[-3px] z-10 h-full w-[6px] cursor-col-resize"
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
                    const mv = (ev: PointerEvent) => setWidths((ws) => columns.map((_, j) => (j === i ? Math.max(MIN_W, from + ev.clientX - start) : (ws[j] ?? 120))));
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
