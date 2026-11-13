// The document family's calls, past what shared/types.ts has: paging by a
// token (DynamoDB has no skip), and what a console's run said.

import type { Ref } from './types.ts';

export interface FindRequest {
  ref: Ref;
  /** JSON as typed: a filter (MongoDB), a query DSL (Elasticsearch), a
   * key condition or PartiQL (DynamoDB). '' for everything. */
  filter: string;
  sort?: string;
  projection?: string;
  skip: number;
  limit: number;
}

export interface FindResult {
  docs: unknown[];
  /** How many match, when known. */
  total: number | null;
  ms: number;
  /** The field that is a document's id (`_id`, a table's keys). */
  idFields: string[];
}

export interface DocFindRequest extends FindRequest {
  /** DynamoDB: where the last page ended (its `next`). */
  token?: string;
}

export interface DocFindResult extends FindResult {
  /** DynamoDB: there's more; pass it as `token` for the next page. */
  next?: string | null;
  /** What the engine was asked, to open in a console. */
  query?: string;
}

export interface CommandResult {
  result: unknown;
  ms: number;
  /** MongoDB: `use` switched to this database. */
  database?: string;
  /** The result is text to show as it is (Elasticsearch's _cat). */
  text?: boolean;
  /** Elasticsearch: the request's status. */
  status?: number;
}

/** docFind's payload. */
export type DocFindCall = { id: string; project?: string | null } & DocFindRequest;
export type DocInsertCall = { id: string; project?: string | null; ref: Ref; doc: unknown };
export type DocReplaceCall = { id: string; project?: string | null; ref: Ref; key: Record<string, unknown>; doc: unknown };
export type DocRemoveCall = { id: string; project?: string | null; ref: Ref; keys: Record<string, unknown>[] };
export type DocCommandCall = { id: string; project?: string | null; database?: string; text: string };
