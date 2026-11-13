// The object family's own shapes, beyond types.ts: an object's head with
// what the service says about it besides user metadata, a removal's
// count, and the presigned links' lifetimes.

export interface ObjectEntry {
  key: string;
  size: number;
  modified: number | null;
  etag?: string;
  storageClass?: string;
}

export interface ListRequest {
  bucket: string;
  prefix: string;
  /** Continue from where the last page ended. */
  token?: string;
  /** Everything under the prefix, not by folder. */
  flat?: boolean;
}

export interface ListResult {
  /** Folders: common prefixes, ending in '/'. */
  prefixes: string[];
  objects: ObjectEntry[];
  /** More: pass as token. */
  next: string | null;
}

export interface ObjectHead {
  key: string;
  size: number;
  modified: number | null;
  contentType: string | null;
  etag: string | null;
  metadata: Record<string, string>;
}

export interface ObjectDetails extends ObjectHead {
  storageClass?: string;
  /** Headers worth showing (cache-control, version id, encryption). */
  system: Record<string, string>;
}

/** What objRemove did (or, with dryRun, would do). */
export interface RemoveResult {
  /** Objects deleted, or that would be. */
  count: number;
}

export const LINK_TIMES: { seconds: number; label: string }[] = [
  { seconds: 3600, label: '1 hour' },
  { seconds: 86_400, label: '1 day' },
  { seconds: 604_800, label: '7 days' },
];

/** The preview's most. */
export const PREVIEW_BYTES = 1024 * 1024;
