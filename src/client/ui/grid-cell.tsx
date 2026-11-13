// A cell's value as the grid shows it: NULL faint, booleans green or red,
// bytes and JSON in their own colors, text cut to the cell.

import type { Cell } from '../../shared/types.ts';
import { display, isBytes } from './cells.ts';

export function CellValue({ v }: { v: Cell }) {
  if (v === null) return <span className="text-[var(--node-muted)] italic opacity-70">NULL</span>;
  if (typeof v === 'boolean') return <span className={v ? 'text-[#3fb950]' : 'text-[#f85149]'}>{String(v)}</span>;
  if (isBytes(v)) return <span className="text-[#bc8cff]">{display(v)}</span>;
  if (typeof v === 'object') return <span className="text-[#58a6ff]">{display(v)}</span>;
  return <span className="truncate">{display(v)}</span>;
}
