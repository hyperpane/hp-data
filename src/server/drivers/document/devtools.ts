// Kibana Dev Tools’ requests, read: a line `GET /_cat/indices?v` or
// `POST /logs/_search`, then its body: one JSON (relaxed, as typed) or
// several, a line each, for _bulk and _msearch. Lines starting with # are
// comments. Pure: elasticsearch.ts sends them.

import { PluginError } from '@hyperpane/sdk/server';
import { Reader } from './relaxed.ts';

export interface DevRequest {
  method: string;
  /** With its query, starting with '/'. */
  path: string;
  /** JSON text, or NDJSON (ending in a newline) when `ndjson`. */
  body?: string;
  ndjson?: boolean;
}

const LINE = /^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)\s+(\S+)\s*$/i;

/** The requests in the text, in order. */
export function parseDevTools(text: string): DevRequest[] {
  const out: (DevRequest & { lines: string[]; at: number })[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = LINE.exec(line);
    if (m) {
      const path = m[2].startsWith('/') ? m[2] : `/${m[2]}`;
      out.push({ method: m[1].toUpperCase(), path, lines: [], at: i + 1 });
      return;
    }
    const last = out[out.length - 1];
    if (!last) {
      if (line.trim() && !/^\s*(#|\/\/)/.test(line)) throw new PluginError(`Line ${i + 1}: a request starts with a method and a path: GET /_cat/indices?v`);
      return;
    }
    last.lines.push(/^\s*#/.test(line) ? '' : line);
  });
  if (!out.length) throw new PluginError('Type a request to send: GET /_cat/indices?v');
  return out.map(({ lines, at, ...req }) => {
    const text = lines.join('\n').trim();
    if (!text) return req;
    const r = new Reader(text);
    const values: unknown[] = [];
    try {
      while (!r.done) values.push(r.value());
    } catch (e) {
      throw new PluginError(`The body of ${req.method} ${req.path} (line ${at}): ${(e as Error).message}`);
    }
    if (values.length === 1 && !/\/_(bulk|msearch)\b/.test(req.path)) return { ...req, body: JSON.stringify(values[0]) };
    return { ...req, body: `${values.map((v) => JSON.stringify(v)).join('\n')}\n`, ndjson: true };
  });
}

const READS = /\/_(search|count|msearch|mget|analyze|explain|validate|field_caps|sql|ppl|render|termvectors|mtermvectors|search_shards|rank_eval|knn_search|eql\/search)\b/;

/** One of them changes something (as far as can be told). */
export function devToolsWrites(text: string): boolean {
  let reqs: DevRequest[];
  try {
    reqs = parseDevTools(text);
  } catch {
    return false;
  }
  return reqs.some((r) => r.method !== 'GET' && r.method !== 'HEAD' && !(r.method === 'POST' && READS.test(r.path.split('?')[0])));
}
