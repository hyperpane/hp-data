// The results grid, as DataGrip's: row numbers, resizable columns, a
// header that sorts, cells selected one, by range (drag, Shift+click) or
// by row, copied as TSV (⌘C) or as CSV, JSON, Markdown or INSERTs, and,
// when it's editable, cells changed in place (double-click, Enter), set to
// NULL, rows deleted and added; changes stay marked until they're saved.
// Only the rows in view are drawn, so a hundred thousand are fine.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type MenuEntry, cn, useMenu, isComposing } from '@hyperpane/ui';
import type { Cell, Column } from '../../shared/types.ts';
import { type CopyFormat, editable as editText, isBytes, parseInput, rowsAs } from './cells.ts';
import { CellValue } from './grid-cell.tsx';
import { GridHeader } from './grid-header.tsx';
import { type GridEdits, HEAD, NUM_W, ROW, type Sel, initialWidth, noEdits, rangeOf } from './grid-model.ts';

export { type GridEdits, ROW, hasEdits, noEdits } from './grid-model.ts';

export interface GridProps {
  columns: Column[];
  rows: Cell[][];
  /** Row numbers start here (paging). */
  offset?: number;
  /** Cells can be changed. */
  editable?: boolean;
  edits?: GridEdits;
  onEdits?(e: GridEdits): void;
  /** The order shown in the header, and a click on it. */
  order?: { column: string; desc: boolean }[];
  onSort?(column: string, add: boolean): void;
  /** For "Copy as INSERT". */
  table?: string;
  /** More entries for a cell's right-click menu. */
  menu?(row: number, col: number): (MenuEntry | null)[];
  /** A cell opened (double-click on a read-only grid, or "Open value"). */
  onOpenValue?(row: number, col: number, value: Cell): void;
  copy(text: string, what?: string): void;
  className?: string;
  /** Text when there are no rows. */
  empty?: string;
}

export function Grid(p: GridProps) {
  const { columns, rows, offset = 0 } = p;
  const edits = p.edits ?? noEdits();
  const all = useMemo(() => [...rows, ...edits.added], [rows, edits.added]);
  const [widths, setWidths] = useState<number[]>([]);
  const [sel, setSel] = useState<Sel | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; text: string } | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 400 });
  const box = useRef<HTMLDivElement>(null);
  const menu = useMenu();
  const colsKey = columns.map((c) => c.name).join('\u0000');

  useEffect(() => {
    setWidths(columns.map((c, i) => initialWidth(c, rows, i)));
    setSel(null);
    setEditing(null);
  }, [colsKey]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, height: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const w = (i: number) => widths[i] ?? 120;
  const total = NUM_W + columns.reduce((s, _, i) => s + w(i), 0);
  const first = Math.max(0, Math.floor((scroll.top - HEAD) / ROW) - 8);
  const last = Math.min(all.length, Math.ceil((scroll.top + scroll.height - HEAD) / ROW) + 8);

  const valueAt = (r: number, c: number): Cell => {
    const k = `${r}:${c}`;
    return edits.changed.has(k) ? edits.changed.get(k)! : (all[r]?.[c] ?? null);
  };

  const range = (s: Sel) => rangeOf(s, columns.length);
  const inSel = (r: number, c: number) => {
    if (!sel) return false;
    const { r0, r1, c0, c1 } = range(sel);
    return r >= r0 && r <= r1 && c >= c0 && c <= c1;
  };

  const selected = (): { cols: Column[]; rows: Cell[][] } => {
    if (!sel) return { cols: columns, rows: all.map((_, r) => columns.map((_, c) => valueAt(r, c))) };
    const { r0, r1, c0, c1 } = range(sel);
    const out: Cell[][] = [];
    for (let r = r0; r <= r1; r++) out.push(columns.slice(c0, c1 + 1).map((_, i) => valueAt(r, c0 + i)));
    return { cols: columns.slice(c0, c1 + 1), rows: out };
  };

  const copyAs = (f: CopyFormat) => {
    const s = selected();
    const text =
      f === 'tsv' && s.rows.length === 1 && s.cols.length === 1 ? (s.rows[0][0] === null ? '' : editText(s.rows[0][0])) : rowsAs(f, s.cols, s.rows, p.table);
    p.copy(text, f === 'tsv' ? undefined : `${s.rows.length} ${s.rows.length === 1 ? 'row' : 'rows'}`);
  };

  const setCell = (r: number, c: number, v: Cell) => {
    if (!p.onEdits) return;
    const changed = new Map(edits.changed);
    if (r >= rows.length) {
      const added = edits.added.map((row) => [...row]);
      added[r - rows.length][c] = v;
      p.onEdits({ ...edits, added });
      return;
    }
    const orig = rows[r][c];
    if (JSON.stringify(orig) === JSON.stringify(v)) changed.delete(`${r}:${c}`);
    else changed.set(`${r}:${c}`, v);
    p.onEdits({ ...edits, changed });
  };

  const commit = () => {
    if (!editing) return;
    setCell(editing.r, editing.c, parseInput(editing.text, columns[editing.c], valueAt(editing.r, editing.c)));
    setEditing(null);
    box.current?.focus();
  };

  const startEdit = (r: number, c: number) => {
    const v = valueAt(r, c);
    if (!p.editable || columns[c]?.readOnly || edits.deleted.has(r) || isBytes(v)) {
      p.onOpenValue?.(r, c, v);
      return;
    }
    setEditing({ r, c, text: v === null ? '' : editText(v) });
  };

  const deleteRows = () => {
    if (!sel || !p.onEdits) return;
    const { r0, r1 } = range(sel);
    const deleted = new Set(edits.deleted);
    const keep: Cell[][] = [];
    edits.added.forEach((row, i) => {
      if (rows.length + i < r0 || rows.length + i > r1) keep.push(row);
    });
    for (let r = r0; r <= Math.min(r1, rows.length - 1); r++) deleted.has(r) ? deleted.delete(r) : deleted.add(r);
    p.onEdits({ ...edits, deleted, added: keep });
  };

  const addRow = () => {
    if (!p.onEdits) return;
    const added = [...edits.added, columns.map(() => null)];
    p.onEdits({ ...edits, added });
    const r = rows.length + added.length - 1;
    setSel({ a: [r, 0], b: [r, 0] });
    requestAnimationFrame(() => {
      if (box.current) box.current.scrollTop = HEAD + r * ROW;
    });
  };

  const scrollTo = (r: number, c: number) => {
    const el = box.current;
    if (!el) return;
    const top = r * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (HEAD + top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = HEAD + top + ROW - el.clientHeight;
    let x = NUM_W;
    for (let i = 0; i < c; i++) x += w(i);
    if (x < el.scrollLeft + NUM_W) el.scrollLeft = x - NUM_W;
    else if (x + w(c) > el.scrollLeft + el.clientWidth) el.scrollLeft = x + w(c) - el.clientWidth;
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copyAs('tsv');
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSel({ a: [0, 0], b: [all.length - 1, columns.length - 1] });
      return;
    }
    if (!sel) return;
    const [r, c] = sel.b;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      const nr = Math.max(0, Math.min(all.length - 1, r + dr));
      const nc = Math.max(0, Math.min(columns.length - 1, Math.max(c, 0) + dc));
      setSel(e.shiftKey ? { a: sel.a, b: [nr, nc] } : { a: [nr, nc], b: [nr, nc] });
      scrollTo(nr, nc);
    };
    if (e.key === 'ArrowDown') move(1, 0);
    else if (e.key === 'ArrowUp') move(-1, 0);
    else if (e.key === 'ArrowLeft') move(0, -1);
    else if (e.key === 'ArrowRight' || e.key === 'Tab') move(0, e.key === 'Tab' && e.shiftKey ? -1 : 1);
    else if (e.key === 'PageDown') move(Math.floor(scroll.height / ROW), 0);
    else if (e.key === 'PageUp') move(-Math.floor(scroll.height / ROW), 0);
    else if ((e.key === 'Enter' || e.key === 'F2') && c >= 0) {
      e.preventDefault();
      startEdit(r, c);
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && p.editable) {
      e.preventDefault();
      if (sel.a[1] < 0) deleteRows();
      else {
        const { r0, r1, c0, c1 } = range(sel);
        for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) if (!columns[cc]?.readOnly) setCell(rr, cc, mod ? null : '');
      }
    } else if (p.editable && c >= 0 && e.key.length === 1 && !mod && !e.altKey && !columns[c]?.readOnly && !edits.deleted.has(r)) {
      e.preventDefault();
      setEditing({ r, c, text: e.key });
    }
  };

  const cellMenu = (e: React.MouseEvent, r: number, c: number) => {
    e.preventDefault();
    if (!inSel(r, Math.max(c, 0))) setSel({ a: [r, c], b: [r, c] });
    const items: (MenuEntry | null)[] = [
      { label: 'Copy', shortcut: '⌘C', run: () => copyAs('tsv') },
      { label: 'Copy as CSV', run: () => copyAs('csv') },
      { label: 'Copy as JSON', run: () => copyAs('json') },
      { label: 'Copy as Markdown', run: () => copyAs('markdown') },
      { label: 'Copy as SQL INSERT', run: () => copyAs('insert') },
      null,
    ];
    if (c >= 0) items.push({ label: 'Open Value', run: () => p.onOpenValue?.(r, c, valueAt(r, c)) });
    if (p.editable) {
      if (c >= 0)
        items.push(
          { label: 'Edit', shortcut: '↵', disabled: !!columns[c]?.readOnly || edits.deleted.has(r), run: () => startEdit(r, c) },
          { label: 'Set NULL', shortcut: '⌘⌫', disabled: !!columns[c]?.readOnly, run: () => setCell(r, c, null) },
        );
      items.push(
        null,
        { label: 'Add Row', run: addRow },
        { label: edits.deleted.has(r) ? 'Keep Row' : 'Delete Row', danger: !edits.deleted.has(r), run: deleteRows },
      );
    }
    const more = p.menu?.(r, c) ?? [];
    if (more.length) items.push(null, ...more);
    menu.open(e, items);
  };

  const down = useRef<[number, number] | null>(null);

  if (!columns.length)
    return <div className={cn('flex items-center justify-center p-6 text-[13px] text-[var(--node-muted)]', p.className)}>{p.empty ?? 'Nothing to show'}</div>;

  return (
    <div
      ref={box}
      tabIndex={0}
      onKeyDown={onKey}
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      className={cn('group/grid relative min-h-0 overflow-auto text-[13px] outline-none select-none', p.className)}
    >
      <div style={{ width: Math.max(total, 0), minWidth: '100%', height: HEAD + all.length * ROW }} className="relative">
        <GridHeader columns={columns} all={all} total={total} w={w} setWidths={setWidths} order={p.order} onSort={p.onSort} />
        {/* The rows in view. */}
        {all.slice(first, last).map((_row, k) => {
          const r = first + k;
          const isNew = r >= rows.length;
          const gone = edits.deleted.has(r);
          return (
            <div
              key={r}
              className={cn('group/gridrow absolute left-0 flex min-w-full border-b border-[var(--data-line)] hover:bg-[var(--data-row-hover)]', gone && 'opacity-60')}
              style={{ top: HEAD + r * ROW, height: ROW, width: total }}
            >
              <div
                className={cn(
                  'sticky left-0 z-10 flex flex-none items-center justify-end bg-[var(--node-bg)] pe-3 text-[11px] text-[color-mix(in_srgb,var(--node-muted)_80%,transparent)] tabular-nums shadow-[inset_-1px_0_0_var(--data-line)]',
                  sel && range(sel).whole && r >= range(sel).r0 && r <= range(sel).r1 && 'bg-[color-mix(in_srgb,var(--node-accent)_12%,var(--node-bg))] font-medium text-[var(--node-accent)]',
                  isNew && 'text-[var(--data-ok)]',
                  gone && 'text-[var(--data-error)] line-through',
                )}
                style={{ width: NUM_W }}
                onPointerDown={(e) => {
                  box.current?.focus();
                  setSel(e.shiftKey && sel ? { a: sel.a, b: [r, -1] } : { a: [r, -1], b: [r, -1] });
                }}
                onContextMenu={(e) => cellMenu(e, r, -1)}
              >
                {isNew ? '+' : offset + r + 1}
              </div>
              {columns.map((col, c) => {
                const v = valueAt(r, c);
                const changed = edits.changed.has(`${r}:${c}`);
                const on = inSel(r, c);
                const isEdit = editing && editing.r === r && editing.c === c;
                return (
                  <div
                    key={c}
                    className={cn(
                      'relative flex flex-none items-center overflow-hidden px-3 whitespace-pre',
                      (typeof v === 'number' ||
                        (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && /int|num|dec|float|double|real/i.test(col.type ?? ''))) &&
                        'justify-end tabular-nums',
                      on && 'bg-[var(--data-cell-picked)]',
                      on && sel && !range(sel).whole && sel.b[0] === r && sel.b[1] === c && 'shadow-[inset_0_0_0_1.5px_var(--data-cell-edge)]',
                      changed && 'bg-[color-mix(in_srgb,var(--data-warn)_16%,transparent)]',
                      isNew && 'bg-[color-mix(in_srgb,var(--data-ok)_9%,transparent)]',
                      gone && 'text-[var(--node-muted)] line-through',
                    )}
                    style={{ width: w(c) }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      box.current?.focus({ preventScroll: true });
                      if (editing && !isEdit) commit();
                      down.current = [r, c];
                      setSel(e.shiftKey && sel ? { a: sel.a, b: [r, c] } : { a: [r, c], b: [r, c] });
                    }}
                    onPointerEnter={(e) => {
                      if (down.current && e.buttons === 1) setSel({ a: down.current, b: [r, c] });
                    }}
                    onPointerUp={() => (down.current = null)}
                    onDoubleClick={() => startEdit(r, c)}
                    onContextMenu={(e) => cellMenu(e, r, c)}
                  >
                    {isEdit ? (
                      <input
                        autoFocus
                        value={editing.text}
                        onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                        onBlur={commit}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter' && !isComposing(e)) commit();
                          else if (e.key === 'Escape') {
                            setEditing(null);
                            box.current?.focus();
                          }
                        }}
                        className="rounded-chip -mx-2 h-[calc(100%-4px)] w-[calc(100%+16px)] bg-[var(--node-bg)] px-2 text-[13px] text-[var(--node-fg)] shadow-[0_0_0_1.5px_var(--node-accent),0_4px_12px_-4px_rgb(0_0_0/0.35)] outline-none"
                      />
                    ) : (
                      <CellValue v={v} />
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {!all.length && <div className="absolute inset-x-0 top-16 text-center text-[13px] text-[var(--node-muted)]">{p.empty ?? 'No rows'}</div>}
      {menu.element}
    </div>
  );
}
