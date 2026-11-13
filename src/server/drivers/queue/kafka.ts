// Kafka (and Redpanda, which speaks its protocol), with kafkajs: the
// cluster, its topics and consumer groups as a tree, a topic's partitions
// and the groups reading it with their lag, publishing, and topics made,
// emptied and deleted. Reading is in kafka-read.ts.

import { PluginError } from '@hyperpane/sdk/server';
import type { Admin } from 'kafkajs';
import type { Ref, TreeNode } from '../../../shared/types.ts';
import type { QueueInfo } from '../../../shared/queue.ts';
import type { Factory, QueueDriver } from '../types.ts';
import { Client, GROUP_PREFIX, said } from './kafka-client.ts';
import { peek, tail } from './kafka-read.ts';
import { duration, plural } from './format.ts';
import { nameOf } from './text.ts';

/** Topics named `__…` are the brokers' own: shown only when there are few topics. */
const SHOW_INTERNAL_UNDER = 8;
const MAX_GROUPS = 200;

export const kafka: Factory = (ctx) => {
  const c = new Client(ctx.values, ctx.log);
  const name = ctx.kind.name;

  const groupIds = async (a: Admin) => (await a.listGroups()).groups.map((g) => g.groupId).filter((g) => !g.startsWith(GROUP_PREFIX)).sort();

  /** Each group's committed offsets in the topic, and its lag. */
  async function lagOf(a: Admin, groupId: string, topic: string, highs: Map<number, bigint>): Promise<{ lag: bigint; committed: boolean }> {
    const offs = await a.fetchOffsets({ groupId, topics: [topic] });
    let lag = 0n;
    let committed = false;
    for (const p of offs[0]?.partitions ?? []) {
      if (p.offset === '-1' || p.offset === '') continue;
      committed = true;
      const high = highs.get(p.partition) ?? 0n;
      const o = BigInt(p.offset);
      if (high > o) lag += high - o;
    }
    return { lag, committed };
  }

  const driver: QueueDriver = {
    family: 'queue',

    async info() {
      const cl = await c.with((a) => a.describeCluster());
      const controller = cl.brokers.find((b) => b.nodeId === cl.controller);
      return {
        version: `${name} · ${plural(cl.brokers.length, 'broker')}`,
        detail: [`cluster ${cl.clusterId}`, controller ? `controller ${controller.host}:${controller.port}` : null].filter(Boolean).join(', '),
      };
    },

    async children(path) {
      if (!path.length)
        return [
          { name: 'Topics', type: 'folder', expand: true },
          { name: 'Consumer groups', type: 'folder' },
        ];
      if (path[0] === 'Topics' && path.length === 1) {
        return c.with(async (a) => {
          const all = (await a.listTopics()).sort();
          const shown = all.length < SHOW_INTERNAL_UNDER ? all : all.filter((t) => !t.startsWith('__'));
          const meta = shown.length ? await a.fetchTopicMetadata({ topics: shown }) : { topics: [] };
          const parts = new Map(meta.topics.map((t) => [t.name, t.partitions.length]));
          return shown.map((t): TreeNode => ({ name: t, type: 'topic', leaf: true, detail: parts.has(t) ? plural(parts.get(t)!, 'partition') : undefined, open: { tab: 'topic', ref: { topic: t }, title: t } }));
        });
      }
      if (path[0] === 'Consumer groups' && path.length === 1) {
        return c.with(async (a) => {
          const ids = (await groupIds(a)).slice(0, MAX_GROUPS);
          if (!ids.length) return [];
          const { groups } = await a.describeGroups(ids);
          return groups.sort((x, y) => x.groupId.localeCompare(y.groupId)).map((g): TreeNode => ({ name: g.groupId, type: 'group', detail: `${g.state.toLowerCase()}${g.members.length ? `, ${plural(g.members.length, 'member')}` : ''}` }));
        });
      }
      if (path[0] === 'Consumer groups' && path.length === 2) {
        return c.with(async (a) => {
          const offs = await a.fetchOffsets({ groupId: path[1] });
          const out: TreeNode[] = [];
          for (const t of offs) {
            if (!t.partitions.some((p) => p.offset !== '-1')) continue;
            const highs = new Map((await a.fetchTopicOffsets(t.topic)).map((o) => [o.partition, BigInt(o.high)]));
            const { lag } = await lagOf(a, path[1], t.topic, highs);
            out.push({ name: t.topic, type: 'topic', leaf: true, detail: `lag ${lag.toLocaleString()}`, open: { tab: 'topic', ref: { topic: t.topic }, title: t.topic } });
          }
          return out.sort((x, y) => x.name.localeCompare(y.name));
        });
      }
      return [];
    },

    describe(ref: Ref): Promise<QueueInfo> {
      const topic = nameOf(ref, 'topic');
      return c.with(async (a) => {
        const meta = await a.fetchTopicMetadata({ topics: [topic] });
        const t = meta.topics[0];
        if (!t) throw new PluginError(`There’s no topic “${topic}”.`);
        const offs = await a.fetchTopicOffsets(topic);
        const marks = new Map(offs.map((o) => [o.partition, o]));
        const partitions = t.partitions
          .map((p) => ({ partition: p.partitionId, leader: p.leader >= 0 ? p.leader : null, low: marks.get(p.partitionId)?.low ?? '0', high: marks.get(p.partitionId)?.high ?? '0', replicas: p.replicas, isr: p.isr }))
          .sort((x, y) => x.partition - y.partition);
        const messages = partitions.reduce((n, p) => n + (BigInt(p.high) - BigInt(p.low)), 0n);
        const stats = [
          { label: 'Partitions', value: String(partitions.length) },
          { label: 'Messages', value: messages.toLocaleString() },
          { label: 'Replication', value: String(t.partitions[0]?.replicas.length ?? 0) },
        ];
        try {
          // 2: a topic, in Kafka's config resource types.
          const cfg = await a.describeConfigs({ resources: [{ type: 2, name: topic, configNames: ['cleanup.policy', 'retention.ms'] }], includeSynonyms: false });
          const entries = new Map(cfg.resources[0]?.configEntries.map((e) => [e.configName, e.configValue]) ?? []);
          if (entries.get('cleanup.policy')) stats.push({ label: 'Cleanup', value: entries.get('cleanup.policy')! });
          const ret = entries.get('retention.ms');
          if (ret) stats.push({ label: 'Retention', value: ret === '-1' ? 'forever' : duration(Number(ret)) });
        } catch {}
        const highs = new Map(partitions.map((p) => [p.partition, BigInt(p.high)]));
        const consumers: NonNullable<QueueInfo['consumers']> = [];
        const ids = (await groupIds(a)).slice(0, MAX_GROUPS);
        const reading: { id: string; lag: bigint }[] = [];
        for (const id of ids) {
          const l = await lagOf(a, id, topic, highs).catch(() => null);
          if (l?.committed) reading.push({ id, lag: l.lag });
        }
        if (reading.length) {
          const { groups } = await a.describeGroups(reading.map((r) => r.id));
          const by = new Map(groups.map((g) => [g.groupId, g]));
          for (const r of reading) {
            const g = by.get(r.id);
            consumers.push({ name: r.id, detail: g ? `${g.state.toLowerCase()}, ${plural(g.members.length, 'member')}` : '', lag: r.lag.toLocaleString() });
          }
          stats.push({ label: 'Groups', value: String(reading.length) });
        }
        return { stats, partitions, consumers };
      });
    },

    peek: (r, signal) => peek(c, r, signal),
    tail: (ref, emit, signal) => tail(c, ref, emit, signal),

    async publish(r) {
      const topic = nameOf(r.ref, 'topic');
      const p = await c.producer();
      try {
        const [res] = await p.send({
          topic,
          messages: [{ key: r.key === undefined || r.key === '' ? null : r.key, value: r.value, headers: r.headers && Object.keys(r.headers).length ? r.headers : undefined, partition: r.partition ?? undefined }],
        });
        return { id: res ? `${res.partition}:${res.baseOffset ?? res.offset ?? ''}` : undefined };
      } catch (e) {
        throw said(e);
      }
    },

    async create(ref, o) {
      const topic = nameOf(ref, 'topic');
      const made = await c.with((a) => a.createTopics({ topics: [{ topic, numPartitions: o.partitions ?? 1, replicationFactor: o.replication ?? 1 }], waitForLeaders: true }));
      if (!made) throw new PluginError(`There’s a topic “${topic}” already.`);
    },

    async remove(ref) {
      const topic = nameOf(ref, 'topic');
      await c.with((a) => a.deleteTopics({ topics: [topic], timeout: 15_000 }));
    },

    async purge(ref) {
      const topic = nameOf(ref, 'topic');
      await c.with(async (a) => {
        const offs = await a.fetchTopicOffsets(topic);
        // -1: up to each partition's end.
        await a.deleteTopicRecords({ topic, partitions: offs.map((o) => ({ partition: o.partition, offset: '-1' })) });
      });
    },

    close: () => c.close(),
  };
  return driver;
};

