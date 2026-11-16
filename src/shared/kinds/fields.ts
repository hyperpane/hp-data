// The fields kinds share: host, port, user, password, SSL; and the
// presets of an engine (a PostgreSQL, a MySQL, a Redis, an S3) that kinds
// are made of.

import type { Field, Kind } from './types.ts';

const SSL_MODES = [
  { value: 'disable', label: 'Off' },
  { value: 'require', label: 'On, any certificate' },
  { value: 'verify', label: 'On, verify the certificate' },
];

export const host = (placeholder = 'localhost', def: string = 'localhost'): Field => ({
  key: 'host',
  label: 'Host',
  type: 'text',
  placeholder,
  default: def,
  required: true,
  half: true,
});
export const port = (p: number): Field => ({ key: 'port', label: 'Port', type: 'number', placeholder: String(p), default: p, half: true });
export const user = (def = ''): Field => ({ key: 'user', label: 'User', type: 'text', default: def, half: true });
export const password: Field = { key: 'password', label: 'Password', type: 'password', secret: true, half: true };
export const database = (def = '', label = 'Database'): Field => ({ key: 'database', label, type: 'text', default: def, placeholder: def || 'all of them' });
export const ssl = (def = 'disable'): Field => ({ key: 'ssl', label: 'SSL', type: 'select', options: SSL_MODES, default: def });

export function pg(
  id: string,
  name: string,
  color: string,
  glyph: string,
  tagline: string,
  o: { host?: string; port?: number; user?: string; database?: string; ssl?: string; note?: string } = {},
): Kind {
  return {
    id,
    name,
    engine: 'postgres',
    family: 'sql',
    category: 'relational',
    color,
    glyph,
    tagline,
    schemes: ['postgres', 'postgresql'],
    note: o.note,
    fields: [
      host(o.host ?? 'localhost', o.host ? '' : 'localhost'),
      port(o.port ?? 5432),
      user(o.user ?? 'postgres'),
      password,
      database(o.database ?? 'postgres'),
      ssl(o.ssl),
      { key: 'timeout', label: 'Connect timeout (s)', type: 'number', default: 10, advanced: true },
    ],
  };
}

export function my(
  id: string,
  name: string,
  color: string,
  glyph: string,
  tagline: string,
  o: { host?: string; port?: number; user?: string; ssl?: string; note?: string } = {},
): Kind {
  return {
    id,
    name,
    engine: 'mysql',
    family: 'sql',
    category: 'relational',
    color,
    glyph,
    tagline,
    schemes: ['mysql', 'mariadb'],
    note: o.note,
    fields: [
      host(o.host ?? 'localhost', o.host ? '' : 'localhost'),
      port(o.port ?? 3306),
      user(o.user ?? 'root'),
      password,
      database(''),
      ssl(o.ssl),
      { key: 'timeout', label: 'Connect timeout (s)', type: 'number', default: 10, advanced: true },
    ],
  };
}

export function redis(id: string, name: string, color: string, glyph: string, tagline: string): Kind {
  return {
    id,
    name,
    engine: 'redis',
    family: 'kv',
    category: 'keyvalue',
    color,
    glyph,
    tagline,
    schemes: ['redis', 'rediss', 'valkey'],
    fields: [
      host(),
      port(6379),
      { ...user(''), placeholder: 'default' },
      password,
      { key: 'db', label: 'Database', type: 'number', default: 0, half: true },
      { key: 'tls', label: 'TLS', type: 'boolean', default: false, half: true },
    ],
  };
}

export const awsFields = (o: { endpoint?: string; endpointHelp?: string; region?: string; pathStyle?: boolean; bucket?: boolean } = {}): Field[] => [
  { key: 'accessKeyId', label: 'Access key ID', type: 'text', placeholder: 'from ~/.aws or the environment if empty', half: true },
  { key: 'secretAccessKey', label: 'Secret access key', type: 'password', secret: true, half: true },
  { key: 'region', label: 'Region', type: 'text', default: o.region ?? 'us-east-1', placeholder: 'us-east-1', half: true },
  { key: 'endpoint', label: 'Endpoint', type: 'text', default: o.endpoint ?? '', placeholder: o.endpoint || 'AWS', help: o.endpointHelp, half: true },
  ...(o.bucket
    ? [{ key: 'bucket', label: 'Bucket', type: 'text', placeholder: 'every bucket', help: 'Only this bucket: for keys that may not list buckets.' } as Field]
    : []),
  ...(o.pathStyle !== undefined
    ? [
        {
          key: 'pathStyle',
          label: 'Path-style addresses',
          type: 'boolean',
          default: o.pathStyle,
          advanced: true,
          help: 'endpoint/bucket/key rather than bucket.endpoint/key',
        } as Field,
      ]
    : []),
  {
    key: 'profile',
    label: 'Profile',
    type: 'text',
    placeholder: 'default',
    advanced: true,
    help: 'From ~/.aws/credentials on the server, when there are no keys above.',
  },
  { key: 'sessionToken', label: 'Session token', type: 'password', secret: true, advanced: true },
];

export function s3(
  id: string,
  name: string,
  color: string,
  glyph: string,
  tagline: string,
  o: { endpoint?: string; endpointHelp?: string; region?: string; pathStyle?: boolean; note?: string } = {},
): Kind {
  return {
    id,
    name,
    engine: 's3',
    family: 'object',
    category: 'object',
    color,
    glyph,
    tagline,
    note: o.note,
    fields: awsFields({ ...o, bucket: true, pathStyle: o.pathStyle ?? false }),
  };
}
