// The grid's model, apart from its drawing: the edits it keeps (changed
// cells, deleted rows, added ones), a selection as a range, and the widths
// columns start at.

import type { Cell, Column } from '../../shared/types.ts';
import { display } from './cells.ts';

/** A row's height, and the header's (taller: a name and its type). */
export const ROW = 28;
export const HEAD = 32;

export interface GridEdits {
  /** Changed cells: `${row}:${col}` → the new value. */
  changed: Map<string, Cell>;
  /** Rows marked to delete. */
  deleted: Set<number>;
  /** Rows past `rows.length` are new ones, here. */
  added: Cell[][];
}

export const noEdits = (): GridEdits => ({ changed: new Map(), deleted: new Set(), added: [] });
export const hasEdits = (e: GridEdits) => e.changed.size > 0 || e.deleted.size > 0 || e.added.length > 0;

export interface Sel {
  /** Anchor and focus: [row, col]; col -1 is the whole row. */
  a: [number, number];
  b: [number, number];
}

export const MIN_W = 60;
export const NUM_W = 52;

export function initialWidth(c: Column, rows: Cell[][], i: number): number {
  // The header: the name (13px), its type (11px), the key's icon, padding.
  let w = Math.max(c.name.length * 7.4 + (c.type ? Math.min(c.type.length, 14) * 6 + 8 : 0) + (c.key ? 18 : 0) + 28, 72);
  for (let r = 0; r < Math.min(rows.length, 50); r++) w = Math.max(w, Math.min(display(rows[r][i]).length * 7.2 + 28, 340));
  return Math.round(w);
}

/** A selection as rows and columns (a whole row's column is -1: every column). */
export function rangeOf(s: Sel, columns: number) {
  const r0 = Math.min(s.a[0], s.b[0]);
  const r1 = Math.max(s.a[0], s.b[0]);
  const whole = s.a[1] < 0 || s.b[1] < 0;
  const c0 = whole ? 0 : Math.min(s.a[1], s.b[1]);
  const c1 = whole ? columns - 1 : Math.max(s.a[1], s.b[1]);
  return { r0, r1, c0, c1, whole };
}
