// One S3 connection's requests, signed: where each goes (address.ts), the
// keys it signs with (from the connection, the environment or ~/.aws), and
// a bucket's own region, found on first use (AWS answers a HEAD of the
// bucket with `x-amz-bucket-region`, even when it refuses it) and kept;
// a request sent to the wrong region anyway is sent again to the right one.

import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { PluginError } from '@hyperpane/sdk/server';
import type { Values } from '../../../shared/kinds.ts';
import { type Credentials, awsError, credentialsOf, presign, sha256hex, sign } from '../../aws/sigv4.ts';
import { type HttpResponse, open, request } from '../../net/http.ts';
import { type Endpoint, endpointOf, urlFor } from './address.ts';
import { parseError } from './xml.ts';

export interface S3Request {
  method: string;
  bucket?: string;
  key?: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  /** Signed with its hash. */
  body?: string | Uint8Array;
  /** Sent as it comes, UNSIGNED-PAYLOAD (give content-length). */
  stream?: ReadableStream<Uint8Array> | Readable;
  signal?: AbortSignal;
  timeout?: number;
  /** Statuses that aren't errors here (404 for a HEAD that looks). */
  ok?: number[];
}

/** What a failed request means, for the user: the body's code and
 * message, else the status. */
function s3Error(status: number, body: string, what?: string): PluginError {
  if (body.trim()) return new PluginError(awsError(status, body));
  const say: Record<number, string> = {
    301: 'The bucket is in another region, at another endpoint.',
    403: 'The keys may not do that.',
    404: what ? `There’s no ${what}.` : 'It isn’t there.',
    412: 'It changed meanwhile.',
  };
  return new PluginError(say[status] ?? `HTTP ${status}`);
}

export class S3Client {
  readonly endpoint: Endpoint;
  readonly region: string;
  readonly pathStyle: boolean;
  readonly #values: Values;
  #creds: Promise<Credentials> | null = null;
  readonly #regions = new Map<string, Promise<string>>();

  constructor(values: Values) {
    this.#values = values;
    this.region = String(values.region ?? '').trim() || 'us-east-1';
    this.endpoint = endpointOf(String(values.endpoint ?? ''), this.region);
    this.pathStyle = values.pathStyle === true || values.pathStyle === 'true';
  }

  credentials(): Promise<Credentials> {
    this.#creds ??= credentialsOf(this.#values).catch((e) => {
      this.#creds = null;
      throw e;
    });
    return this.#creds;
  }

  /** The region a bucket is in: AWS's says; elsewhere the connection's. */
  regionOf(bucket: string): Promise<string> {
    if (!this.endpoint.aws) return Promise.resolve(this.region);
    let p = this.#regions.get(bucket);
    if (!p) {
      p = this.#find(bucket).catch(() => this.region);
      this.#regions.set(bucket, p);
    }
    return p;
  }

  async #find(bucket: string): Promise<string> {
    const url = urlFor(this.endpoint, { bucket, region: this.region, pathStyle: this.pathStyle });
    const headers = sign({
      method: 'HEAD',
      url,
      headers: {},
      payloadHash: sha256hex(''),
      region: this.region,
      service: 's3',
      credentials: await this.credentials(),
    });
    const res = await request({ method: 'HEAD', url, headers, timeout: 15_000 });
    return headerOf(res.headers, 'x-amz-bucket-region') || this.region;
  }

  /** Remembers where a bucket is, from an answer that said so. */
  #learn(bucket: string, headers: IncomingHttpHeaders, body: string): string | null {
    const region = headerOf(headers, 'x-amz-bucket-region') || parseError(body).region;
    if (!region) return null;
    this.#regions.set(bucket, Promise.resolve(region));
    return region;
  }

  async #signed(r: S3Request, region: string) {
    const url = urlFor(this.endpoint, { bucket: r.bucket, key: r.key, query: r.query, region: r.bucket ? region : undefined, pathStyle: this.pathStyle });
    const payloadHash = r.stream ? 'UNSIGNED-PAYLOAD' : sha256hex(r.body ?? '');
    const headers = sign({ method: r.method, url, headers: r.headers ?? {}, payloadHash, region, service: 's3', credentials: await this.credentials() });
    return { url, headers };
  }

  /** Sends it and waits for the whole answer; an error status throws. */
  async send(r: S3Request, what?: string): Promise<HttpResponse> {
    let region = r.bucket ? await this.regionOf(r.bucket) : this.region;
    for (let attempt = 0; ; attempt++) {
      const { url, headers } = await this.#signed(r, region);
      const res = await request({ method: r.method, url, headers, body: r.stream ? toNode(r.stream) : (r.body ?? null), signal: r.signal, timeout: r.timeout });
      if (res.status < 300 || r.ok?.includes(res.status)) return res;
      const text = res.body.toString('utf8');
      if (attempt === 0 && r.bucket && !r.stream && isWrongRegion(res.status, text)) {
        const next = this.#learn(r.bucket, res.headers, text);
        if (next && next !== region) {
          region = next;
          continue;
        }
      }
      throw s3Error(res.status, text, what);
    }
  }

  /** Sends it; the answer's body comes as it's read (an error status
   * throws, with what its body says). */
  async open(r: S3Request, what?: string): Promise<IncomingMessage> {
    let region = r.bucket ? await this.regionOf(r.bucket) : this.region;
    for (let attempt = 0; ; attempt++) {
      const { url, headers } = await this.#signed(r, region);
      const res = await open({ method: r.method, url, headers, body: r.stream ? toNode(r.stream) : (r.body ?? null), signal: r.signal, timeout: r.timeout });
      const status = res.statusCode ?? 0;
      if (status < 300 || r.ok?.includes(status)) return res;
      const text = await readText(res);
      if (attempt === 0 && r.bucket && !r.stream && isWrongRegion(status, text)) {
        const next = this.#learn(r.bucket, res.headers, text);
        if (next && next !== region) {
          region = next;
          continue;
        }
      }
      throw s3Error(status, text, what);
    }
  }

  /** A GET link anyone can open for `seconds`. */
  async presign(bucket: string, key: string, seconds: number): Promise<string> {
    const region = await this.regionOf(bucket);
    const url = urlFor(this.endpoint, { bucket, key, region, pathStyle: this.pathStyle });
    return presign({ url, region, credentials: await this.credentials(), seconds });
  }
}

const isWrongRegion = (status: number, body: string) =>
  status === 301 || status === 307 || (status === 400 && /AuthorizationHeaderMalformed|IllegalLocationConstraintException/.test(body));

export function headerOf(h: IncomingHttpHeaders, name: string): string {
  const v = h[name];
  return Array.isArray(v) ? v.join(', ') : (v ?? '');
}

const toNode = (s: ReadableStream<Uint8Array> | Readable): Readable =>
  s instanceof Readable ? s : Readable.fromWeb(s as import('node:stream/web').ReadableStream<Uint8Array>);

async function readText(res: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
