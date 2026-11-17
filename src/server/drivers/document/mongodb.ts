// MongoDB, with the official driver: connects from the connection string
// when there is one, else from host, port, user and the rest. The tree is
// databases, then their collections and views; a collection's documents
// are found with a filter, a sort and a projection as typed (relaxed JSON
// with the shell's literals, relaxed.ts) and sent as relaxed Extended JSON.
// The console's lines are run by mongo-console.ts.

import { BSON, type Document, MongoClient, type MongoClientOptions } from 'mongodb';
import { PluginError } from '@hyperpane/sdk/server';
import type { Values } from '../../../shared/kinds.ts';
import type { DocFindRequest, DocFindResult } from '../../../shared/document.ts';
import type { Ref, TreeNode } from '../../../shared/types.ts';
import { since } from '../cells.ts';
import type { DocumentDriver, Factory } from '../types.ts';
import { runShell } from './mongo-console.ts';
import { parseObject, parseRelaxed } from './relaxed.ts';
import { tlsOf } from '../../net/tls.ts';

const { EJSON } = BSON;
const COUNT_MS = 3000;

/** The URI the fields make, when there isn't one. */
function uriOf(v: Values): string {
  if (v.uri) return String(v.uri);
  const host = String(v.host || 'localhost');
  const port = v.port ? `:${v.port}` : '';
  const auth = v.user ? `${encodeURIComponent(String(v.user))}${v.password ? `:${encodeURIComponent(String(v.password))}` : ''}@` : '';
  const q = new URLSearchParams();
  if (v.authSource) q.set('authSource', String(v.authSource));
  if (v.tls) q.set('tls', 'true');
  q.set('directConnection', 'true');
  return `mongodb://${auth}${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}${port}/${v.database ? encodeURIComponent(String(v.database)) : ''}?${q}`;
}

/** A driver's error, for the user. */
function mongoError(e: unknown, where: string): Error {
  if (e instanceof PluginError) return e;
  const err = e as Error & { code?: number; codeName?: string };
  const name = err?.name ?? '';
  if (name === 'MongoServerSelectionError' || name === 'MongoNetworkError' || name === 'MongoNetworkTimeoutError') {
    if (/ECONNREFUSED/.test(err.message)) return new PluginError(`Nothing answers at ${where}: is it running, on that port?`);
    if (/ENOTFOUND|EAI_AGAIN/.test(err.message)) return new PluginError(`There’s no host ${where.replace(/:\d+$/, '')}: check the name.`);
    return new PluginError(`${where} can’t be reached: ${err.message}`);
  }
  if (err?.code === 18 || /Authentication failed/i.test(err?.message ?? ''))
    return new PluginError('Signing in failed: check the user, the password and the auth database.');
  if (err?.code === 13) return new PluginError(`Not allowed: ${err.message}`);
  if (name === 'MongoParseError' || name === 'MongoInvalidArgumentError') return new PluginError(`The connection string isn’t right: ${err.message}`);
  if (name.startsWith('Mongo') || name === 'BSONError') return new PluginError(err.message);
  return err instanceof Error ? err : new Error(String(e));
}

/** Typed text as BSON-ready values: relaxed JSON, then EJSON. */
const fromText = (text: string, what: string): Document => EJSON.deserialize(parseObject(text, what), { relaxed: false }) as Document;

/** A value from a window (text as typed, or EJSON) as BSON-ready values. */
function fromValue(v: unknown, what = 'document'): Document {
  const parsed = typeof v === 'string' ? parseRelaxed(v) : v;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PluginError(`The ${what} has to be an object: { key: value }`);
  return EJSON.deserialize(parsed as Document, { relaxed: false }) as Document;
}

/** BSON as relaxed EJSON, which JSON carries. */
const toJson = (v: unknown): unknown => EJSON.serialize(v, { relaxed: true });

const formatSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;

export const mongodb: Factory = (ctx) => {
  const v = ctx.values;
  const uri = uriOf(v);
  let where = `${v.host || 'localhost'}:${v.port || 27017}`;
  if (v.uri) {
    try {
      where = new URL(String(v.uri).replace(/^mongodb(\+srv)?:/, 'http:')).host || where;
    } catch {}
  }
  const own = tlsOf(v);
  const options: MongoClientOptions = {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    appName: 'hyperpane-data',
    ...(own.ca ? { ca: own.ca } : {}),
    ...(own.cert ? { cert: own.cert, key: own.key, passphrase: own.passphrase } : {}),
    ...(own.servername ? { servername: own.servername } : {}),
  };
  if (v.tls && !v.uri) options.tls = true;
  let client: MongoClient | null = null;
  let connecting: Promise<MongoClient> | null = null;
  const only = v.database ? String(v.database) : null;

  const connect = (): Promise<MongoClient> => {
    if (client) return Promise.resolve(client);
    connecting ??= (async () => {
      try {
        const c = new MongoClient(uri, options);
        await c.connect();
        client = c;
        return c;
      } catch (e) {
        throw mongoError(e, where);
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  };

  const guard = async <T>(fn: (c: MongoClient) => Promise<T>): Promise<T> => {
    const c = await connect();
    try {
      return await fn(c);
    } catch (e) {
      throw mongoError(e, where);
    }
  };

  const collectionOf = (c: MongoClient, ref: Ref) => {
    if (!ref.collection) throw new PluginError('Pick a collection.');
    return c.db(ref.database || only || 'test').collection(ref.collection);
  };

  const idFilter = (id: Record<string, unknown>): Document => {
    const f = fromValue(id, 'id');
    if (!('_id' in f)) throw new PluginError('The document has no _id.');
    return { _id: f._id };
  };

  const driver: DocumentDriver = {
    family: 'document',

    async info() {
      return guard(async (c) => {
        const b = await c.db(only ?? 'admin').command({ buildInfo: 1 });
        let user = '';
        try {
          const s = await c.db(only ?? 'admin').command({ connectionStatus: 1 });
          user = s.authInfo?.authenticatedUsers?.[0]?.user ?? '';
        } catch {}
        return { version: `MongoDB ${b.version}`, detail: [user && `as ${user}`, where].filter(Boolean).join(' · ') };
      });
    },

    async children(path) {
      return guard(async (c) => {
        if (path.length === 0) {
          let dbs: { name: string; sizeOnDisk?: number }[];
          if (only) dbs = [{ name: only }];
          else {
            const r = await c.db('admin').admin().listDatabases({ nameOnly: false, authorizedDatabases: true });
            dbs = r.databases as { name: string; sizeOnDisk?: number }[];
          }
          return dbs
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((d): TreeNode => ({ name: d.name, type: 'database', detail: d.sizeOnDisk ? formatSize(d.sizeOnDisk) : undefined, expand: dbs.length === 1 }));
        }
        if (path.length === 1) {
          const db = c.db(path[0]);
          const list = (await db.listCollections({}, { nameOnly: false, authorizedCollections: true }).toArray()).sort((a, b) => a.name.localeCompare(b.name));
          const counts = await Promise.all(
            list.map((x) =>
              x.type === 'collection' && list.length <= 200
                ? db
                    .collection(x.name)
                    .estimatedDocumentCount({ maxTimeMS: 2000 })
                    .catch(() => null)
                : Promise.resolve(null),
            ),
          );
          return list.map((x, i): TreeNode => {
            const n = counts[i];
            return {
              name: x.name,
              type: x.type === 'view' ? 'view' : 'collection',
              detail: x.type === 'view' ? 'view' : x.type === 'timeseries' ? 'time series' : n === null ? undefined : n.toLocaleString('en-US'),
              leaf: true,
              open: { tab: 'collection', ref: { database: path[0], collection: x.name }, title: x.name },
            };
          });
        }
        return [];
      });
    },

    async find(r: DocFindRequest, signal) {
      return guard(async (c) => {
        const t0 = performance.now();
        const coll = collectionOf(c, r.ref);
        const filter = fromText(r.filter, 'filter');
        const sort = fromText(r.sort ?? '', 'sort');
        const projection = fromText(r.projection ?? '', 'projection');
        const cursor = coll.find(filter, { sort, projection, skip: Math.max(0, r.skip), limit: Math.max(1, r.limit) });
        const abort = () => void cursor.close().catch(() => {});
        signal.addEventListener('abort', abort, { once: true });
        try {
          const [docs, total] = await Promise.all([
            cursor.toArray(),
            (Object.keys(filter).length ? coll.countDocuments(filter, { maxTimeMS: COUNT_MS }) : coll.estimatedDocumentCount({ maxTimeMS: COUNT_MS })).catch(
              () => null,
            ),
          ]);
          if (signal.aborted) throw new PluginError('Cancelled.');
          const parts = [
            `db.getCollection(${JSON.stringify(coll.collectionName)}).find(${r.filter.trim() || '{}'}${r.projection?.trim() ? `, ${r.projection.trim()}` : ''})`,
          ];
          if (r.sort?.trim()) parts.push(`.sort(${r.sort.trim()})`);
          if (r.skip) parts.push(`.skip(${r.skip})`);
          parts.push(`.limit(${r.limit})`);
          const result: DocFindResult = { docs: toJson(docs) as unknown[], total, ms: since(t0), idFields: ['_id'], query: parts.join('') };
          return result;
        } finally {
          signal.removeEventListener('abort', abort);
        }
      });
    },

    async insert(ref, doc) {
      return guard(async (c) => {
        const r = await collectionOf(c, ref).insertOne(fromValue(doc));
        return toJson({ _id: r.insertedId });
      });
    },

    async replace(ref, id, doc) {
      return guard(async (c) => {
        const d = fromValue(doc);
        const filter = idFilter(id);
        if ('_id' in d && EJSON.stringify(d._id) !== EJSON.stringify(filter._id))
          throw new PluginError('A document’s _id can’t change: duplicate it, then delete this one.');
        delete d._id;
        const r = await collectionOf(c, ref).replaceOne(filter, d);
        if (!r.matchedCount) throw new PluginError('That document isn’t there anymore: refresh.');
      });
    },

    async remove(ref, ids) {
      return guard(async (c) => {
        if (!ids.length) return 0;
        const r = await collectionOf(c, ref).deleteMany({ _id: { $in: ids.map((i) => idFilter(i)._id) } });
        return r.deletedCount;
      });
    },

    async command(o) {
      return guard(async (c) => {
        const t0 = performance.now();
        const out = await runShell(c, o.text, o.database || only || 'test', o.signal);
        return { ...out, result: toJson(out.result), ms: since(t0) };
      });
    },

    async close() {
      const c = client ?? (connecting ? await connecting.catch(() => null) : null);
      client = null;
      await c?.close();
    },
  };
  return driver;
};
