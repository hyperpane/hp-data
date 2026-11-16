// The S3 driver, for AWS and what speaks its API (MinIO, R2, Spaces, B2,
// GCS's interop): buckets as the tree, a bucket's objects a page at a
// time by folder (common prefixes) or flat, heads, reads (a range, for a
// preview), puts (upload.ts), deletes (DeleteObjects, 1,000 at a time),
// copies, presigned links and new buckets. Requests are signed and
// addressed in client.ts.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { PluginError } from '@hyperpane/sdk/server';
import type { ObjectDetails } from '../../../shared/object.ts';
import type { SessionInfo, TreeNode } from '../../../shared/types.ts';
import type { ListRequest, ListResult } from '../../../shared/object.ts';
import type { DriverContext, Factory, ObjectDriver } from '../types.ts';
import { uriEncode } from '../../aws/sigv4.ts';
import { S3Client, headerOf } from './client.ts';
import { putObject } from './upload.ts';
import { type BucketEntry, createBucketBody, deleteBody, parseBuckets, parseDeleteErrors, parseList, text } from './xml.ts';

export const s3: Factory = (ctx) => new S3Driver(ctx);

const DELETE_BATCH = 1000;

export class S3Driver implements ObjectDriver {
  readonly family = 'object' as const;
  readonly client: S3Client;
  readonly #ctx: DriverContext;
  /** Only this bucket (the connection says). */
  readonly #bucket: string;

  constructor(ctx: DriverContext) {
    this.#ctx = ctx;
    this.client = new S3Client(ctx.values);
    this.#bucket = String(ctx.values.bucket ?? '').trim();
  }

  async info(): Promise<Omit<SessionInfo, 'at'>> {
    const c = this.client;
    const where = c.endpoint.aws ? `AWS ${c.region}` : `${c.endpoint.host}${c.region && c.region !== 'auto' ? ` · ${c.region}` : ''}`;
    if (this.#bucket) {
      await c.send({ method: 'GET', bucket: this.#bucket, query: { 'list-type': 2, 'max-keys': 1 } }, `bucket “${this.#bucket}”`);
      return { version: this.#ctx.kind.name, detail: `${where} · bucket ${this.#bucket}` };
    }
    try {
      const buckets = await this.buckets();
      return { version: this.#ctx.kind.name, detail: `${where} · ${buckets.length.toLocaleString('en-US')} bucket${buckets.length === 1 ? '' : 's'}` };
    } catch (e) {
      // Keys that may not list buckets may still use one: say so, don't fail.
      if (e instanceof PluginError && /AccessDenied|may not/.test(e.message))
        return { version: this.#ctx.kind.name, detail: `${where} · these keys may not list buckets` };
      throw e;
    }
  }

  async buckets(): Promise<BucketEntry[]> {
    const out: BucketEntry[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send({ method: 'GET', query: token ? { 'continuation-token': token } : undefined });
      const xml = res.body.toString('utf8');
      out.push(...parseBuckets(xml));
      token = text(xml, 'ContinuationToken') || undefined;
    } while (token);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async children(path: string[]): Promise<TreeNode[]> {
    if (path.length) return [];
    const node = (name: string, detail?: string): TreeNode => ({
      name,
      type: 'bucket',
      leaf: true,
      detail,
      open: { tab: 'bucket', ref: { bucket: name }, title: name },
    });
    if (this.#bucket) return [node(this.#bucket)];
    try {
      return (await this.buckets()).map((b) => node(b.name, b.region));
    } catch (e) {
      if (e instanceof PluginError && /AccessDenied|may not/.test(e.message))
        throw new PluginError('These keys may not list buckets: give the bucket in the connection’s settings.');
      throw e;
    }
  }

  async list(r: ListRequest, signal: AbortSignal): Promise<ListResult> {
    const prefix = r.prefix ?? '';
    const res = await this.client.send(
      {
        method: 'GET',
        bucket: r.bucket,
        query: {
          'list-type': 2,
          prefix: prefix || undefined,
          delimiter: r.flat ? undefined : '/',
          'continuation-token': r.token || undefined,
          'max-keys': 1000,
          'encoding-type': 'url',
        },
        signal,
      },
      `bucket “${r.bucket}”`,
    );
    const out = parseList(res.body.toString('utf8'));
    // The folder's own marker (an empty "prefix/" object) isn't in it.
    out.objects = out.objects.filter((o) => o.key !== prefix);
    return out;
  }

  async head(bucket: string, key: string): Promise<ObjectDetails> {
    const res = await this.client.send({ method: 'HEAD', bucket, key }, `object “${key}”`);
    const h = res.headers;
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(h))
      if (k.startsWith('x-amz-meta-')) metadata[k.slice(11)] = decodeMeta(Array.isArray(v) ? v.join(', ') : String(v ?? ''));
    const storage = headerOf(h, 'x-amz-storage-class');
    const at = Date.parse(headerOf(h, 'last-modified'));
    return {
      key,
      size: Number(headerOf(h, 'content-length')) || 0,
      modified: Number.isFinite(at) ? at : null,
      contentType: headerOf(h, 'content-type') || null,
      etag: headerOf(h, 'etag').replace(/^"|"$/g, '') || null,
      metadata,
      storageClass: storage || undefined,
      system: pick(h, ['cache-control', 'content-encoding', 'content-disposition', 'expires', 'x-amz-version-id', 'x-amz-server-side-encryption']),
    };
  }

  async read(bucket: string, key: string, o: { limit?: number; signal: AbortSignal }) {
    const headers: Record<string, string> = o.limit ? { range: `bytes=0-${Math.max(0, o.limit - 1)}` } : {};
    // An empty object has no byte 0: a range of it is 416.
    const res = await this.client.open({ method: 'GET', bucket, key, headers, signal: o.signal, timeout: 120_000, ok: [416] }, `object “${key}”`);
    const contentType = headerOf(res.headers, 'content-type') || null;
    if (res.statusCode === 416) {
      res.resume();
      return { body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }), size: 0, contentType };
    }
    const range = /\/(\d+)$/.exec(headerOf(res.headers, 'content-range'));
    const size = range ? Number(range[1]) : Number(headerOf(res.headers, 'content-length')) || 0;
    return { body: Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, size, contentType };
  }

  async write(
    bucket: string,
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    o: { size?: number; contentType?: string; signal?: AbortSignal },
  ): Promise<void> {
    await putObject(this.client, bucket, key, body, o);
  }

  async remove(bucket: string, keys: string[]): Promise<number> {
    let done = 0;
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      if (batch.length === 1) {
        await this.client.send({ method: 'DELETE', bucket, key: batch[0] });
        done++;
        continue;
      }
      const body = deleteBody(batch);
      const md5 = createHash('md5').update(body).digest('base64');
      let res: Awaited<ReturnType<S3Client['send']>>;
      try {
        res = await this.client.send({
          method: 'POST',
          bucket,
          query: { delete: '' },
          body,
          headers: { 'content-md5': md5, 'content-type': 'application/xml' },
        });
      } catch (e) {
        // GCS's interop has no DeleteObjects: one at a time there.
        if (e instanceof PluginError && /NotImplemented|not implemented|InvalidArgument/i.test(e.message)) {
          for (const key of batch) await this.client.send({ method: 'DELETE', bucket, key });
          done += batch.length;
          continue;
        }
        throw e;
      }
      const errors = parseDeleteErrors(res.body.toString('utf8'));
      done += batch.length - errors.length;
      if (errors.length)
        throw new PluginError(
          `${done.toLocaleString('en-US')} deleted; ${errors.length.toLocaleString('en-US')} couldn’t be: “${errors[0].key}”: ${errors[0].message || errors[0].code}`,
        );
    }
    return done;
  }

  async copy(bucket: string, from: string, to: string): Promise<void> {
    const res = await this.client.send(
      {
        method: 'PUT',
        bucket,
        key: to,
        headers: { 'x-amz-copy-source': `/${uriEncode(bucket)}/${uriEncode(from, true)}`, 'x-amz-metadata-directive': 'COPY' },
      },
      `object “${from}”`,
    );
    // A copy may say 200 and fail in its body.
    const said = res.body.toString('utf8');
    if (/<Error>/.test(said)) throw new PluginError(`Couldn’t copy “${from}”: ${text(said, 'Message') ?? text(said, 'Code') ?? 'it failed'}`);
  }

  presign(bucket: string, key: string, seconds: number): Promise<string> {
    return this.client.presign(bucket, key, seconds);
  }

  async createBucket(bucket: string): Promise<void> {
    const name = bucket.trim();
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name))
      throw new PluginError('A bucket’s name is 3 to 63 lowercase letters, digits, dots and hyphens, starting and ending with a letter or a digit.');
    const c = this.client;
    const constraint = c.endpoint.aws && c.region !== 'us-east-1';
    const body = constraint ? createBucketBody(c.region) : undefined;
    await c.send({ method: 'PUT', bucket: name, body, headers: body ? { 'content-type': 'application/xml' } : {} });
  }

  async close(): Promise<void> {}
}

/** Metadata values may be RFC 2047 encoded (=?UTF-8?B?…?=). */
function decodeMeta(v: string): string {
  const m = /^=\?utf-8\?([bq])\?(.*)\?=$/i.exec(v);
  if (!m) return v;
  try {
    return m[1].toLowerCase() === 'b'
      ? Buffer.from(m[2], 'base64').toString('utf8')
      : decodeURIComponent(m[2].replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, '%$1'));
  } catch {
    return v;
  }
}

function pick(h: import('node:http').IncomingHttpHeaders, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = headerOf(h, n);
    if (v) out[n] = v;
  }
  return out;
}
