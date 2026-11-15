// A queue connection's tree menus: New Topic… or New Queue… where they go,
// and Purge… and Delete… on a topic, queue or exchange, both asked first.
// A read-only connection shows them, disabled.

import type { MenuEntry } from '@hyperpane/ui';
import type { Ref } from '../../../shared/types.ts';
import type { TreeActions, TreeContext } from '../../app/tabs.ts';

const nameOf = (ref: Ref) => ref.topic ?? ref.queue ?? ref.exchange ?? '';

async function run(c: TreeContext, op: string, ref: Ref, done: string): Promise<boolean> {
  try {
    await c.api.call(op, { id: c.connection.id, project: c.project, ref });
    c.api.toast(done);
    c.refresh();
    return true;
  } catch (e) {
    c.api.fail(e);
    return false;
  }
}

async function newTopic(c: TreeContext) {
  const topic = (await c.api.prompt('New topic', 'Name', '', 'orders'))?.trim();
  if (!topic) return;
  const partitions = await c.api.prompt('New topic', `Partitions of “${topic}”`, '1');
  if (partitions === null) return;
  const replication = await c.api.prompt('New topic', 'Replication factor (at most the number of brokers)', '1');
  if (replication === null) return;
  try {
    await c.api.call('qCreate', { id: c.connection.id, project: c.project, ref: { topic }, partitions: Number(partitions) || 1, replication: Number(replication) || 1 });
    c.api.toast(`Made topic ${topic}`);
    c.refresh();
    c.open({ type: 'topic', conn: c.connection.id, ref: { topic }, title: topic });
  } catch (e) {
    c.api.fail(e);
  }
}

async function newQueue(c: TreeContext, vhost?: string) {
  const sqs = c.kind.engine === 'sqs';
  const queue = (await c.api.prompt('New queue', sqs ? 'Name (ending in .fifo for a FIFO queue)' : 'Name (durable)', '', 'jobs'))?.trim();
  if (!queue) return;
  const ref: Ref = vhost ? { vhost, queue } : { queue };
  try {
    await c.api.call('qCreate', { id: c.connection.id, project: c.project, ref, durable: true });
    c.api.toast(`Made queue ${queue}`);
    c.refresh();
    c.open({ type: 'queue', conn: c.connection.id, ref, title: queue });
  } catch (e) {
    c.api.fail(e);
  }
}

export const actions: TreeActions = (c) => {
  const { node, path, readOnly } = c;
  const engine = c.kind.engine;
  const out: (MenuEntry | null)[] = [];
  const make = (label: string, fn: () => void): MenuEntry => ({ label: readOnly ? `${label} (read only)` : label, disabled: readOnly, run: fn });

  if (engine === 'kafka' && (!node || (node.type === 'folder' && path.length === 1 && path[0] === 'Topics'))) out.push(make('New Topic', () => void newTopic(c)));
  if (engine === 'sqs' && !node) out.push(make('New Queue', () => void newQueue(c)));
  if (engine === 'rabbitmq' && node && ((node.type === 'database' && path.length === 1) || (node.type === 'folder' && path.length === 2 && path[1] === 'Queues'))) out.push(make('New Queue', () => void newQueue(c, path[0])));

  const ref = node?.open?.ref;
  if (ref && (node.type === 'topic' || node.type === 'queue' || node.type === 'exchange')) {
    const name = nameOf(ref);
    const noun = node.type;
    if (out.length) out.push(null);
    if (noun !== 'exchange')
      out.push({
        ...make('Purge', async () => {
          if (await c.api.confirm(`Purge ${name}?`, `Every message in the ${noun} is deleted, for every consumer. This can’t be undone.`, 'Purge', true)) await run(c, 'qPurge', ref, `Purged ${name}`);
        }),
        danger: true,
      });
    out.push({
      ...make('Delete', async () => {
        if (await c.api.confirm(`Delete ${name}?`, `The ${noun} and every message in it are deleted. This can’t be undone.`, 'Delete', true)) await run(c, 'qRemove', ref, `Deleted ${name}`);
      }),
      danger: true,
    });
  }
  return out;
};
