// What a driver is: one open session to one connection, made by its
// engine's factory (drivers/index.ts) from the connection's values with
// its secrets put back. Each family adds its own methods; the calls in
// calls/<family>.ts reach them through `session.sql()`, `.kv()` and so on.

import type { Kind, Values } from '../../shared/kinds.ts';
import type { KvEdit } from '../../shared/kv.ts';

export type { KvEdit };
import type { QueryResult, Ref, SessionInfo, TreeNode } from '../../shared/types.ts';
import type { BrowseRequest, BrowseResult, RowEdit, TableInfo, TableRef } from '../../shared/sql.ts';
import type { KeyValue, ScanResult } from '../../shared/kv.ts';
import type { FindRequest, FindResult } from '../../shared/document.ts';
import type { Message, PeekRequest, PublishRequest, QueueInfo } from '../../shared/queue.ts';
import type { ListRequest, ListResult, ObjectHead } from '../../shared/object.ts';

/** What a factory is given. */
export interface DriverContext {
  kind: Kind;
  /** Every value, secrets too, with the kind's defaults filled in. */
  values: Values;
  /** The project's folder on the server, when a project asked (SQLite's
   * relative paths), else null. */
  folder: string | null;
  /** The plugin's data folder on this server. */
  dataDir: string;
  log(line: string): void;
}

export interface BaseDriver {
  /** Says hello: the server's version. Throws (a PluginError, said for the
   * user) when it can't connect. */
  info(): Promise<Omit<SessionInfo, 'at'>>;
  /** What's under a tree path ([] is the top). */
  children(path: string[]): Promise<TreeNode[]>;
  close(): Promise<void>;
}

export interface SqlDriver extends BaseDriver {
  family: 'sql';
  /** Runs what's typed: one result per statement. `limit` caps each
   * result's rows (truncated says so). */
  query(sql: string, o: { limit: number; database?: string; signal: AbortSignal }): Promise<QueryResult[]>;
  browse(r: BrowseRequest, signal: AbortSignal): Promise<BrowseResult>;
  describe(t: TableRef): Promise<TableInfo>;
  /** Applies edits in one transaction: all or none. */
  apply(t: TableRef, edits: RowEdit[]): Promise<{ affected: number }>;
  /** Names for completion: tables (schema.table) and their columns. */
  completions(database?: string): Promise<{ tables: { schema?: string; name: string; columns: string[] }[] }>;
}

export interface KvDriver extends BaseDriver {
  family: 'kv';
  scan(o: { db?: number; pattern: string; cursor: string; count: number }): Promise<ScanResult>;
  get(o: { db?: number; key: string; offset?: number; limit?: number }): Promise<KeyValue & { ttl: number }>;
  /** Sets a whole value (a string, or every field of a hash…), or one part
   * of it: `edit` names what to change. */
  set(o: { db?: number; key: string; value: KeyValue; ttl?: number | null }): Promise<void>;
  edit(o: { db?: number; key: string; op: KvEdit }): Promise<void>;
  remove(o: { db?: number; keys: string[] }): Promise<number>;
  rename(o: { db?: number; key: string; to: string }): Promise<void>;
  expire(o: { db?: number; key: string; ttl: number | null }): Promise<void>;
  /** A command as typed, its reply as the CLI shows it. */
  command(o: { db?: number; line: string }): Promise<{ reply: unknown; ms: number }>;
}


export interface DocumentDriver extends BaseDriver {
  family: 'document';
  find(r: FindRequest, signal: AbortSignal): Promise<FindResult>;
  insert(ref: Ref, doc: unknown): Promise<unknown>;
  /** Replaces the document whose id fields are `id`. */
  replace(ref: Ref, id: Record<string, unknown>, doc: unknown): Promise<void>;
  remove(ref: Ref, ids: Record<string, unknown>[]): Promise<number>;
  /** A command or query as typed in a console (JSON), its result as JSON. */
  command(o: { database?: string; text: string; signal: AbortSignal }): Promise<{ result: unknown; ms: number }>;
}

export interface QueueDriver extends BaseDriver {
  family: 'queue';
  info(): Promise<Omit<SessionInfo, 'at'>>;
  describe(ref: Ref): Promise<QueueInfo>;
  /** Looks at messages without taking them (as far as the queue allows:
   * RabbitMQ requeues them, SQS hides them for a moment). */
  peek(r: PeekRequest, signal: AbortSignal): Promise<Message[]>;
  publish(r: PublishRequest): Promise<{ id?: string }>;
  /** New messages as they come, until the signal. */
  tail(ref: Ref, emit: (m: Message) => boolean, signal: AbortSignal): Promise<void>;
  /** Creates a topic or a queue. */
  create(ref: Ref, o: { partitions?: number; replication?: number; durable?: boolean }): Promise<void>;
  remove(ref: Ref): Promise<void>;
  purge(ref: Ref): Promise<void>;
}

export interface ObjectDriver extends BaseDriver {
  family: 'object';
  list(r: ListRequest, signal: AbortSignal): Promise<ListResult>;
  head(bucket: string, key: string): Promise<ObjectHead>;
  /** The object's bytes (the first `limit`, for a preview). */
  read(bucket: string, key: string, o: { limit?: number; signal: AbortSignal }): Promise<{ body: ReadableStream<Uint8Array>; size: number; contentType: string | null }>;
  write(bucket: string, key: string, body: ReadableStream<Uint8Array> | Uint8Array, o: { size?: number; contentType?: string }): Promise<void>;
  remove(bucket: string, keys: string[]): Promise<number>;
  copy(bucket: string, from: string, to: string): Promise<void>;
  /** A link anyone can open for `seconds`. */
  presign(bucket: string, key: string, seconds: number): Promise<string>;
  createBucket(bucket: string): Promise<void>;
}

export type Driver = SqlDriver | KvDriver | DocumentDriver | QueueDriver | ObjectDriver;

export type Factory = (ctx: DriverContext) => Driver;
