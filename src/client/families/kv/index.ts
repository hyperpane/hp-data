// The kv family's tabs (Redis, Valkey, Dragonfly, etcd): keys and a
// console; and its entries in the tree's menu: on a database (or etcd's
// keyspace), a new key, a console, and emptying it.

import type { NewTab, TreeActions, TreeContext, Views } from '../../app/tabs.ts';
import type { KvReply } from '../../../shared/kv.ts';
import { ConsoleView } from './console.tsx';
import { KeysView } from './keys.tsx';

export const views: Views = {
  keys: KeysView,
  console: ConsoleView,
};

const consoleTab = (c: TreeContext, database?: string): NewTab => ({
  type: 'console',
  conn: c.connection.id,
  ref: database === undefined ? {} : { database },
  title: `${c.connection.name}${database && database !== '0' ? ` · db${database}` : ''}`,
});

export const actions: TreeActions = (c) => {
  const node = c.node;
  if (!node) return [{ label: 'Open Console', run: () => c.open(consoleTab(c)) }];
  if (node.type !== 'database' && node.type !== 'keyspace') return [];
  const database = node.open?.ref.database;
  const keys = node.open;
  const name = node.label ?? node.name;
  const etcd = c.kind.engine === 'etcd';
  return [
    keys && !c.readOnly ? { label: 'New Key', run: () => c.open({ type: 'keys', conn: c.connection.id, ref: keys.ref, title: keys.title, state: { newKey: true } }) } : null,
    { label: 'Open Console', run: () => c.open(consoleTab(c, database)) },
    ...(c.readOnly
      ? []
      : [
          null,
          {
            label: etcd ? 'Delete Every Key' : 'Flush Database',
            danger: true,
            run: () =>
              void (async () => {
                const what = etcd ? 'every key in this etcd' : `every key in ${name}${node.detail ? ` (${node.detail})` : ''}`;
                if (!(await c.api.confirm(etcd ? 'Delete every key?' : `Flush ${name}?`, `This removes ${what}, on ${c.connection.name}. It can’t be undone.`, etcd ? 'Delete every key' : 'Flush', true))) return;
                try {
                  const r = await c.api.call<{ reply: KvReply }>('kvCommand', { id: c.connection.id, project: c.project ?? undefined, db: database, line: etcd ? 'del --prefix ""' : 'FLUSHDB' });
                  if (r.reply.error) throw new Error(r.reply.text.replace(/^\(error\)\s*/, ''));
                  c.api.toast(etcd ? 'Every key is deleted' : `${name} is empty`);
                  c.refresh();
                } catch (e) {
                  c.api.fail(e);
                }
              })(),
          },
        ]),
  ];
};
