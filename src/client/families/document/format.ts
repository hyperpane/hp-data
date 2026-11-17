// Documents as they're shown and edited: MongoDB's Extended JSON as the
// shell writes it (ObjectId('…'), ISODate('…')) for the tree and the
// table, and as text the editor gives back (the server reads the shell's
// literals); a page of documents as a table's columns; and the block of a
// console's text at the cursor.

import type { Cell, Column } from '../../../shared/types.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** An Extended JSON wrapper as the shell writes it, or null when it isn't one. */
function literal(o: Record<string, unknown>, single = false): string | null {
  const keys = Object.keys(o);
  if (keys.length === 0 || keys.length > 2 || !keys[0].startsWith('$')) return null;
  const k = keys[0];
  const v = o[k];
  const q = (s: unknown) => (single ? `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(String(s)));
  if (keys.length === 1) {
    if (k === '$oid' && typeof v === 'string') return `ObjectId(${q(v)})`;
    if (k === '$date') {
      if (typeof v === 'string') return `ISODate(${q(v)})`;
      if (isObj(v) && typeof v.$numberLong === 'string') return `ISODate(${q(new Date(Number(v.$numberLong)).toISOString())})`;
    }
    if (k === '$numberLong' && typeof v === 'string') return `NumberLong(${q(v)})`;
    if (k === '$numberDecimal' && typeof v === 'string') return `NumberDecimal(${q(v)})`;
    if (k === '$numberInt' && typeof v === 'string') return `NumberInt(${v})`;
    if (k === '$numberDouble' && typeof v === 'string') return v;
    if (k === '$uuid' && typeof v === 'string') return `UUID(${q(v)})`;
    if (k === '$minKey') return 'MinKey';
    if (k === '$maxKey') return 'MaxKey';
    if (k === '$timestamp' && isObj(v)) return `Timestamp(${Number(v.t)}, ${Number(v.i)})`;
    if (k === '$regularExpression' && isObj(v)) return `/${String(v.pattern).replace(/\//g, '\\/')}/${v.options ?? ''}`;
    if (k === '$binary' && isObj(v)) return `BinData(${parseInt(String(v.subType ?? '0'), 16) || 0}, ${q(v.base64)})`;
  }
  return null;
}

/** A value to show: MongoDB's wrappers as the shell's literals (strings). */
export function pretty(v: unknown, mongo: boolean): Json {
  if (Array.isArray(v)) return v.map((x) => pretty(x, mongo));
  if (isObj(v)) {
    if (mongo) {
      const l = literal(v, true);
      if (l !== null) return l;
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pretty(x, mongo)]));
  }
  return (v ?? null) as Json;
}

const KEY = /^[A-Za-z_$][\w$]*$/;

/** A document as text to edit: JSON, with MongoDB's wrappers as the
 * shell's literals. */
export function toText(v: unknown, mongo: boolean, indent = 0): string {
  const pad = '  '.repeat(indent + 1);
  const end = '  '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[\n${v.map((x) => pad + toText(x, mongo, indent + 1)).join(',\n')}\n${end}]`;
  }
  if (isObj(v)) {
    if (mongo) {
      const l = literal(v);
      if (l !== null) return l;
    }
    const entries = Object.entries(v);
    if (!entries.length) return '{}';
    return `{\n${entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${toText(x, mongo, indent + 1)}`).join(',\n')}\n${end}}`;
  }
  return JSON.stringify(v ?? null);
}

/** A document in one line, for its row: `{ _id: ObjectId('…'), name: "Ann", … }`. */
export function oneLine(v: unknown, mongo: boolean, room = 400): string {
  let out = '';
  const walk = (x: unknown): void => {
    if (out.length > room) return;
    if (Array.isArray(x)) {
      out += '[';
      x.forEach((y, i) => {
        if (i) out += ', ';
        walk(y);
      });
      out += ']';
    } else if (isObj(x)) {
      const l = mongo ? literal(x, true) : null;
      if (l !== null) {
        out += l;
        return;
      }
      out += '{ ';
      Object.entries(x).forEach(([k, y], i) => {
        if (i) out += ', ';
        out += `${KEY.test(k) ? k : JSON.stringify(k)}: `;
        walk(y);
      });
      out += ' }';
    } else out += JSON.stringify(x ?? null);
  };
  walk(v);
  return out.length > room ? out.slice(0, room) : out;
}

/** The document's id fields, from the document as it came. */
export function keyOf(doc: unknown, idFields: string[]): Record<string, unknown> | null {
  if (!isObj(doc)) return null;
  const key: Record<string, unknown> = {};
  for (const f of idFields) {
    if (doc[f] === undefined) return null;
    key[f] = doc[f];
  }
  if (isObj(doc) && typeof doc._index === 'string' && idFields.includes('_id')) key._index = doc._index;
  return key;
}

/** A page of documents as a table: the id fields first, then every
 * top-level field in the order first seen. */
export function tableOf(docs: unknown[], idFields: string[], mongo: boolean): { columns: Column[]; rows: Cell[][] } {
  const names: string[] = [...idFields];
  const seen = new Set(names);
  for (const d of docs)
    if (isObj(d))
      for (const k of Object.keys(d))
        if (!seen.has(k)) {
          seen.add(k);
          names.push(k);
        }
  const present = names.filter((n) => docs.some((d) => isObj(d) && d[n] !== undefined));
  const columns: Column[] = present.map((name) => ({ name, key: idFields.includes(name) }));
  const rows = docs.map((d) => present.map((n) => (isObj(d) && d[n] !== undefined ? (pretty(d[n], mongo) as Cell) : null)));
  return { columns, rows };
}

/** Every value in the list is an object of scalars (for a grid). */
export function flatList(v: unknown): v is Record<string, unknown>[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (x) =>
        isObj(x) &&
        Object.values(x).every((y) => y === null || typeof y !== 'object' || (isObj(y) && Object.keys(y).length === 1 && Object.keys(y)[0].startsWith('$'))),
    )
  );
}

/** The paragraph around `pos` (lines up to blank ones): a mongosh block. */
export function paragraphAt(text: string, pos: number): string {
  const lines = text.split('\n');
  let at = 0;
  let line = 0;
  for (; line < lines.length; line++) {
    if (pos <= at + lines[line].length) break;
    at += lines[line].length + 1;
  }
  line = Math.min(line, lines.length - 1);
  // On a blank line: the paragraph just above.
  while (line > 0 && !lines[line].trim()) line--;
  let from = line;
  let to = line;
  while (from > 0 && lines[from - 1].trim()) from--;
  while (to < lines.length - 1 && lines[to + 1].trim()) to++;
  return lines.slice(from, to + 1).join('\n');
}

const REQUEST = /^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)\s+\S+\s*$/i;

/** The Dev Tools request around `pos`: its method line and its body. */
export function requestAt(text: string, pos: number): string {
  const lines = text.split('\n');
  let at = 0;
  let line = 0;
  for (; line < lines.length; line++) {
    if (pos <= at + lines[line].length) break;
    at += lines[line].length + 1;
  }
  line = Math.min(line, lines.length - 1);
  let from = line;
  while (from > 0 && !REQUEST.test(lines[from])) from--;
  if (!REQUEST.test(lines[from])) {
    // Above the first request: the first one.
    from = lines.findIndex((l) => REQUEST.test(l));
    if (from < 0) return text;
  }
  let to = from + 1;
  while (to < lines.length && !REQUEST.test(lines[to])) to++;
  return lines.slice(from, to).join('\n');
}
