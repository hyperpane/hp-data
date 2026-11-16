// A small S3 in memory, for the object tests: path-style buckets, every
// request's SigV4 signature checked (and a signed payload's hash, and
// DeleteObjects' Content-MD5), ListObjectsV2 with delimiters and pages,
// ranges, copies, multipart uploads and presigned GETs.

import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { presign, sha256hex, sign } from '../../src/server/aws/sigv4.ts';

export interface Stored {
  body: Buffer;
  type: string;
  modified: Date;
  meta: Record<string, string>;
}

export const KEYS = { accessKeyId: 'AKFAKE', secretAccessKey: 'fake/secret+key' };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
const fromStamp = (s: string) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);

export async function fakeS3(o: { pageSize?: number } = {}) {
  const buckets = new Map<string, Map<string, Stored>>();
  const uploads = new Map<string, { bucket: string; key: string; type: string; parts: Map<number, Buffer> }>();
  const log: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const fail = (status: number, code: string, message = code) => {
      res.writeHead(status, { 'content-type': 'application/xml' });
      res.end(req.method === 'HEAD' ? undefined : `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${esc(message)}</Message></Error>`);
    };
    const why = checkSignature(req, url, body);
    if (why) return fail(403, 'SignatureDoesNotMatch', why);
    const [, bucketName, ...rest] = url.pathname.split('/');
    const bucket = decodeURIComponent(bucketName ?? '');
    const key = decodeURIComponent(rest.join('/'));
    const q = url.searchParams;
    log.push(`${req.method} ${bucket}${key ? `/${key}` : ''}${url.search}`);
    const xml = (s: string, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/xml' });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>${s}`);
    };
    if (!bucket)
      return xml(
        `<ListAllMyBucketsResult><Buckets>${[...buckets.keys()].map((b) => `<Bucket><Name>${b}</Name><CreationDate>2024-01-01T00:00:00.000Z</CreationDate></Bucket>`).join('')}</Buckets></ListAllMyBucketsResult>`,
      );
    const b = buckets.get(bucket);
    if (!key && req.method === 'PUT') {
      if (b) return fail(409, 'BucketAlreadyOwnedByYou');
      buckets.set(bucket, new Map());
      return xml('');
    }
    if (!b) return fail(404, 'NoSuchBucket', 'The specified bucket does not exist');
    if (!key && req.method === 'GET') {
      const prefix = q.get('prefix') ?? '';
      const delimiter = q.get('delimiter');
      const max = Math.min(Number(q.get('max-keys') ?? 1000), o.pageSize ?? 1000);
      const after = q.get('continuation-token') ?? '';
      const items: { key: string; prefix?: boolean }[] = [];
      const seen = new Set<string>();
      for (const k of [...b.keys()].sort()) {
        if (!k.startsWith(prefix)) continue;
        const i = delimiter ? k.indexOf(delimiter, prefix.length) : -1;
        if (i >= 0) {
          const p = k.slice(0, i + 1);
          if (!seen.has(p)) {
            seen.add(p);
            items.push({ key: p, prefix: true });
          }
        } else items.push({ key: k });
      }
      const from = items.filter((x) => x.key > after);
      const page = from.slice(0, max);
      const url = q.get('encoding-type') === 'url';
      const name = (s: string) => esc(url ? enc(s) : s);
      return xml(
        `<ListBucketResult><Name>${bucket}</Name>${url ? '<EncodingType>url</EncodingType>' : ''}<IsTruncated>${from.length > max}</IsTruncated>${from.length > max ? `<NextContinuationToken>${esc(page[page.length - 1].key)}</NextContinuationToken>` : ''}${page
          .map((x) =>
            x.prefix
              ? `<CommonPrefixes><Prefix>${name(x.key)}</Prefix></CommonPrefixes>`
              : `<Contents><Key>${name(x.key)}</Key><LastModified>${b.get(x.key)!.modified.toISOString()}</LastModified><ETag>"${md5hex(b.get(x.key)!.body)}"</ETag><Size>${b.get(x.key)!.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
          )
          .join('')}</ListBucketResult>`,
      );
    }
    if (!key && req.method === 'HEAD') {
      res.writeHead(200);
      return res.end();
    }
    if (!key && req.method === 'POST' && q.has('delete')) {
      if (req.headers['content-md5'] !== createHash('md5').update(body).digest('base64')) return fail(400, 'InvalidDigest');
      const keys = [...body.toString('utf8').matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) =>
        m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
      );
      for (const k of keys) b.delete(k);
      return xml('<DeleteResult></DeleteResult>');
    }
    if (req.method === 'POST' && q.has('uploads')) {
      const id = `u${uploads.size + 1}`;
      uploads.set(id, { bucket, key, type: String(req.headers['content-type'] ?? ''), parts: new Map() });
      return xml(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (req.method === 'PUT' && q.has('partNumber')) {
      const u = uploads.get(q.get('uploadId')!);
      if (!u) return fail(404, 'NoSuchUpload');
      u.parts.set(Number(q.get('partNumber')), body);
      res.writeHead(200, { etag: `"${md5hex(body)}"` });
      return res.end();
    }
    if (req.method === 'POST' && q.has('uploadId')) {
      const u = uploads.get(q.get('uploadId')!)!;
      const nums = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
      b.set(key, { body: Buffer.concat(nums.map((n) => u.parts.get(n)!)), type: u.type, modified: new Date(), meta: {} });
      uploads.delete(q.get('uploadId')!);
      return xml('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
    }
    if (req.method === 'DELETE' && q.has('uploadId')) {
      uploads.delete(q.get('uploadId')!);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'PUT') {
      const source = req.headers['x-amz-copy-source'];
      if (source) {
        const [, sb, ...sk] = decodeURIComponent(String(source)).split('/');
        const from = buckets.get(sb)?.get(sk.join('/'));
        if (!from) return fail(404, 'NoSuchKey');
        b.set(key, { ...from, modified: new Date() });
        return xml('<CopyObjectResult></CopyObjectResult>');
      }
      const meta = Object.fromEntries(
        Object.entries(req.headers)
          .filter(([k]) => k.startsWith('x-amz-meta-'))
          .map(([k, v]) => [k, String(v)]),
      );
      b.set(key, { body, type: String(req.headers['content-type'] ?? 'binary/octet-stream'), modified: new Date(), meta });
      res.writeHead(200, { etag: `"${md5hex(body)}"` });
      return res.end();
    }
    const obj = b.get(key);
    if (req.method === 'DELETE') {
      b.delete(key);
      res.writeHead(204);
      return res.end();
    }
    if (!obj) return fail(404, 'NoSuchKey', 'The specified key does not exist.');
    const headers = { 'content-type': obj.type, 'last-modified': obj.modified.toUTCString(), etag: `"${md5hex(obj.body)}"`, ...obj.meta };
    const range = /^bytes=(\d+)-(\d+)?$/.exec(String(req.headers.range ?? ''));
    if (range) {
      const start = Number(range[1]);
      if (start >= obj.body.length) return fail(416, 'InvalidRange');
      const end = Math.min(obj.body.length - 1, range[2] ? Number(range[2]) : obj.body.length - 1);
      res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${obj.body.length}` });
      return res.end(req.method === 'HEAD' ? undefined : obj.body.subarray(start, end + 1));
    }
    res.writeHead(200, { ...headers, 'content-length': obj.body.length });
    res.end(req.method === 'HEAD' ? undefined : obj.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { buckets, uploads, log, port, endpoint: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const md5hex = (b: Buffer) => createHash('md5').update(b).digest('hex');

/** Why the request's signature is wrong, or null. */
function checkSignature(req: http.IncomingMessage, url: URL, body: Buffer): string | null {
  const credentials = KEYS;
  if (url.searchParams.has('X-Amz-Signature')) {
    const [, day, region] = /^[^/]+\/(\d{8})\/([^/]+)\//.exec(url.searchParams.get('X-Amz-Credential') ?? '') ?? [];
    const base = new URL(url);
    for (const k of [...base.searchParams.keys()]) if (k.startsWith('X-Amz-')) base.searchParams.delete(k);
    const again = new URL(
      presign({ url: base, region, credentials, seconds: Number(url.searchParams.get('X-Amz-Expires')), date: fromStamp(url.searchParams.get('X-Amz-Date')!) }),
    );
    return day && again.searchParams.get('X-Amz-Signature') === url.searchParams.get('X-Amz-Signature') ? null : 'presigned signature differs';
  }
  const auth = String(req.headers.authorization ?? '');
  const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(auth);
  if (!m) return 'no signature';
  if (m[1] !== credentials.accessKeyId) return 'unknown key';
  const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
  if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== sha256hex(body)) return 'payload hash differs';
  const names = m[4].split(';');
  const headers: Record<string, string> = {};
  for (const n of names) if (!['host', 'x-amz-date', 'x-amz-content-sha256'].includes(n)) headers[n] = String(req.headers[n] ?? '');
  const again = sign({
    method: req.method!,
    url,
    headers,
    payloadHash,
    region: m[3],
    service: 's3',
    credentials,
    date: fromStamp(String(req.headers['x-amz-date'])),
  });
  return again.authorization === auth ? null : 'signature differs';
}
