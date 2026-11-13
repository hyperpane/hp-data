// The queue family's types: messages, peeking and publishing, a topic's or queue's figures.

import type { Ref } from './types.ts';

export interface Message {
  /** Unique in the list: partition:offset, a delivery tag, a message id. */
  id: string;
  key?: string | null;
  value: string;
  /** The value wasn't text: shown as base64. */
  binary?: boolean;
  headers?: Record<string, string>;
  at?: number | null;
  partition?: number;
  offset?: string;
  /** Anything else the queue says about it (redelivered, routing key). */
  meta?: Record<string, string | number | boolean>;
}

export interface PeekRequest {
  ref: Ref;
  limit: number;
  /** Kafka: from the start of each partition, the end (the newest), or an
   * offset in one partition. */
  from?: 'earliest' | 'latest' | 'offset';
  partition?: number;
  offset?: string;
}

export interface PublishRequest {
  ref: Ref;
  key?: string;
  value: string;
  headers?: Record<string, string>;
  partition?: number;
  /** RabbitMQ: the routing key when publishing to an exchange. */
  routingKey?: string;
}

/** A topic's or a queue's figures, for its page. */
export interface QueueInfo {
  /** Rows of a small table: "Partitions" 3, "Messages" 1 204. */
  stats: { label: string; value: string }[];
  /** Kafka: per partition. */
  partitions?: { partition: number; leader: number | null; low: string; high: string; replicas: number[]; isr: number[] }[];
  /** Kafka: consumer groups and their lag; RabbitMQ: consumers. */
  consumers?: { name: string; detail: string; lag?: string }[];
  /** RabbitMQ: bindings. */
  bindings?: { source: string; destination: string; routingKey: string }[];
}
