// What a topic's or a queue's tab can do, by engine and by what it names:
// Kafka has partitions, offsets and a live tail; RabbitMQ's queues can be
// peeked (taken and put back) but not tailed, and its exchanges only
// published to; SQS's queues are peeked and tailed by polling.

import type { Engine } from '../../../shared/kinds.ts';
import type { Ref } from '../../../shared/types.ts';

export interface Caps {
  engine: Engine;
  /** What it is, in a sentence. */
  noun: 'topic' | 'queue' | 'exchange';
  name: string;
  partitions: boolean;
  /** From: newest, oldest, an offset. */
  from: boolean;
  peek: boolean;
  live: boolean;
  purge: boolean;
  /** What a message's key is called when publishing, or null for none. */
  keyLabel: string | null;
  /** Publishing takes a routing key (an exchange). */
  routing: boolean;
  /** Said under the toolbar: what looking does to the messages. */
  peekNote?: string;
}

export function capsOf(engine: Engine, ref: Ref): Caps {
  if (engine === 'kafka') return { engine, noun: 'topic', name: ref.topic ?? '', partitions: true, from: true, peek: true, live: true, purge: true, keyLabel: 'Key', routing: false };
  if (engine === 'rabbitmq') {
    if (ref.exchange !== undefined) return { engine, noun: 'exchange', name: ref.exchange, partitions: false, from: false, peek: false, live: false, purge: false, keyLabel: null, routing: true };
    return {
      engine,
      noun: 'queue',
      name: ref.queue ?? '',
      partitions: false,
      from: false,
      peek: true,
      live: false,
      purge: true,
      keyLabel: 'Message ID',
      routing: false,
      peekNote: 'Looking takes the messages and puts them back: they stay in the queue, in order, but come back marked redelivered.',
    };
  }
  const fifo = (ref.queue ?? '').endsWith('.fifo');
  return {
    engine,
    noun: 'queue',
    name: ref.queue ?? '',
    partitions: false,
    from: false,
    peek: true,
    live: true,
    purge: true,
    keyLabel: fifo ? 'Message group' : null,
    routing: false,
    peekNote: 'Looking receives the messages with a visibility timeout of 0, so they stay; each look counts as a receive, which can move them to a dead-letter queue. SQS returns them in no set order, and may leave some out.',
  };
}
