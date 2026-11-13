// AWS Signature Version 4, for S3 (and what speaks S3: MinIO, R2, Spaces,
// B2, GCS's interop), SQS and DynamoDB, with node:crypto: no SDK. Keys come
// from the connection, else the server's environment (AWS_ACCESS_KEY_ID…),
// else ~/.aws/credentials (the profile named, or AWS_PROFILE, or default).

import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginError } from '@hyperpane/sdk/server';
import type { Values } from '../../shared/kinds.ts';

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export const sha256hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, as AWS wants it ('/' kept when `slash`). */
export function uriEncode(s: string, slash = false): string {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c) || (slash && c === '/')) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** An INI file's sections. */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section: Record<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = out[head[1].trim().replace(/^profile\s+/, '')] ??= {};
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (kv && section) section[kv[1].trim().toLowerCase()] = kv[2].trim();
  }
  return out;
}

/** The keys to sign with, from wherever they are. */
export async function credentialsOf(v: Values, home = os.homedir(), env = process.env): Promise<Credentials> {
  const id = String(v.accessKeyId ?? '').trim();
  const secret = String(v.secretAccessKey ?? '').trim();
  if (id && secret) return { accessKeyId: id, secretAccessKey: secret, sessionToken: v.sessionToken ? String(v.sessionToken) : undefined };
  if (id || secret) throw new PluginError(id ? 'Give the secret access key too.' : 'Give the access key ID too.');
  const profile = String(v.profile ?? '').trim() || env.AWS_PROFILE || 'default';
  if (!v.profile && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined };
  const file = env.AWS_SHARED_CREDENTIALS_FILE || path.join(home, '.aws', 'credentials');
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new PluginError(`There are no keys: give an access key, or put profile “${profile}” in ~/.aws/credentials on the server.`);
  }
  const p = parseIni(text)[profile];
  if (!p?.aws_access_key_id || !p?.aws_secret_access_key) throw new PluginError(`~/.aws/credentials on the server has no keys for profile “${profile}”.`);
  return { accessKeyId: p.aws_access_key_id, secretAccessKey: p.aws_secret_access_key, sessionToken: p.aws_session_token || undefined };
}

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** The body's SHA-256 (hex), or 'UNSIGNED-PAYLOAD'. */
  payloadHash: string;
  region: string;
  service: string;
  credentials: Credentials;
  date?: Date;
}

const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function signingKey(secret: string, day: string, region: string, service: string) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
}

/** The request's headers, signed (Authorization, x-amz-date, and the rest). */
export function sign(i: SignInput): Record<string, string> {
  const d = i.date ?? new Date();
  const stamp = amzDate(d);
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = { ...i.headers, host: i.url.host, 'x-amz-date': stamp };
  if (i.service === 's3') headers['x-amz-content-sha256'] = i.payloadHash;
  if (i.credentials.sessionToken) headers['x-amz-security-token'] = i.credentials.sessionToken;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const names = Object.keys(lower).sort();
  const canonical = [i.method, i.service === 's3' ? uriEncode(decodeURIComponent(i.url.pathname), true) : i.url.pathname || '/', canonicalQuery(i.url), names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), i.payloadHash].join('\n');
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(i.credentials.secretAccessKey, day, i.region, i.service)).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

/** A presigned GET link (S3), good for `seconds`. */
export function presign(o: { url: URL; region: string; credentials: Credentials; seconds: number; date?: Date }): string {
  const d = o.date ?? new Date();
  const stamp = amzDate(d);
  const day = stamp.slice(0, 8);
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const url = new URL(o.url);
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${o.credentials.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', stamp);
  url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.min(604800, Math.round(o.seconds)))));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  if (o.credentials.sessionToken) url.searchParams.set('X-Amz-Security-Token', o.credentials.sessionToken);
  const canonical = ['GET', uriEncode(decodeURIComponent(url.pathname), true), canonicalQuery(url), `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(o.credentials.secretAccessKey, day, o.region, 's3')).update(toSign).digest('hex');
  url.searchParams.set('X-Amz-Signature', signature);
  return url.toString();
}

/** What an AWS error body says (XML or JSON), for the user. */
export function awsError(status: number, body: string): string {
  const xml = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)?.[1];
  let code = xml('Code');
  let message = xml('Message');
  if (!code) {
    try {
      const j = JSON.parse(body) as { __type?: string; message?: string; Message?: string };
      code = j.__type?.split('#').pop();
      message = j.message ?? j.Message;
    } catch {}
  }
  const hint: Record<string, string> = {
    InvalidAccessKeyId: 'The access key ID isn’t one the service knows.',
    SignatureDoesNotMatch: 'The secret access key is wrong (or the region is).',
    AccessDenied: 'The keys may not do that.',
    NoSuchBucket: 'There’s no such bucket.',
    UnrecognizedClientException: 'The access key ID isn’t one the service knows.',
    InvalidSignatureException: 'The secret access key is wrong (or the region is).',
    ExpiredToken: 'The session token has expired.',
  };
  return [code && hint[code] ? hint[code] : null, message ?? (code ? code : `HTTP ${status}`)].filter(Boolean).join(' ');
}
