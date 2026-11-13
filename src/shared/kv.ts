// The kv family's own shapes, beside shared/types.ts: what a console
// command answers, and what a key's value comes with.

export type KeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | 'json' | 'other';

export interface KeyEntry {
  key: string;
  type: KeyType;
  /** Seconds left, -1 for none. */
  ttl: number;
  /** Bytes, when known. */
  size?: number;
}

export interface ScanResult {
  keys: KeyEntry[];
  /** '0' when it went all the way. */
  cursor: string;
  /** Keys in the database. */
  total?: number;
}

export type KeyValue =
  | { type: 'string'; value: string; binary?: boolean }
  | { type: 'hash'; fields: { field: string; value: string }[]; total: number }
  | { type: 'list'; items: string[]; total: number }
  | { type: 'set'; members: string[]; total: number }
  | { type: 'zset'; members: { member: string; score: number }[]; total: number }
  | { type: 'stream'; entries: { id: string; fields: Record<string, string> }[]; total: number }
  | { type: 'json'; value: unknown }
  | { type: 'other'; value: string };

/** A console command's answer: the reply as redis-cli prints it. */
export interface KvReply {
  text: string;
  /** It was an error reply (`(error) …`). */
  error?: boolean;
  /** The database the console is on now (after SELECT). */
  db?: number;
}

/** kvGet's answer: the value (a page of it), its TTL in seconds (-1 for
 * none), its size in bytes (strings) and, for etcd, its revisions. */
export type KvValue = KeyValue & {
  ttl: number;
  size?: number;
  /** A string longer than what was sent. */
  truncated?: boolean;
  /** The page asked for, for collections. */
  offset?: number;
  meta?: Record<string, string>;
};

/** The types a new key can have. */
export const NEW_KEY_TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream'] as const;

/** One change to part of a value: a hash's field, a list's item, a member. */
export type KvEdit =
  | { op: 'hset'; field: string; value: string }
  | { op: 'hdel'; field: string }
  | { op: 'lset'; index: number; value: string }
  | { op: 'lpush' | 'rpush'; value: string }
  | { op: 'lrem'; index: number }
  | { op: 'sadd' | 'srem'; member: string }
  | { op: 'zadd'; member: string; score: number }
  | { op: 'zrem'; member: string }
  | { op: 'xadd'; fields: Record<string, string> }
  | { op: 'xdel'; id: string };
