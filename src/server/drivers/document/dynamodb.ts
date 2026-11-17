// DynamoDB, over its JSON API signed with SigV4 (no SDK), on AWS or at an
// endpoint (DynamoDB Local). The tree is the tables; a table's items are
// read with PartiQL (SELECT … WHERE the filter as typed), a page at a time
// by NextToken, and shown as plain JSON (dynamo-json.ts). The console runs
// PartiQL, or one of the API's operations as `DescribeTable {…}`.

import { PluginError } from '@hyperpane/sdk/server';
import type { CommandResult, DocFindRequest, DocFindResult } from '../../../shared/document.ts';
import type { Ref, TreeNode } from '../../../shared/types.ts';
import { awsError, type Credentials, credentialsOf, sha256hex, sign } from '../../aws/sigv4.ts';
import { request } from '../../net/http.ts';
import { since } from '../cells.ts';
import type { DocumentDriver, Factory } from '../types.ts';
import { type Item, marshall, unmarshall } from './dynamo-json.ts';
import { parseRelaxed } from './relaxed.ts';

interface TableDescription {
  TableName: string;
  TableStatus?: string;
  ItemCount?: number;
  TableSizeBytes?: number;
  KeySchema?: { AttributeName: string; KeyType: 'HASH' | 'RANGE' }[];
}

/** A name in PartiQL: "name", quotes doubled. */
const quoteName = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** PartiQL statements by `;`, quotes taken into account. */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (const c of text) {
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"') q = c;
    else if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The SELECT a table's page is read with. */
export function selectOf(table: string, filter: string, projection?: string): string {
  const f = filter.trim();
  if (/^select\b/i.test(f)) return f;
  const fields = (projection ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^".*"$/.test(s) ? s : quoteName(s)));
  return `SELECT ${fields.length ? fields.join(', ') : '*'} FROM ${quoteName(table)}${f ? ` WHERE ${f.replace(/^where\s+/i, '')}` : ''}`;
}

const RAW = /^\s*([A-Z][A-Za-z]+)\s*(\{[\s\S]*\})?\s*$/;
const PARTIQL = /^(SELECT|INSERT|UPDATE|DELETE|EXISTS)$/i;
const RAW_WRITES =
  /^(Put|Delete|Update|Create|BatchWrite|TransactWrite|Restore|Tag|Untag|Import|Enable|Disable|ExecuteStatement|BatchExecuteStatement|ExecuteTransaction)/;

/** It changes something (as far as can be told). */
export function partiqlWrites(text: string): boolean {
  const raw = RAW.exec(text);
  if (raw && !PARTIQL.test(raw[1])) return RAW_WRITES.test(raw[1]);
  return splitStatements(text).some((s) => /^\s*(insert|update|delete)\b/i.test(s));
}

const formatSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;

export const dynamodb: Factory = (ctx) => {
  const v = ctx.values;
  const region = String(v.region || 'us-east-1');
  const endpoint = new URL(String(v.endpoint || `https://dynamodb.${region}.amazonaws.com`).replace(/\/*$/, '/'));
  const local = !!v.endpoint && /localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal/.test(endpoint.host);
  let creds: Promise<Credentials> | null = null;
  const credentials = () =>
    (creds ??= credentialsOf(v).catch((e) => {
      // DynamoDB Local takes any keys.
      if (local) return { accessKeyId: 'local', secretAccessKey: 'local' };
      creds = null;
      throw e;
    }));
  const keys = new Map<string, string[]>();

  const api = async <T = unknown>(op: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const text = JSON.stringify(body);
    const headers = sign({
      method: 'POST',
      url: endpoint,
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${op}` },
      payloadHash: sha256hex(text),
      region,
      service: 'dynamodb',
      credentials: await credentials(),
    });
    const res = await request({ method: 'POST', url: endpoint, headers, body: text, signal, timeout: 60_000 });
    const out = res.body.toString('utf8');
    if (res.status >= 400) {
      if (/ConditionalCheckFailed/.test(out)) throw new PluginError('An item with that key is already there.');
      throw new PluginError(awsError(res.status, out));
    }
    return (out ? JSON.parse(out) : {}) as T;
  };

  const tableOf = (ref: Ref) => {
    const t = ref.collection ?? ref.table;
    if (!t) throw new PluginError('Pick a table.');
    return t;
  };

  const describe = async (table: string): Promise<TableDescription> => {
    const d = (await api<{ Table: TableDescription }>('DescribeTable', { TableName: table })).Table;
    keys.set(
      table,
      [...(d.KeySchema ?? [])].sort((a, b) => (a.KeyType === 'HASH' ? -1 : b.KeyType === 'HASH' ? 1 : 0)).map((k) => k.AttributeName),
    );
    return d;
  };
  const keysOf = async (table: string) => {
    const known = keys.get(table);
    if (known) return known;
    await describe(table);
    return keys.get(table)!;
  };

  const asItem = (doc: unknown): Record<string, unknown> => {
    const parsed = typeof doc === 'string' ? parseRelaxed(doc) : doc;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PluginError('The item has to be an object: { "key": value }');
    return parsed as Record<string, unknown>;
  };
  const keyOf = async (table: string, doc: Record<string, unknown>) => {
    const names = await keysOf(table);
    const key: Record<string, unknown> = {};
    for (const n of names) {
      if (doc[n] === undefined || doc[n] === null) throw new PluginError(`The item needs its key: ${names.join(', ')}.`);
      key[n] = doc[n];
    }
    return key;
  };

  /** A statement's items, following NextToken up to `limit`. */
  const statement = async (Statement: string, limit: number, token: string | undefined, signal: AbortSignal) => {
    const items: Record<string, unknown>[] = [];
    let next = token;
    for (let round = 0; round < 20; round++) {
      if (signal.aborted) throw new PluginError('Cancelled.');
      const r = await api<{ Items?: Item[]; NextToken?: string }>(
        'ExecuteStatement',
        { Statement, Limit: Math.min(1000, limit - items.length), ...(next ? { NextToken: next } : {}) },
        signal,
      );
      items.push(...(r.Items ?? []).map(unmarshall));
      next = r.NextToken;
      if (!next || items.length >= limit) break;
    }
    return { items, next: next ?? null };
  };

  const driver: DocumentDriver = {
    family: 'document',

    async info() {
      await api('ListTables', { Limit: 1 });
      return { version: local ? 'DynamoDB Local' : 'DynamoDB', detail: v.endpoint ? endpoint.host : region };
    },

    async children(path) {
      if (path.length) return [];
      const names: string[] = [];
      let start: string | undefined;
      do {
        const r = await api<{ TableNames: string[]; LastEvaluatedTableName?: string }>('ListTables', start ? { ExclusiveStartTableName: start } : {});
        names.push(...r.TableNames);
        start = r.LastEvaluatedTableName;
      } while (start && names.length < 5000);
      const described = await Promise.all(names.map((n, i) => (i < 100 ? describe(n).catch(() => null) : Promise.resolve(null))));
      return names.map((name, i): TreeNode => {
        const d = described[i];
        const detail = d
          ? [
              d.ItemCount !== undefined ? d.ItemCount.toLocaleString('en-US') : null,
              d.TableSizeBytes ? formatSize(d.TableSizeBytes) : null,
              d.TableStatus && d.TableStatus !== 'ACTIVE' ? d.TableStatus.toLowerCase() : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : undefined;
        return { name, type: 'table', detail: detail || undefined, leaf: true, open: { tab: 'collection', ref: { collection: name }, title: name } };
      });
    },

    async find(r: DocFindRequest, signal) {
      const t0 = performance.now();
      const table = tableOf(r.ref);
      const [d, idFields] = await Promise.all([r.filter.trim() || r.token ? Promise.resolve(null) : describe(table).catch(() => null), keysOf(table)]);
      const query = selectOf(table, r.filter, r.projection);
      const { items, next } = await statement(query, Math.max(1, r.limit), r.token || undefined, signal);
      const result: DocFindResult = { docs: items, total: d?.ItemCount ?? null, ms: since(t0), idFields, next, query };
      return result;
    },

    async insert(ref, doc) {
      const table = tableOf(ref);
      const item = asItem(doc);
      const key = await keyOf(table, item);
      await api('PutItem', {
        TableName: table,
        Item: marshall(item),
        ConditionExpression: 'attribute_not_exists(#k)',
        ExpressionAttributeNames: { '#k': Object.keys(key)[0] },
      });
      return key;
    },

    async replace(ref, id, doc) {
      const table = tableOf(ref);
      const item = asItem(doc);
      const key = await keyOf(table, item);
      const was = await keyOf(table, id);
      const moved = JSON.stringify(key) !== JSON.stringify(was);
      if (moved) {
        await api('PutItem', {
          TableName: table,
          Item: marshall(item),
          ConditionExpression: 'attribute_not_exists(#k)',
          ExpressionAttributeNames: { '#k': Object.keys(key)[0] },
        });
        await api('DeleteItem', { TableName: table, Key: marshall(was) });
      } else await api('PutItem', { TableName: table, Item: marshall(item) });
    },

    async remove(ref, ids) {
      const table = tableOf(ref);
      let n = 0;
      for (const id of ids) {
        await api('DeleteItem', { TableName: table, Key: marshall(await keyOf(table, id)) });
        n++;
      }
      return n;
    },

    async command(o) {
      const t0 = performance.now();
      const raw = RAW.exec(o.text);
      if (raw && !PARTIQL.test(raw[1])) {
        const body = raw[2] ? parseRelaxed(raw[2]) : {};
        const result: CommandResult = { result: await api(raw[1], body as Record<string, unknown>, o.signal), ms: 0 };
        return { ...result, ms: since(t0) };
      }
      const statements = splitStatements(o.text);
      if (!statements.length) throw new PluginError('Type a statement: SELECT * FROM "table"');
      let result: unknown = null;
      for (const s of statements) {
        const r = await statement(s, 1000, undefined, o.signal);
        result = /^\s*select\b/i.test(s) ? r.items : { ok: true, statement: s };
      }
      return { result, ms: since(t0) };
    },

    async close() {},
  };
  return driver;
};
