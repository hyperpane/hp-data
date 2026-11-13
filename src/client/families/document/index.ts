// The document family's tabs (a collection, a console) and its tree
// items' menus: open a console; make a database, collection, index or
// table; drop one (asked first). The changes are console text run on the
// server (docCommand), so they're refused there too on read-only
// connections.

import type { MenuEntry } from '@hyperpane/ui';
import type { TreeActions, TreeContext, Views } from '../../app/tabs.ts';
import { CollectionView } from './collection.tsx';
import { ConsoleView } from './console.tsx';

export const views: Views = {
  collection: CollectionView,
  console: ConsoleView,
};

const q = (s: string) => JSON.stringify(s);

async function exec(c: TreeContext, text: string, done: string, database?: string) {
  try {
    await c.api.call('docCommand', { id: c.connection.id, project: c.project, database, text });
    c.api.toast(done);
    c.refresh();
  } catch (e) {
    c.api.fail(e);
  }
}

function openConsole(c: TreeContext, database?: string, text?: string): MenuEntry {
  return {
    label: 'Open Console',
    run: () => c.open({ type: 'console', conn: c.connection.id, ref: database ? { database } : {}, title: database ? `Console · ${database}` : 'Console', state: text ? { text } : undefined }),
  };
}

function mongo(c: TreeContext): (MenuEntry | null)[] {
  const { node, path, api } = c;
  const newCollection = (db?: string): MenuEntry => ({
    label: db ? 'New Collection…' : 'New Database…',
    run: async () => {
      const database = db ?? (await api.prompt('New database', 'Database', '', 'shop'))?.trim();
      if (!database) return;
      const name = (await api.prompt(db ? `New collection in ${db}` : `The first collection in ${database}`, 'Collection', '', 'users'))?.trim();
      if (name) await exec(c, `db.getSiblingDB(${q(database)}).createCollection(${q(name)})`, `Made ${database}.${name}.`);
    },
  });
  if (!node) return [openConsole(c), ...(c.readOnly ? [] : [null, newCollection()])];
  if (node.type === 'database') {
    const db = path[0];
    return [
      openConsole(c, db),
      ...(c.readOnly
        ? []
        : [
            null,
            newCollection(db),
            null,
            {
              label: 'Drop Database…',
              danger: true,
              run: async () => {
                if (await api.confirm(`Drop ${db}?`, `The database ${db} and every collection in it will be deleted. This can’t be undone.`, 'Drop', true)) await exec(c, `db.getSiblingDB(${q(db)}).dropDatabase()`, `Dropped ${db}.`);
              },
            },
          ]),
    ];
  }
  const [db, coll] = path;
  return [
    openConsole(c, db, `db.getCollection(${q(coll)}).find({}).limit(20)\n`),
    ...(c.readOnly || node.type === 'view'
      ? []
      : [
          null,
          {
            label: 'New Index…',
            run: async () => {
              const keys = (await api.prompt(`New index on ${coll}`, 'Keys', '{ field: 1 }', '{ email: 1 }  ·  { name: "text" }'))?.trim();
              if (keys) await exec(c, `db.getSiblingDB(${q(db)}).getCollection(${q(coll)}).createIndex(${keys})`, `Made the index on ${coll}.`);
            },
          },
        ]),
    ...(c.readOnly
      ? []
      : [
          null,
          {
            label: node.type === 'view' ? 'Drop View…' : 'Drop Collection…',
            danger: true,
            run: async () => {
              if (await api.confirm(`Drop ${coll}?`, `${db}.${coll} and every document in it will be deleted. This can’t be undone.`, 'Drop', true)) await exec(c, `db.getSiblingDB(${q(db)}).getCollection(${q(coll)}).drop()`, `Dropped ${coll}.`);
            },
          },
        ]),
  ];
}

function search(c: TreeContext): (MenuEntry | null)[] {
  const { node, path, api } = c;
  const newIndex: MenuEntry = {
    label: 'New Index…',
    run: async () => {
      const name = (await api.prompt('New index', 'Name', '', 'logs-2026.11'))?.trim();
      if (name) await exec(c, `PUT /${encodeURIComponent(name)}`, `Made ${name}.`);
    },
  };
  if (!node || node.type === 'folder') return [openConsole(c), ...(c.readOnly || node ? [] : [null, newIndex])];
  const index = path[path.length - 1];
  const alias = path[0] === '_aliases';
  return [
    openConsole(c, undefined, `POST /${index}/_search\n{\n  "query": { "match_all": {} },\n  "size": 20\n}\n`),
    ...(c.readOnly || alias
      ? []
      : [
          null,
          newIndex,
          null,
          {
            label: 'Delete Index…',
            danger: true,
            run: async () => {
              if (await api.confirm(`Delete ${index}?`, `The index ${index} and every document in it will be deleted. This can’t be undone.`, 'Delete', true)) await exec(c, `DELETE /${encodeURIComponent(index)}`, `Deleted ${index}.`);
            },
          },
        ]),
  ];
}

function dynamo(c: TreeContext): (MenuEntry | null)[] {
  const { node, path, api } = c;
  const newTable: MenuEntry = {
    label: 'New Table…',
    run: async () => {
      const name = (await api.prompt('New table', 'Name', '', 'orders'))?.trim();
      if (!name) return;
      const key = (await api.prompt(`The key of ${name}`, 'Partition key, then a sort key if any (strings)', 'id', 'customer, placed'))?.trim();
      if (!key) return;
      const [hash, range] = key.split(',').map((s) => s.trim()).filter(Boolean);
      const attrs = [hash, range].filter(Boolean).map((a) => ({ AttributeName: a, AttributeType: 'S' }));
      const schema = [{ AttributeName: hash, KeyType: 'HASH' }, ...(range ? [{ AttributeName: range, KeyType: 'RANGE' }] : [])];
      await exec(c, `CreateTable ${JSON.stringify({ TableName: name, AttributeDefinitions: attrs, KeySchema: schema, BillingMode: 'PAY_PER_REQUEST' })}`, `Made ${name}.`);
    },
  };
  if (!node) return [openConsole(c), ...(c.readOnly ? [] : [null, newTable])];
  const table = path[path.length - 1];
  return [
    openConsole(c, undefined, `SELECT * FROM ${q(table)}\n`),
    ...(c.readOnly
      ? []
      : [
          null,
          newTable,
          null,
          {
            label: 'Delete Table…',
            danger: true,
            run: async () => {
              if (await api.confirm(`Delete ${table}?`, `The table ${table} and every item in it will be deleted. This can’t be undone.`, 'Delete', true)) await exec(c, `DeleteTable ${JSON.stringify({ TableName: table })}`, `Deleted ${table}.`);
            },
          },
        ]),
  ];
}

export const actions: TreeActions = (c) => {
  const engine = c.kind.engine;
  if (engine === 'mongodb') return mongo(c);
  if (engine === 'elasticsearch') return search(c);
  if (engine === 'dynamodb') return dynamo(c);
  return [];
};
