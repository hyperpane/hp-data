// mongosh's statements (shell.ts), run with the driver: a collection's
// methods and the cursor's, db's own (runCommand, createCollection…), show
// and use. What the last statement gives is the result; `use` says the
// database the console is in now.

import { BSON, type Document, type FindCursor, type AggregationCursor, type MongoClient } from 'mongodb';
import { PluginError } from '@hyperpane/sdk/server';
import { parseShell, type ShellCall, type Statement } from './shell.ts';

const { EJSON } = BSON;
/** A find without a limit shows this many, as mongosh shows 20. */
const FIND_LIMIT = 100;
/** What's read from any cursor, at most. */
const MAX_DOCS = 5000;

const bson = (v: unknown): any => (v === undefined ? undefined : EJSON.deserialize(v as Document, { relaxed: false }));
const obj = (v: unknown, what: string): Document => {
  if (v === undefined) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PluginError(`${what} takes an object: { key: value }`);
  return bson(v);
};

async function drain(cursor: FindCursor | AggregationCursor, signal: AbortSignal): Promise<Document[]> {
  const abort = () => void cursor.close().catch(() => {});
  signal.addEventListener('abort', abort, { once: true });
  try {
    const out: Document[] = [];
    for await (const d of cursor) {
      out.push(d);
      if (out.length >= MAX_DOCS) break;
    }
    if (signal.aborted) throw new PluginError('Cancelled.');
    return out;
  } finally {
    signal.removeEventListener('abort', abort);
    void cursor.close().catch(() => {});
  }
}

async function onDb(client: MongoClient, database: string, calls: ShellCall[]): Promise<unknown> {
  const db = client.db(database);
  if (!calls.length) return database;
  if (calls.length > 1) throw new PluginError(`Nothing can follow db.${calls[0].name}().`);
  const { name, args } = calls[0];
  const a = args.map(bson);
  switch (name) {
    case 'runCommand':
      return db.command(typeof a[0] === 'string' ? { [a[0]]: 1 } : obj(args[0], 'runCommand'));
    case 'adminCommand':
      return client.db('admin').command(typeof a[0] === 'string' ? { [a[0]]: 1 } : obj(args[0], 'adminCommand'));
    case 'getName':
      return database;
    case 'getCollectionNames':
      return (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
    case 'getCollectionInfos':
      return db.listCollections(obj(args[0], 'getCollectionInfos')).toArray();
    case 'createCollection':
      await db.createCollection(String(a[0]), a[1] ?? {});
      return { ok: 1 };
    case 'createView':
      await db.createCollection(String(a[0]), { viewOn: String(a[1]), pipeline: a[2] ?? [] });
      return { ok: 1 };
    case 'dropDatabase':
      return { ok: (await db.dropDatabase()) ? 1 : 0, dropped: database };
    case 'stats':
      return db.command({ dbStats: 1, scale: a[0] ?? 1 });
    case 'serverStatus':
      return db.command({ serverStatus: 1 });
    case 'hostInfo':
      return db.command({ hostInfo: 1 });
    case 'version':
      return (await db.command({ buildInfo: 1 })).version;
    case 'currentOp':
      return client.db('admin').command({ currentOp: 1, ...(a[0] ?? {}) });
    default:
      throw new PluginError(`db.${name}() isn’t something the console knows: try db.runCommand({ ping: 1 })`);
  }
}

const MODIFIERS = new Set([
  'sort',
  'limit',
  'skip',
  'project',
  'projection',
  'hint',
  'maxTimeMS',
  'collation',
  'batchSize',
  'comment',
  'toArray',
  'pretty',
  'count',
  'itcount',
  'size',
  'explain',
  'allowDiskUse',
]);

async function onCollection(client: MongoClient, database: string, collection: string, calls: ShellCall[], signal: AbortSignal): Promise<unknown> {
  const coll = client.db(database).collection(collection);
  const [first, ...rest] = calls;
  const a = first.args.map(bson);
  const cursorOnly = () => {
    if (rest.length) throw new PluginError(`Nothing can follow ${first.name}().`);
  };
  switch (first.name) {
    case 'find': {
      let cursor = coll.find(obj(first.args[0], 'find'), a[1] ? { projection: a[1] } : {});
      let limited = false;
      for (const m of rest) {
        if (!MODIFIERS.has(m.name)) throw new PluginError(`.${m.name}() isn’t something a find can be followed by here.`);
        const x = m.args.map(bson);
        if (m.name === 'sort') cursor = cursor.sort(x[0]);
        else if (m.name === 'limit') {
          cursor = cursor.limit(Number(x[0]));
          limited = true;
        } else if (m.name === 'skip') cursor = cursor.skip(Number(x[0]));
        else if (m.name === 'project' || m.name === 'projection') cursor = cursor.project(x[0]);
        else if (m.name === 'hint') cursor = cursor.hint(x[0]);
        else if (m.name === 'maxTimeMS') cursor = cursor.maxTimeMS(Number(x[0]));
        else if (m.name === 'collation') cursor = cursor.collation(x[0]);
        else if (m.name === 'batchSize') cursor = cursor.batchSize(Number(x[0]));
        else if (m.name === 'comment') cursor = cursor.comment(String(x[0]));
        else if (m.name === 'allowDiskUse') cursor = cursor.allowDiskUse();
        else if (m.name === 'count' || m.name === 'size' || m.name === 'itcount') return coll.countDocuments(obj(first.args[0], 'find'));
        else if (m.name === 'explain') return cursor.explain(x[0] ?? 'queryPlanner');
      }
      if (!limited) cursor = cursor.limit(FIND_LIMIT);
      return drain(cursor, signal);
    }
    case 'findOne':
      cursorOnly();
      return coll.findOne(obj(first.args[0], 'findOne'), a[1] ? { projection: a[1] } : {});
    case 'aggregate': {
      if (!Array.isArray(a[0])) throw new PluginError('aggregate takes a pipeline: [ { $match: { status: "paid" } } ]');
      const cursor = coll.aggregate(a[0], a[1] ?? {});
      for (const m of rest) {
        if (m.name === 'explain') return cursor.explain();
        if (m.name !== 'toArray' && m.name !== 'pretty') throw new PluginError(`.${m.name}() can’t follow aggregate() here.`);
      }
      return drain(cursor, signal);
    }
    case 'countDocuments':
    case 'count':
      cursorOnly();
      return coll.countDocuments(obj(first.args[0], first.name), a[1] ?? {});
    case 'estimatedDocumentCount':
      cursorOnly();
      return coll.estimatedDocumentCount();
    case 'distinct':
      cursorOnly();
      return coll.distinct(String(a[0]), obj(first.args[1], 'distinct'));
    case 'insertOne':
      cursorOnly();
      return coll.insertOne(obj(first.args[0], 'insertOne'));
    case 'insertMany':
    case 'insert': {
      cursorOnly();
      const docs = Array.isArray(a[0]) ? a[0] : [a[0]];
      return coll.insertMany(docs);
    }
    case 'updateOne':
    case 'updateMany':
    case 'replaceOne':
      cursorOnly();
      return coll[first.name](obj(first.args[0], first.name), a[1], a[2] ?? {});
    case 'deleteOne':
    case 'deleteMany':
      cursorOnly();
      return coll[first.name](obj(first.args[0], first.name));
    case 'findOneAndUpdate':
    case 'findOneAndReplace':
      cursorOnly();
      return coll[first.name](obj(first.args[0], first.name), a[1], { includeResultMetadata: false, ...(a[2] ?? {}) });
    case 'findOneAndDelete':
      cursorOnly();
      return coll.findOneAndDelete(obj(first.args[0], first.name), { includeResultMetadata: false, ...(a[1] ?? {}) });
    case 'bulkWrite':
      cursorOnly();
      return coll.bulkWrite(a[0], a[1] ?? {});
    case 'createIndex':
      cursorOnly();
      return coll.createIndex(a[0], a[1] ?? {});
    case 'getIndexes':
    case 'indexes':
      cursorOnly();
      return coll.indexes();
    case 'dropIndex':
      cursorOnly();
      return coll.dropIndex(a[0]);
    case 'drop':
      cursorOnly();
      return coll.drop();
    case 'renameCollection':
      cursorOnly();
      await coll.rename(String(a[0]));
      return { ok: 1 };
    case 'stats':
      cursorOnly();
      return client.db(database).command({ collStats: collection });
    default:
      throw new PluginError(`db.${collection}.${first.name}() isn’t something the console knows.`);
  }
}

async function run(client: MongoClient, s: Statement, database: string, signal: AbortSignal): Promise<{ result: unknown; database?: string }> {
  if (s.kind === 'use') return { result: `switched to db ${s.database}`, database: s.database };
  if (s.kind === 'show') {
    const what = s.what.toLowerCase();
    if (what === 'dbs' || what === 'databases') {
      const r = await client.db('admin').admin().listDatabases({ authorizedDatabases: true });
      return { result: r.databases.map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk ?? null, empty: d.empty ?? false })) };
    }
    if (what === 'collections' || what === 'tables')
      return { result: (await client.db(database).listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort() };
    if (what === 'users') return { result: (await client.db(database).command({ usersInfo: 1 })).users };
    if (what === 'roles') return { result: (await client.db(database).command({ rolesInfo: 1 })).roles };
    throw new PluginError(`“show ${s.what}” isn’t something the console knows: show dbs, show collections, show users, show roles.`);
  }
  const db = s.database ?? database;
  if (s.kind === 'db') return { result: await onDb(client, db, s.calls) };
  return { result: await onCollection(client, db, s.collection, s.calls, signal) };
}

/** Runs the statements in order: the last one's result. */
export async function runShell(client: MongoClient, text: string, database: string, signal: AbortSignal): Promise<{ result: unknown; database?: string }> {
  const statements = parseShell(text);
  let db = database;
  let switched: string | undefined;
  let result: unknown = null;
  for (const s of statements) {
    if (signal.aborted) throw new PluginError('Cancelled.');
    const r = await run(client, s, db, signal);
    if (r.database) db = switched = r.database;
    result = r.result;
  }
  return { result: result === undefined ? null : result, database: switched };
}
