// Keys as a bucket browser sees them: a folder is a prefix ending in '/',
// a key's name is its last part, a prefix's crumbs lead back to the
// bucket; what a file is by its type or name (text, JSON, an image); and
// the rows of the list, sorted, folders first.

import type { ListResult } from '../../../shared/object.ts';

export interface Row {
  /** The full key ('photos/' for a folder). */
  key: string;
  folder: boolean;
  /** What the list shows: the last part, or the path under the prefix
   * when flat. */
  name: string;
  size: number | null;
  modified: number | null;
  storageClass?: string;
  etag?: string;
}

export type SortColumn = 'name' | 'size' | 'modified' | 'class';
export interface Sort {
  column: SortColumn;
  desc: boolean;
}

export const isFolder = (key: string) => key.endsWith('/');

/** The last part of a key, a folder's without its '/'. */
export const nameOf = (key: string) => key.replace(/\/$/, '').split('/').pop() || key;

/** The folder a key is in ('' at the top). */
export function parentOf(key: string): string {
  const k = key.replace(/\/$/, '');
  const i = k.lastIndexOf('/');
  return i < 0 ? '' : k.slice(0, i + 1);
}

/** The prefix's folders, from the top: name and prefix of each. */
export function crumbs(prefix: string): { name: string; prefix: string }[] {
  const out: { name: string; prefix: string }[] = [];
  let at = '';
  for (const part of prefix.split('/').slice(0, -1)) {
    at += `${part}/`;
    out.push({ name: part || '(empty)', prefix: at });
  }
  return out;
}

export function rowsOf(pages: ListResult[], prefix: string, flat: boolean): Row[] {
  const rows: Row[] = [];
  for (const p of pages) {
    for (const f of p.prefixes) rows.push({ key: f, folder: true, name: nameOf(f), size: null, modified: null });
    for (const o of p.objects)
      rows.push({
        key: o.key,
        folder: false,
        name: flat ? o.key.slice(prefix.length) : nameOf(o.key),
        size: o.size,
        modified: o.modified,
        storageClass: o.storageClass,
        etag: o.etag,
      });
  }
  return rows;
}

const collator = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });

export function sortRows(rows: Row[], s: Sort): Row[] {
  const dir = s.desc ? -1 : 1;
  const by = (a: Row, b: Row): number => {
    switch (s.column) {
      case 'size':
        return ((a.size ?? -1) - (b.size ?? -1)) * dir;
      case 'modified':
        return ((a.modified ?? 0) - (b.modified ?? 0)) * dir;
      case 'class':
        return collator.compare(a.storageClass ?? '', b.storageClass ?? '') * dir;
      default:
        return 0;
    }
  };
  return [...rows].sort((a, b) =>
    a.folder !== b.folder ? (a.folder ? -1 : 1) : by(a, b) || collator.compare(a.name, b.name) * (s.column === 'name' ? dir : 1),
  );
}

const ext = (key: string) => /\.([a-z0-9]+)$/i.exec(key)?.[1].toLowerCase() ?? '';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const TEXT = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'log',
  'xml',
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'env',
  'sh',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'sql',
  'graphql',
  'proto',
  'tf',
  'json',
  'jsonl',
  'ndjson',
  'geojson',
  'map',
  'svg',
  'srt',
  'vtt',
]);

export type Shown = 'image' | 'json' | 'text' | 'unknown';

/** How a file is previewed, by its content type and its name. */
export function shownAs(key: string, contentType: string | null): Shown {
  const t = (contentType ?? '').toLowerCase().split(';')[0].trim();
  const e = ext(key);
  if (t.startsWith('image/') || (IMAGE.has(e) && (!t || t === 'application/octet-stream' || t === 'binary/octet-stream'))) return 'image';
  if (t.includes('json') || e === 'json' || e === 'geojson' || e === 'map') return 'json';
  if (t.startsWith('text/') || /xml|javascript|yaml|toml|csv|x-sh|sql/.test(t) || TEXT.has(e)) return 'text';
  return 'unknown';
}

/** Whether bytes read as text: valid UTF-8 and no NULs. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.length < bytes.length ? trimPartial(head) : head);
    return true;
  } catch {
    return false;
  }
}

/** Without a UTF-8 sequence cut off at the end. */
function trimPartial(b: Uint8Array): Uint8Array {
  let i = b.length - 1;
  let back = 0;
  while (i >= 0 && back < 4 && (b[i] & 0xc0) === 0x80) {
    i--;
    back++;
  }
  return i >= 0 && b[i] >= 0xc0 ? b.subarray(0, i) : b;
}

/** A content type for a file put without one, by its name. */
export function typeFor(name: string, given: string): string {
  if (given) return given;
  const map: Record<string, string> = {
    json: 'application/json',
    md: 'text/markdown',
    csv: 'text/csv',
    txt: 'text/plain',
    log: 'text/plain',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    avif: 'image/avif',
    wasm: 'application/wasm',
    gz: 'application/gzip',
    parquet: 'application/vnd.apache.parquet',
  };
  return map[ext(name)] ?? '';
}
