// Where an S3 request goes: the endpoint (AWS's for the region when none is
// given), the bucket in the host name (virtual-hosted, as AWS wants) or in
// the path (path-style: MinIO, an IP, a bucket name with dots, which a
// wildcard certificate doesn't cover), the key encoded once, and a query
// string encoded as SigV4 signs it.

import { PluginError } from '@hyperpane/sdk/server';
import { uriEncode } from '../../aws/sigv4.ts';

export interface Endpoint {
  /** https: or http:. */
  protocol: string;
  /** host[:port], no bucket. */
  host: string;
  /** A path the endpoint has before buckets ('' mostly). */
  base: string;
  /** AWS's own (the region in the host name, buckets follow their region). */
  aws: boolean;
}

const isIp = (host: string) => /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host) || host.startsWith('[');
const isLocal = (host: string) => /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host) || isIp(host) || /\.local(:\d+)?$/.test(host);

/** The endpoint for the connection's values ('' is AWS in `region`). */
export function endpointOf(endpoint: string, region: string): Endpoint {
  const raw = endpoint.trim();
  if (!raw) return { protocol: 'https:', host: awsHost(region), base: '', aws: true };
  if (/[<>]/.test(raw)) throw new PluginError(`The endpoint “${raw}” still has a placeholder in it: put your own (the account ID, the region) in its place.`);
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `${isLocal(raw) ? 'http' : 'https'}://${raw}`);
  } catch {
    throw new PluginError(`“${raw}” isn’t an endpoint: give it as https://host[:port].`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new PluginError(`The endpoint should start with https:// or http://, not ${url.protocol}//.`);
  return { protocol: url.protocol, host: url.host, base: url.pathname.replace(/\/+$/, ''), aws: /(^|\.)amazonaws\.com(\.cn)?$/.test(url.hostname) };
}

const awsHost = (region: string) => `s3.${region || 'us-east-1'}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`;

/** Whether the bucket goes in the path rather than the host name. */
export function pathStyleFor(e: Endpoint, bucket: string, pathStyle: boolean): boolean {
  return pathStyle || bucket.includes('.') || isLocal(e.host) || !/^[a-z0-9][a-z0-9-]*$/.test(bucket);
}

/** A query string as SigV4 signs it: each name and value RFC 3986 encoded,
 * a name without a value as `name=`. */
export function queryString(q: Record<string, string | number | undefined>): string {
  return Object.entries(q)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(String(v))}`)
    .join('&');
}

/** The URL of a bucket (and a key in it), or of the service (no bucket). */
export function urlFor(
  e: Endpoint,
  o: { bucket?: string; key?: string; region?: string; pathStyle?: boolean; query?: Record<string, string | number | undefined> },
): URL {
  let host = e.host;
  if (e.aws && o.region) host = awsHost(o.region);
  let path = e.base;
  if (o.bucket) {
    if (pathStyleFor({ ...e, host }, o.bucket, !!o.pathStyle)) path += `/${uriEncode(o.bucket)}`;
    else host = `${o.bucket}.${host}`;
  }
  path += `/${o.key ? uriEncode(o.key, true) : ''}`;
  const url = new URL(`${e.protocol}//${host}${path}`);
  if (o.query) url.search = queryString(o.query);
  return url;
}

/** s3://bucket/key, as the CLI writes it. */
export const s3Uri = (bucket: string, key = '') => `s3://${bucket}/${key}`;
