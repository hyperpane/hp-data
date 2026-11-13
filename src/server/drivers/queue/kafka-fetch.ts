// Reading a range of offsets straight from each partition's leader, as a
// consumer would but without joining a group: no group to make, no
// rebalance to wait for (a new group waits 3 seconds on most brokers), and
// nobody's offsets touched. kafkajs doesn't offer this, so it uses the
// cluster kafkajs makes for its own consumers (a private part of 2.2.x);
// when that isn't there, kafka-read.ts falls back to a group of its own.

import type { Kafka, KafkaMessage } from 'kafkajs';
import type { Message } from '../../../shared/queue.ts';
import type { Range } from './kafka-read.ts';

interface FetchedPartition {
  partition: number;
  errorCode: number;
  highWatermark: string;
  messages: (KafkaMessage & { isControlRecord?: boolean })[];
}

interface Broker {
  fetch(o: { maxWaitTime: number; minBytes: number; maxBytes: number; isolationLevel: number; topics: { topic: string; partitions: { partition: number; fetchOffset: string; maxBytes: number }[] }[] }): Promise<{
    responses: { topicName: string; partitions: FetchedPartition[] }[];
  }>;
}

export interface Cluster {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  addTargetTopic(topic: string): Promise<void>;
  refreshMetadata(): Promise<void>;
  findLeaderForPartitions(topic: string, partitions: number[]): Record<string, number[]>;
  findBroker(o: { nodeId: string }): Promise<Broker>;
}

/** Read committed: what aborted transactions wrote isn't shown. */
const READ_COMMITTED = 1;
const PARTITION_BYTES = 2 * 1024 * 1024;
const MAX_ROUNDS = 200;

/** The cluster kafkajs would give a consumer, or null when this kafkajs
 * doesn't have one to give. */
export function makeCluster(kafka: Kafka): Cluster | null {
  const sym = Object.getOwnPropertySymbols(kafka).find((s) => s.description === 'private:Kafka:createCluster');
  const create = sym ? (kafka as unknown as Record<symbol, unknown>)[sym] : null;
  if (typeof create !== 'function') return null;
  const c = (create as (o: object) => Cluster)({ allowAutoTopicCreation: false, isolationLevel: READ_COMMITTED });
  return typeof c?.findLeaderForPartitions === 'function' && typeof c.findBroker === 'function' ? c : null;
}

/** The messages in each range, as `toMessage` makes them. */
export async function fetchRanges(cluster: Cluster, topic: string, ranges: Range[], toMessage: (p: number, m: KafkaMessage) => Message, signal: AbortSignal): Promise<Message[]> {
  await cluster.addTargetTopic(topic);
  const next = new Map(ranges.map((r) => [r.partition, r.start]));
  const ends = new Map(ranges.map((r) => [r.partition, r.end]));
  const out: Message[] = [];
  for (let round = 0; round < MAX_ROUNDS && next.size && !signal.aborted; round++) {
    const leaders = cluster.findLeaderForPartitions(topic, [...next.keys()]);
    const progress = await Promise.all(
      Object.entries(leaders).map(async ([nodeId, partitions]) => {
        const broker = await cluster.findBroker({ nodeId });
        const { responses } = await broker.fetch({
          maxWaitTime: 200,
          minBytes: 1,
          maxBytes: PARTITION_BYTES * partitions.length,
          isolationLevel: READ_COMMITTED,
          topics: [{ topic, partitions: partitions.map((p) => ({ partition: p, fetchOffset: String(next.get(p)), maxBytes: PARTITION_BYTES })) }],
        });
        let moved = false;
        for (const part of responses.flatMap((r) => r.partitions)) {
          const from = next.get(part.partition);
          const end = ends.get(part.partition);
          if (from === undefined || end === undefined) continue;
          if (part.errorCode) throw Object.assign(new Error(`Fetching partition ${part.partition} failed (error ${part.errorCode}).`), { retriable: true });
          let last = from - 1n;
          for (const m of part.messages) {
            const o = BigInt(m.offset);
            if (o > last) last = o;
            if (o < from || o >= end || m.isControlRecord) continue;
            out.push(toMessage(part.partition, m));
          }
          const high = BigInt(part.highWatermark);
          if (last + 1n >= end || last + 1n >= high || !part.messages.length) next.delete(part.partition);
          else {
            next.set(part.partition, last + 1n);
            moved = true;
          }
        }
        return moved;
      }),
    );
    if (!progress.some(Boolean)) break;
  }
  return out;
}
