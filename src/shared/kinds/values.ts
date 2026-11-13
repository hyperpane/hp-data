// A connection's values: defaults filled in, its secret fields, which
// fields show, where it points in a few words, and a pasted connection
// string read into fields.

import { KINDS } from './catalog.ts';
import type { Field, Kind, Values } from './types.ts';

/** Whether a field shows, given the form's values (its `when`). */
export function shown(f: Field, values: Values, kind: Kind): boolean {
  if (!f.when) return true;
  const field = kind.fields.find((x) => x.key === f.when!.key);
  const v = values[f.when.key] ?? field?.default;
  if (field?.when && !shown(field, values, kind)) return false;
  return f.when.is.includes(v as string | number | boolean);
}

export const kindOf = (id: string): Kind | undefined => KINDS.find((k) => k.id === id);

/** A kind's values with its defaults filled in. */
export function withDefaults(kind: Kind, values: Values): Values {
  const out: Values = {};
  for (const f of kind.fields) {
    const v = values[f.key];
    if (v !== undefined && v !== '') out[f.key] = v;
    else if (f.default !== undefined && f.default !== '') out[f.key] = f.default;
  }
  return out;
}

/** The keys of a kind's secret fields. */
export const secretKeys = (kind: Kind): string[] => kind.fields.filter((f) => f.secret).map((f) => f.key);

/** Where a connection points, in a few words: "localhost:5432/shop",
 * "db:5432 via bastion". */
export function address(kind: Kind, values: Values): string {
  const at = where(kind, values);
  return values.sshEnabled && values.sshHost ? `${at} via ${values.sshHost}` : at;
}

function where(kind: Kind, values: Values): string {
  const v = withDefaults(kind, values);
  switch (kind.engine) {
    case 'sqlite':
      return String(v.file ?? '');
    case 'etcd':
    case 'elasticsearch':
    case 'rabbitmq':
      return String(v.url ?? '').replace(/^https?:\/\//, '');
    case 'kafka':
      return String(v.brokers ?? '');
    case 's3':
    case 'sqs':
    case 'dynamodb': {
      const ep = String(v.endpoint ?? '').replace(/^https?:\/\//, '');
      return [ep || `aws · ${v.region ?? 'us-east-1'}`, v.bucket].filter(Boolean).join(' / ');
    }
    default: {
      const hp = `${v.host ?? ''}${v.port ? `:${v.port}` : ''}`;
      return v.database !== undefined && v.database !== '' ? `${hp}/${v.database}` : kind.engine === 'redis' && v.db ? `${hp}/${v.db}` : hp;
    }
  }
}

/** Values from a pasted connection string (`postgres://u:p@h:5432/db?sslmode=require`),
 * or null when it isn't one for this kind. */
export function parseUrl(kind: Kind, text: string): Values | null {
  const s = text.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)?.[1]?.toLowerCase();
  if (!scheme || !kind.schemes?.includes(scheme)) return null;
  if (kind.engine === 'mongodb') return { uri: s };
  let u: URL;
  try {
    u = new URL(s.replace(/^[^:]+:/, 'http:'));
  } catch {
    return null;
  }
  const out: Values = {};
  if (u.hostname) out.host = decodeURIComponent(u.hostname.replace(/^\[|\]$/g, ''));
  if (u.port) out.port = Number(u.port);
  if (u.username) out.user = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (kind.engine === 'redis') {
    if (/^\d+$/.test(db)) out.db = Number(db);
    if (scheme === 'rediss') out.tls = true;
  } else if (db) out.database = db;
  const mode = u.searchParams.get('sslmode') ?? u.searchParams.get('ssl-mode') ?? (u.searchParams.get('ssl') === 'true' ? 'require' : null);
  if (mode && kind.fields.some((f) => f.key === 'ssl')) out.ssl = /verify/i.test(mode) ? 'verify' : /disable|false/i.test(mode) ? 'disable' : 'require';
  return out;
}
