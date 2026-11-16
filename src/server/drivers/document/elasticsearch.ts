// Elasticsearch and OpenSearch, over their REST API: a user and password or
// an API key, any certificate when asked. The tree is the indices (with
// their documents and size), then aliases and the system (dot) indices in
// folders of their own. An index's documents are searched with a query DSL
// or a query string; the console sends Dev Tools’ requests (devtools.ts).

import { PluginError } from '@hyperpane/sdk/server';
import type { DocFindRequest, DocFindResult, CommandResult } from '../../../shared/document.ts';
import type { Ref, TreeNode } from '../../../shared/types.ts';
import { basic, json, request, statusError } from '../../net/http.ts';
import { since } from '../cells.ts';
import type { DocumentDriver, Factory } from '../types.ts';
import { parseDevTools } from './devtools.ts';
import { parseRelaxed } from './relaxed.ts';
import { tlsOf } from '../../net/tls.ts';

const ALIASES = '_aliases';
const SYSTEM = '_system';

interface CatIndex {
  index: string;
  'docs.count'?: string | null;
  'store.size'?: string | null;
  health?: string;
  status?: string;
}

const formatSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;

function indexNode(i: CatIndex): TreeNode {
  const docs = i['docs.count'] ? Number(i['docs.count']).toLocaleString('en-US') : null;
  const size = i['store.size'] ? formatSize(Number(i['store.size'])) : null;
  const detail = [i.status === 'close' ? 'closed' : docs, size, i.health && i.health !== 'green' ? i.health : null].filter(Boolean).join(' · ');
  return {
    name: i.index,
    type: 'collection',
    detail: detail || undefined,
    leaf: true,
    open: { tab: 'collection', ref: { collection: i.index }, title: i.index },
  };
}

/** The sort as typed: JSON (`{"@timestamp": "desc"}`, `[…]`) or
 * `field:desc, other`. */
export function parseSort(text: string | undefined): unknown {
  const t = (text ?? '').trim();
  if (!t) return undefined;
  if (/^[[{]/.test(t)) return parseRelaxed(t);
  return t.split(',').map((part) => {
    const [field, dir] = part.trim().split(/\s*:\s*|\s+/);
    return { [field]: { order: /^desc/i.test(dir ?? '') ? 'desc' : 'asc' } };
  });
}

/** The fields to return as typed: JSON, or names by commas. */
function parseSource(text: string | undefined): unknown {
  const t = (text ?? '').trim();
  if (!t) return undefined;
  if (/^[[{]/.test(t)) return parseRelaxed(t);
  return t
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The search's body from the filter: a whole body ({query, aggs…}), a
 * query ({match: …}), or a query string (`status:500 AND path:/api`). */
export function searchBody(filter: string): Record<string, unknown> {
  const t = filter.trim().replace(/^q=/, '');
  if (!t) return { query: { match_all: {} } };
  if (t.startsWith('{')) {
    const v = parseRelaxed(t) as Record<string, unknown>;
    const BODY = ['query', 'aggs', 'aggregations', 'post_filter', 'knn', 'highlight', 'collapse', 'runtime_mappings', 'min_score'];
    return Object.keys(v).some((k) => BODY.includes(k)) ? v : { query: v };
  }
  return { query: { query_string: { query: t } } };
}

const strip = (doc: unknown): { id?: string; source: Record<string, unknown> } => {
  const parsed = typeof doc === 'string' ? parseRelaxed(doc) : doc;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PluginError('The document has to be an object: { … }.');
  const { _id, _index, _score, ...source } = parsed as Record<string, unknown>;
  return { id: _id === undefined || _id === null || _id === '' ? undefined : String(_id), source };
};

export const elasticsearch: Factory = (ctx) => {
  const v = ctx.values;
  const base = String(v.url || 'http://localhost:9200').replace(/\/+$/, '');
  const headers: Record<string, string> = v.apiKey ? { authorization: `ApiKey ${v.apiKey}` } : basic(v.user, v.password);
  const insecure = !!v.insecure;
  const tlsOpts = tlsOf(v);
  const call = <T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal) =>
    json<T>({ method, url: base + path, headers, json: body, insecure, tls: tlsOpts, signal, timeout: 60_000 });
  const idx = (ref: Ref) => {
    if (!ref.collection) throw new PluginError('Pick an index.');
    return encodeURIComponent(ref.collection);
  };
  let flavor = 'Elasticsearch';

  const driver: DocumentDriver = {
    family: 'document',

    async info() {
      const r = await call<{ version?: { number?: string; distribution?: string }; cluster_name?: string; tagline?: string }>('GET', '/');
      flavor = r.version?.distribution === 'opensearch' ? 'OpenSearch' : 'Elasticsearch';
      return { version: `${flavor} ${r.version?.number ?? ''}`.trim(), detail: r.cluster_name ? `cluster ${r.cluster_name}` : undefined };
    },

    async children(path) {
      if (path.length === 0 || path[0] === SYSTEM) {
        const all = await call<CatIndex[]>('GET', '/_cat/indices?format=json&bytes=b&h=index,docs.count,store.size,health,status&expand_wildcards=all');
        all.sort((a, b) => a.index.localeCompare(b.index));
        const system = all.filter((i) => i.index.startsWith('.'));
        if (path[0] === SYSTEM) return system.map(indexNode);
        const nodes = all.filter((i) => !i.index.startsWith('.')).map(indexNode);
        const aliases = await call<{ alias: string }[]>('GET', '/_cat/aliases?format=json&h=alias').catch(() => []);
        const visible = new Set(aliases.filter((a) => !a.alias.startsWith('.')).map((a) => a.alias));
        if (visible.size) nodes.push({ name: ALIASES, label: 'Aliases', type: 'folder', detail: String(visible.size) });
        if (system.length) nodes.push({ name: SYSTEM, label: 'System indices', type: 'folder', detail: String(system.length) });
        return nodes;
      }
      if (path[0] === ALIASES) {
        const aliases = await call<{ alias: string; index: string }[]>('GET', '/_cat/aliases?format=json&h=alias,index');
        const by = new Map<string, string[]>();
        for (const a of aliases) if (!a.alias.startsWith('.')) by.set(a.alias, [...(by.get(a.alias) ?? []), a.index]);
        return [...by]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([alias, indices]) => ({
            name: alias,
            type: 'collection' as const,
            detail: `→ ${indices.join(', ')}`,
            leaf: true,
            open: { tab: 'collection' as const, ref: { collection: alias }, title: alias },
          }));
      }
      return [];
    },

    async find(r: DocFindRequest, signal) {
      const t0 = performance.now();
      const body: Record<string, unknown> = { ...searchBody(r.filter), from: Math.max(0, r.skip), size: Math.max(0, r.limit), track_total_hits: true };
      const sort = parseSort(r.sort);
      if (sort !== undefined) body.sort = sort;
      const source = parseSource(r.projection);
      if (source !== undefined) body._source = source;
      const res = await call<{
        hits: {
          total?: { value: number } | number;
          hits: { _id: string; _index: string; _source?: Record<string, unknown>; fields?: Record<string, unknown> }[];
        };
        aggregations?: unknown;
      }>('POST', `/${idx(r.ref)}/_search`, body, signal);
      const total = typeof res.hits.total === 'number' ? res.hits.total : (res.hits.total?.value ?? null);
      const docs = res.hits.hits.map((h) => ({
        _id: h._id,
        ...(h._index !== r.ref.collection ? { _index: h._index } : {}),
        ...(h._source ?? {}),
        ...(h.fields && !h._source ? { fields: h.fields } : {}),
      }));
      const result: DocFindResult = {
        docs,
        total,
        ms: since(t0),
        idFields: ['_id'],
        query: `POST /${r.ref.collection}/_search\n${JSON.stringify(body, null, 2)}`,
      };
      return result;
    },

    async insert(ref, doc) {
      const { id, source } = strip(doc);
      const r = id
        ? await call<{ _id: string }>('PUT', `/${idx(ref)}/_create/${encodeURIComponent(id)}?refresh=true`, source)
        : await call<{ _id: string }>('POST', `/${idx(ref)}/_doc?refresh=true`, source);
      return { _id: r._id };
    },

    async replace(ref, id, doc) {
      const key = id._id;
      if (key === undefined || key === null) throw new PluginError('The document has no _id.');
      const { id: given, source } = strip(doc);
      if (given !== undefined && given !== String(key)) throw new PluginError('A document’s _id can’t change: duplicate it, then delete this one.');
      const index = typeof id._index === 'string' ? encodeURIComponent(id._index) : idx(ref);
      await call('PUT', `/${index}/_doc/${encodeURIComponent(String(key))}?refresh=true`, source);
    },

    async remove(ref, ids) {
      if (!ids.length) return 0;
      const lines = `${ids.map((i) => JSON.stringify({ delete: { _index: typeof i._index === 'string' ? i._index : ref.collection, _id: String(i._id) } })).join('\n')}\n`;
      const res = await request({
        method: 'POST',
        url: `${base}/_bulk?refresh=true`,
        headers: { ...headers, 'content-type': 'application/x-ndjson', accept: 'application/json' },
        body: lines,
        insecure,
        tls: tlsOpts,
      });
      const text = res.body.toString('utf8');
      if (res.status >= 400) throw new PluginError(statusError(res.status, text));
      const r = JSON.parse(text) as { items: { delete: { result?: string; status: number } }[] };
      return r.items.filter((x) => x.delete.result === 'deleted').length;
    },

    async command(o) {
      const t0 = performance.now();
      let last: CommandResult = { result: null, ms: 0 };
      for (const req of parseDevTools(o.text)) {
        const res = await request({
          method: req.method,
          url: base + req.path,
          headers: {
            ...headers,
            accept: 'application/json, text/plain;q=0.9',
            ...(req.body ? { 'content-type': req.ndjson ? 'application/x-ndjson' : 'application/json' } : {}),
          },
          body: req.body ?? null,
          insecure,
          tls: tlsOpts,
          signal: o.signal,
          timeout: 120_000,
        });
        const text = res.body.toString('utf8');
        const type = String(res.headers['content-type'] ?? '');
        let result: unknown = text;
        let isText = true;
        if (/json/.test(type) || /^\s*[[{]/.test(text)) {
          try {
            result = JSON.parse(text);
            isText = false;
          } catch {}
        }
        if (req.method === 'HEAD') result = `${res.status} ${res.status < 300 ? 'exists' : 'not found'}`;
        last = { result, ms: 0, status: res.status, text: isText || undefined };
      }
      return { ...last, ms: since(t0) };
    },

    async close() {},
  };
  return driver;
};
