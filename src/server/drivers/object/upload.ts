// Putting an object: bytes in hand go in one signed PUT; a stream of a
// known size up to 100 MB goes as it comes (UNSIGNED-PAYLOAD with its
// content-length, over HTTPS); anything bigger, of no known size, or over
// plain HTTP (where a payload should be signed) goes in parts of 16 MB or
// more, each signed (a multipart upload, given up if it fails).

import { Readable } from 'node:stream';
import { PluginError } from '@hyperpane/sdk/server';
import type { S3Client } from './client.ts';
import { headerOf } from './client.ts';
import { completeBody, text } from './xml.ts';

const MIB = 1024 * 1024;
export const STREAM_MAX = 100 * MIB;
const PART_MIN = 16 * MIB;
const MAX_PARTS = 10_000;

export interface PutOptions {
  size?: number;
  contentType?: string;
  signal?: AbortSignal;
}

export async function putObject(c: S3Client, bucket: string, key: string, body: ReadableStream<Uint8Array> | Uint8Array, o: PutOptions): Promise<void> {
  const type = o.contentType || 'application/octet-stream';
  if (body instanceof Uint8Array) {
    await c.send({ method: 'PUT', bucket, key, body, headers: { 'content-type': type, 'content-length': String(body.length) }, signal: o.signal });
    return;
  }
  const size = typeof o.size === 'number' && o.size >= 0 ? o.size : undefined;
  if (size !== undefined && size <= PART_MIN) {
    const bytes = await readAll(body, size);
    await c.send({ method: 'PUT', bucket, key, body: bytes, headers: { 'content-type': type, 'content-length': String(bytes.length) }, signal: o.signal });
    return;
  }
  if (size !== undefined && size <= STREAM_MAX && c.endpoint.protocol === 'https:') {
    const piped = Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
    await c.send({ method: 'PUT', bucket, key, stream: piped, headers: { 'content-type': type, 'content-length': String(size) }, signal: o.signal, timeout: 120_000 });
    return;
  }
  await multipart(c, bucket, key, body, { ...o, contentType: type, size });
}

async function multipart(c: S3Client, bucket: string, key: string, body: ReadableStream<Uint8Array>, o: PutOptions): Promise<void> {
  const partSize = Math.max(PART_MIN, o.size ? Math.ceil(o.size / (MAX_PARTS - 1)) : 64 * MIB);
  const started = await c.send({ method: 'POST', bucket, key, query: { uploads: '' }, headers: { 'content-type': o.contentType! }, signal: o.signal });
  const uploadId = text(started.body.toString('utf8'), 'UploadId');
  if (!uploadId) throw new PluginError('The service didn’t start the upload (no UploadId).');
  const parts: { n: number; etag: string }[] = [];
  try {
    for await (const part of chunks(body, partSize)) {
      const n = parts.length + 1;
      if (n > MAX_PARTS) throw new PluginError('The file is too big for one upload (10,000 parts).');
      const res = await c.send({ method: 'PUT', bucket, key, query: { partNumber: n, uploadId }, body: part, headers: { 'content-length': String(part.length) }, signal: o.signal, timeout: 120_000 });
      parts.push({ n, etag: headerOf(res.headers, 'etag') });
    }
    if (!parts.length) {
      // Nothing came: an empty object, not an upload of no parts.
      await abort(c, bucket, key, uploadId);
      await c.send({ method: 'PUT', bucket, key, body: new Uint8Array(0), headers: { 'content-type': o.contentType!, 'content-length': '0' } });
      return;
    }
    const res = await c.send({ method: 'POST', bucket, key, query: { uploadId }, body: completeBody(parts), headers: { 'content-type': 'application/xml' }, signal: o.signal, timeout: 300_000 });
    // CompleteMultipartUpload may say 200 and still have failed.
    const said = res.body.toString('utf8');
    if (/<Error>/.test(said)) throw new PluginError(`${text(said, 'Code') ?? 'Error'}: ${text(said, 'Message') ?? 'the upload didn’t complete.'}`);
  } catch (e) {
    await abort(c, bucket, key, uploadId).catch(() => {});
    throw e;
  }
}

const abort = (c: S3Client, bucket: string, key: string, uploadId: string) => c.send({ method: 'DELETE', bucket, key, query: { uploadId } });

/** The stream in pieces of `size` bytes (the last one shorter). */
export async function* chunks(body: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  let held: Uint8Array[] = [];
  let length = 0;
  for await (const c of body as unknown as AsyncIterable<Uint8Array>) {
    let chunk = c;
    while (length + chunk.length >= size) {
      const take = size - length;
      held.push(chunk.subarray(0, take));
      yield Buffer.concat(held);
      chunk = chunk.subarray(take);
      held = [];
      length = 0;
    }
    if (chunk.length) {
      held.push(chunk);
      length += chunk.length;
    }
  }
  if (length) yield Buffer.concat(held);
}

/** All of a stream, up to `max` bytes (more is an error). */
export async function readAll(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const held: Uint8Array[] = [];
  let length = 0;
  for await (const c of body as unknown as AsyncIterable<Uint8Array>) {
    length += c.length;
    if (length > max) throw new PluginError(`The file is bigger than it said (${max} bytes).`);
    held.push(c);
  }
  return Buffer.concat(held);
}
