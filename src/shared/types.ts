// What the server part and the window say to each other: saved
// connections, the tree of what's in one, and each family's results.

import type { Values } from './kinds.ts';

export const ID = 'data';

// ---------------------------------------------------------------- connections

export interface Connection {
  id: string;
  name: string;
  /** A kind's id (kinds.ts). */
  kind: string;
  /** A color of its own, for its dot and its tabs (null: the kind's). */
  color: string | null;
  /** Under which heading it's listed ("Production", "Local"). */
  group: string;
  /** The fields' values, secret ones left out. */
  values: Values;
  /** The secret fields that have a value kept on the server. */
  saved: string[];
  /** Marked read only: no edits, no writes from consoles that look like
   * one (as far as can be told). */
  readOnly: boolean;
  created: number;
  /** Last connected, or null. */
  used: number | null;
}

/** A connection as the form saves it: secrets given are kept; a secret
 * left out keeps what's saved, '' clears it. */
export interface ConnectionInput {
  id?: string;
  name: string;
  kind: string;
  color?: string | null;
  group?: string;
  readOnly?: boolean;
  values: Values;
  secrets?: Record<string, string>;
}

export interface State {
  connections: Connection[];
  /** Ids of those with a session open now, and what it said it was. */
  open: Record<string, SessionInfo>;
}

export interface SessionInfo {
  /** "PostgreSQL 17.2", "Redis 7.4.1". */
  version: string;
  /** More, in a line: the user, the cluster, the region. */
  detail?: string;
  at: number;
}

// ---------------------------------------------------------------- the tree

/** What a tree item is: its icon, and the tab it opens. */
export type NodeType =
  | 'database'
  | 'schema'
  | 'folder'
  | 'table'
  | 'view'
  | 'column'
  | 'index'
  | 'key'
  | 'function'
  | 'sequence'
  | 'trigger'
  | 'keyspace'
  | 'collection'
  | 'topic'
  | 'queue'
  | 'exchange'
  | 'group'
  | 'bucket'
  | 'info';

/** The tab a tree item opens: its type and what it names. */
export interface OpenTarget {
  tab: TabType;
  ref: Ref;
  title: string;
}

/** What a tab or a call is about: a table, a collection, a topic, a
 * bucket, by name (only the fields that apply). */
export interface Ref {
  database?: string;
  schema?: string;
  table?: string;
  collection?: string;
  topic?: string;
  queue?: string;
  exchange?: string;
  bucket?: string;
  prefix?: string;
  /** Redis: the key pattern a keys tab starts with. */
  pattern?: string;
  vhost?: string;
}

export interface TreeNode {
  /** Unique among its siblings: the path to its children. */
  name: string;
  /** What it's shown as, when not its name. */
  label?: string;
  type: NodeType;
  /** Beside it, faint: a column's type, a table's rows, a queue's depth. */
  detail?: string;
  /** No children: not expandable. */
  leaf?: boolean;
  /** Double-click (or Enter) opens it. */
  open?: OpenTarget;
  /** Opened on its own when the tree is (a database with one schema). */
  expand?: boolean;
}

// ---------------------------------------------------------------- tabs

export type TabType = 'home' | 'console' | 'table' | 'keys' | 'collection' | 'topic' | 'queue' | 'bucket';

// ---------------------------------------------------------------- results

/** A cell as it travels: JSON's values, big numbers and dates as strings,
 * bytes as `{ $bytes: base64 of the first 4 KB, size }`, anything else
 * (a JSON column, an array) as JSON. */
export type Cell = null | boolean | number | string | { $bytes: string; size: number } | unknown[] | { [k: string]: unknown };

export interface Column {
  name: string;
  /** The database's name for its type: "int4", "varchar(255)". */
  type?: string;
  /** Part of the primary key. */
  key?: boolean;
  nullable?: boolean;
  /** Has a default (and so may be left out of an insert). */
  hasDefault?: boolean;
  /** Generated, or otherwise not writable. */
  readOnly?: boolean;
}

export interface QueryResult {
  /** The statement that gave it (of several run at once). */
  statement?: string;
  columns: Column[];
  rows: Cell[][];
  /** "SELECT 20", "UPDATE 3": what the database said it did. */
  command?: string;
  affected?: number | null;
  ms: number;
  /** More rows than `limit`: the rest weren't fetched. */
  truncated?: boolean;
  notices?: string[];
}
