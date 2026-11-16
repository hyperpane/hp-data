// Cells as text: for the grid, for copying (TSV, CSV, JSON, Markdown, SQL),
// and back from what's typed.

import type { Cell, Column } from '../../shared/types.ts';

export const isBytes = (c: Cell): c is { $bytes: string; size: number } =>
  !!c && typeof c === 'object' && !Array.isArray(c) && typeof (c as { $bytes?: unknown }).$bytes === 'string';

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** What a cell shows, in one line. */
export function display(c: Cell): string {
  if (c === null) return 'NULL';
  if (typeof c === 'string') return c.length > 2000 ? `${c.slice(0, 2000)}…` : c;
  if (typeof c === 'number' || typeof c === 'boolean') return String(c);
  if (isBytes(c)) return hexPreview(c);
  return JSON.stringify(c);
}

function hexPreview(c: { $bytes: string; size: number }): string {
  const b = Uint8Array.from(atob(c.$bytes), (x) => x.charCodeAt(0));
  const hex = Array.from(b.subarray(0, 16), (x) => x.toString(16).padStart(2, '0')).join('');
  return `0x${hex}${c.size > 16 ? '…' : ''} (${formatSize(c.size)})`;
}

/** A cell as plain text, in full (null: ''). */
export function plain(c: Cell): string {
  if (c === null) return '';
  if (typeof c === 'string') return c;
  if (typeof c === 'number' || typeof c === 'boolean') return String(c);
  if (isBytes(c)) return hexPreview(c);
  return JSON.stringify(c);
}

/** A cell for editing: objects pretty. */
export function editable(c: Cell): string {
  if (c && typeof c === 'object' && !isBytes(c)) return JSON.stringify(c, null, 2);
  return plain(c);
}

/** What's typed, as a cell of the column's kind: a number for a number
 * column, JSON for a json one, text else. */
export function parseInput(text: string, col: Column | undefined, was: Cell): Cell {
  const t = (col?.type ?? '').toLowerCase();
  if (
    typeof was === 'number' ||
    /^(int|integer|smallint|bigint|tinyint|mediumint|serial|bigserial|smallserial|int[248]|float[48]?|double|real|decimal|numeric|number)/.test(t)
  ) {
    const n = Number(text.trim());
    if (text.trim() !== '' && Number.isFinite(n) && (!/bigint|int8|numeric|decimal/.test(t) || Number.isSafeInteger(n))) return n;
    return text;
  }
  if (typeof was === 'boolean' || /^(bool|boolean|bit\(1\))/.test(t)) {
    if (/^(true|t|1|yes)$/i.test(text.trim())) return true;
    if (/^(false|f|0|no)$/i.test(text.trim())) return false;
  }
  if ((was && typeof was === 'object' && !isBytes(was)) || /json/.test(t)) {
    try {
      return JSON.parse(text) as Cell;
    } catch {}
  }
  return text;
}

const csvField = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export type CopyFormat = 'tsv' | 'csv' | 'json' | 'markdown' | 'insert' | 'values';

/** Rows as text to copy. */
export function rowsAs(format: CopyFormat, columns: Column[], rows: Cell[][], table = 'table'): string {
  switch (format) {
    case 'tsv':
      return rows.map((r) => r.map((c) => plain(c).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t')).join('\n');
    case 'csv':
      return [columns.map((c) => csvField(c.name)).join(','), ...rows.map((r) => r.map((c) => csvField(plain(c))).join(','))].join('\n');
    case 'json':
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i]]))),
        null,
        2,
      );
    case 'markdown': {
      const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      return [
        `| ${columns.map((c) => esc(c.name)).join(' | ')} |`,
        `| ${columns.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.map((c) => esc(plain(c))).join(' | ')} |`),
      ].join('\n');
    }
    case 'insert':
      return rows.map((r) => `INSERT INTO ${table} (${columns.map((c) => c.name).join(', ')}) VALUES (${r.map(sqlLiteral).join(', ')});`).join('\n');
    case 'values':
      return rows.map((r) => r.map(plain).join(', ')).join('\n');
  }
}

function sqlLiteral(c: Cell): string {
  if (c === null) return 'NULL';
  if (typeof c === 'number') return String(c);
  if (typeof c === 'boolean') return c ? 'TRUE' : 'FALSE';
  if (isBytes(c)) return `X'${Array.from(atob(c.$bytes), (x) => x.charCodeAt(0).toString(16).padStart(2, '0')).join('')}'`;
  const s = typeof c === 'string' ? c : JSON.stringify(c);
  return `'${s.replace(/'/g, "''")}'`;
}
