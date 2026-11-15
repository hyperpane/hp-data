// A result as the Rows port sends it: each row an object by column name,
// at most a thousand, bytes as a short note.

import type { Cell, QueryResult } from '../../shared/types.ts';
import { formatSize, isBytes } from '../ui/cells.ts';

export const MAX_ROWS = 1000;

export interface RowsOut {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  statement?: string;
  connection: string;
}

/** The result for the port; null when it gave no columns. A name used twice
 * gets " (2)", so no value is lost. */
export function rowsOut(r: QueryResult, connection: string, statement = r.statement): RowsOut | null {
  if (!r.columns.length) return null;
  const seen = new Set<string>();
  const columns = r.columns.map((c) => {
    let name = c.name;
    for (let n = 2; seen.has(name); n++) name = `${c.name} (${n})`;
    seen.add(name);
    return name;
  });
  const rows = r.rows.slice(0, MAX_ROWS).map((row) => Object.fromEntries(columns.map((name, i) => [name, cell(row[i] ?? null)])));
  const out: RowsOut = { columns, rows, truncated: !!r.truncated || r.rows.length > MAX_ROWS, connection };
  if (statement) out.statement = statement;
  return out;
}

const cell = (c: Cell): unknown => (isBytes(c) ? `<bytes ${formatSize(c.size)}>` : c);
