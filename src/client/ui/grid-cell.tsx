// A cell's value as the grid shows it: NULL faint, booleans green or red,
// bytes and JSON in their own colors, text cut to the cell.

import type { Cell } from '../../shared/types.ts';
import { display, isBytes } from './cells.ts';

export function CellValue({ v }: { v: Cell }) {
  if (v === null) return <span className="text-[11px] font-medium tracking-wide text-[var(--node-muted)] opacity-60">NULL</span>;
  if (typeof v === 'boolean') return <span className={v ? 'text-[var(--data-ok)]' : 'text-[var(--data-error)]'}>{String(v)}</span>;
  if (isBytes(v)) return <span className="truncate font-mono text-xs text-[var(--ansi-5)]">{display(v)}</span>;
  if (typeof v === 'object') return <span className="truncate font-mono text-xs text-[var(--ansi-4)]">{display(v)}</span>;
  return <span className="truncate">{display(v)}</span>;
}
