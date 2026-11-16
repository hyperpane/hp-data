// HTTP for the engines that speak it (ClickHouse, Elasticsearch, etcd,
// RabbitMQ's management API, S3, SQS, DynamoDB), with node:http(s): a
// timeout, any certificate when the connection says so, and errors said
// for the user ("Nothing answers at localhost:9200.").

import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { PluginError } from '@hyperpane/sdk/server';
import type { TlsOptions } from './tls.ts';

export interface HttpRequest {
  method?: string;
  url: string | URL;
  headers?: Record<string, string>;
  body?: string | Uint8Array | Readable | null;
  /** Accept any certificate. */
  insecure?: boolean;
  /** The connection's own CA, client certificate, server name. */
  tls?: TlsOptions;
  /** ms until it gives up: connecting and between bytes. */
  timeout?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** Why a connection failed, for the user. */
export function netError(e: NodeJS.ErrnoException, where: string): PluginError {
  const code = e.code ?? '';
  const say: Record<string, string> = {
    ECONNREFUSED: `Nothing answers at ${where}: is it running, on that port?`,
    ENOTFOUND: `There’s no host ${where.replace(/:\d+$/, '')}: check the name.`,
    EAI_AGAIN: `Couldn’t look up ${where.replace(/:\d+$/, '')}: is the network up?`,
    ETIMEDOUT: `${where} didn’t answer in time: a firewall, a VPN, or the wrong address?`,
    ECONNRESET: `${where} closed the connection: TLS where it isn’t, or the other way round?`,
    EHOSTUNREACH: `${where} can’t be reached from the server.`,
    ENETUNREACH: `The network ${where} is on can’t be reached from the server.`,
    DEPTH_ZERO_SELF_SIGNED_CERT: `${where} has a self-signed certificate: accept any certificate in the connection’s options, if you trust it.`,
    SELF_SIGNED_CERT_IN_CHAIN: `${where}’s certificate is signed by an authority the server doesn’t know.`,
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: `${where}’s certificate can’t be checked.`,
    CERT_HAS_EXPIRED: `${where}’s certificate has expired.`,
    ERR_TLS_CERT_ALTNAME_INVALID: `${where}’s certificate is for another name.`,
    EPROTO: `${where} doesn’t speak TLS there: try http://.`,
  };
  return new PluginError(say[code] ?? `${where}: ${e.message}`);
}

/** Sends it and waits for the whole answer. */
export function request(r: HttpRequest): Promise<HttpResponse> {
  return open(r).then(
    (res) =>
      new Promise<HttpResponse>((resolve, reject) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }),
  );
}

/** Sends it; the answer's body is read as it comes. */
export function open(r: HttpRequest): Promise<http.IncomingMessage> {
  const url = typeof r.url === 'string' ? new URL(r.url) : r.url;
  const where = url.host;
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    if (r.signal?.aborted) return reject(new PluginError('Cancelled.'));
    const req = lib.request(
      url,
      {
        method: r.method ?? 'GET',
        headers: r.headers,
        ...(url.protocol === 'https:' ? r.tls : {}),
        rejectUnauthorized: !r.insecure,
        timeout: r.timeout ?? 30_000,
      },
      (res) => resolve(res),
    );
    const abort = () => req.destroy(new PluginError('Cancelled.'));
    r.signal?.addEventListener('abort', abort, { once: true });
    req.on('close', () => r.signal?.removeEventListener('abort', abort));
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e: NodeJS.ErrnoException) => reject(e instanceof PluginError ? e : netError(e, where)));
    const body = r.body;
    if (body instanceof Readable) body.pipe(req);
    else req.end(body ?? undefined);
  });
}

/** JSON in and out; a status of 400 or more is an error, said with what
 * the body says (its `error.reason`, `message`, or the text). */
export async function json<T = unknown>(r: HttpRequest & { json?: unknown }, explain?: (status: number, body: string) => string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...r.headers };
  let body = r.body;
  if (r.json !== undefined) {
    body = JSON.stringify(r.json);
    headers['content-type'] ??= 'application/json';
  }
  const res = await request({ ...r, headers, body });
  const text = res.body.toString('utf8');
  if (res.status >= 400) throw new PluginError(explain ? explain(res.status, text) : statusError(res.status, text));
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PluginError(`The answer wasn’t JSON: ${text.slice(0, 200)}`);
  }
}

/** An error body's shapes: Elasticsearch's and the like. */
interface ErrorBody {
  reason?: string;
  root_cause?: { reason?: string }[];
}

/** A status and a body as a sentence. */
export function statusError(status: number, text: string): string {
  let said = text.trim();
  try {
    const j = JSON.parse(text) as { error?: string | ErrorBody; message?: string; reason?: string };
    const e = j.error as ErrorBody | undefined;
    said = e?.root_cause?.[0]?.reason ?? e?.reason ?? (typeof j.error === 'string' ? j.error : null) ?? j.message ?? j.reason ?? said;
  } catch {}
  if (status === 401) return `Signing in failed: check the user and password.${said ? ` (${said.slice(0, 200)})` : ''}`;
  if (status === 403) return `Not allowed: ${said.slice(0, 300) || 'the user may not do that.'}`;
  return `${status}: ${said.slice(0, 500) || http.STATUS_CODES[status] || 'failed'}`;
}

export const basic = (user: unknown, password: unknown): Record<string, string> =>
  user || password ? { authorization: `Basic ${Buffer.from(`${user ?? ''}:${password ?? ''}`).toString('base64')}` } : {};
