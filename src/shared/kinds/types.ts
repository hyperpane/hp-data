// What a kind of connection is: its engine, the family of window it opens
// in, where it's listed, and the fields its form asks for.

export type Family = 'sql' | 'kv' | 'document' | 'queue' | 'object';

/** What speaks to the server: one driver each, on the server part. */
export type Engine =
  | 'postgres'
  | 'mysql'
  | 'sqlite'
  | 'clickhouse'
  | 'redis'
  | 'etcd'
  | 'mongodb'
  | 'elasticsearch'
  | 'dynamodb'
  | 'kafka'
  | 'rabbitmq'
  | 'sqs'
  | 's3';

/** Where a kind is listed under Add connection. */
export type Category = 'relational' | 'keyvalue' | 'document' | 'queue' | 'object';

export const CATEGORIES: { id: Category; title: string; description: string }[] = [
  { id: 'relational', title: 'Relational', description: 'Tables, SQL consoles, editable results' },
  { id: 'keyvalue', title: 'Key-value', description: 'Keys by pattern, every type, TTLs, a command line' },
  { id: 'document', title: 'Document & search', description: 'Collections and indexes, queries in JSON' },
  { id: 'queue', title: 'Queues & streams', description: 'Topics and queues, messages, publishing' },
  { id: 'object', title: 'Object storage', description: 'Buckets and folders, preview, upload, links' },
];

export type FieldType = 'text' | 'number' | 'password' | 'boolean' | 'select' | 'textarea';

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  default?: string | number | boolean;
  /** Kept on this server only, never sent back to a window. */
  secret?: boolean;
  options?: { value: string; label: string }[];
  required?: boolean;
  help?: string;
  /** Laid out beside the next half field. */
  half?: boolean;
  /** Under Options (the form's last tab). */
  advanced?: boolean;
  /** The form's tab it's on, when not General or Options. */
  section?: 'ssh' | 'tls';
  /** Shown only while another field has one of these values. */
  when?: { key: string; is: (string | number | boolean)[] };
}

export interface Kind {
  id: string;
  name: string;
  engine: Engine;
  family: Family;
  category: Category;
  /** The tile's color and its letters (no logos: plain letters, as a
   * monogram). */
  color: string;
  glyph: string;
  tagline: string;
  fields: Field[];
  /** Schemes a pasted connection string may start with. */
  schemes?: string[];
  /** A note under the form. */
  note?: string;
}

export type Values = Record<string, string | number | boolean>;
