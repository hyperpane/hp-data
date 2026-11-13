// Values from any driver as cells (shared/types.ts Cell): what JSON can
// carry, so a window can show them, and what it sends back as values.

import type { Cell } from '../../shared/types.ts';

const BYTES_SHOWN = 4096;

export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'bigint':
      return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
    case 'object':
      break;
    default:
      return String(v);
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v as Uint8Array);
    return { $bytes: b.subarray(0, BYTES_SHOWN).toString('base64'), size: b.length };
  }
  if (Array.isArray(v)) return v.map(toCell);
  const o = v as Record<string, unknown> & { toJSON?: () => unknown };
  if (typeof o.toJSON === 'function') return toCell(o.toJSON());
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, toCell(x)]));
}

/** A cell as a value to bind: bytes back to a Buffer. */
export function fromCell(c: Cell): unknown {
  if (c && typeof c === 'object' && !Array.isArray(c) && typeof (c as { $bytes?: unknown }).$bytes === 'string') return Buffer.from((c as { $bytes: string }).$bytes, 'base64');
  if (c && typeof c === 'object') return JSON.stringify(c);
  return c;
}

/** ms since `t0` (performance.now()), to a tenth. */
export const since = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
