// What S3 answers in XML, read without a dependency: the bucket list
// (ListAllMyBuckets), a page of objects (ListObjectsV2), DeleteObjects'
// errors, an error's code and region; and the XML we send (DeleteObjects,
// CreateBucket, CompleteMultipartUpload). S3's XML is flat and regular,
// so finding elements by name is enough.

import type { ListResult, ObjectEntry } from '../../../shared/object.ts';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Text with its entities (and CDATA) turned back into characters. */
export function unescapeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t: string) => t.replace(/&/g, '&amp;'))
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

export const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The raw insides of every `<tag>` (namespaced or not, with attributes). */
export function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>)`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1] ?? '');
}

/** The text of the first `<tag>`, or undefined. */
export function text(xml: string, tag: string): string | undefined {
  const b = blocks(xml, tag);
  return b.length ? unescapeXml(b[0]) : undefined;
}

export interface BucketEntry {
  name: string;
  created: number | null;
  region?: string;
}

/** ListAllMyBuckets: names and when each was made. */
export function parseBuckets(xml: string): BucketEntry[] {
  return blocks(xml, 'Bucket').map((b) => {
    const at = Date.parse(text(b, 'CreationDate') ?? '');
    return { name: text(b, 'Name') ?? '', created: Number.isFinite(at) ? at : null, region: text(b, 'BucketRegion') };
  });
}

/** encoding-type=url's names: percent-encoded, a space as '+'. */
function decodeName(s: string, url: boolean): string {
  if (!url) return s;
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** ListObjectsV2: folders (common prefixes), objects, and the next page. */
export function parseList(xml: string): ListResult {
  const url = text(xml, 'EncodingType')?.toLowerCase() === 'url';
  const objects: ObjectEntry[] = blocks(xml, 'Contents').map((c) => {
    const at = Date.parse(text(c, 'LastModified') ?? '');
    const etag = text(c, 'ETag');
    return {
      key: decodeName(text(c, 'Key') ?? '', url),
      size: Number(text(c, 'Size') ?? 0) || 0,
      modified: Number.isFinite(at) ? at : null,
      etag: etag ? etag.replace(/^"|"$/g, '') : undefined,
      storageClass: text(c, 'StorageClass'),
    };
  });
  const prefixes = blocks(xml, 'CommonPrefixes').map((p) => decodeName(text(p, 'Prefix') ?? '', url));
  const truncated = text(xml, 'IsTruncated') === 'true';
  const next = truncated ? (text(xml, 'NextContinuationToken') ?? null) : null;
  return { prefixes, objects, next };
}

/** DeleteObjects' answer: the keys it couldn't delete, and why. */
export function parseDeleteErrors(xml: string): { key: string; code: string; message: string }[] {
  return blocks(xml, 'Error').map((e) => ({ key: text(e, 'Key') ?? '', code: text(e, 'Code') ?? '', message: text(e, 'Message') ?? '' }));
}

/** An error's code, and the region it names (AuthorizationHeaderMalformed,
 * PermanentRedirect). */
export function parseError(xml: string): { code?: string; message?: string; region?: string; endpoint?: string } {
  return { code: text(xml, 'Code'), message: text(xml, 'Message'), region: text(xml, 'Region') ?? text(xml, 'BucketRegion'), endpoint: text(xml, 'Endpoint') };
}

export const deleteBody = (keys: string[]) => `<?xml version="1.0" encoding="UTF-8"?><Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${keys.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join('')}</Delete>`;

export const createBucketBody = (region: string) => `<?xml version="1.0" encoding="UTF-8"?><CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${escapeXml(region)}</LocationConstraint></CreateBucketConfiguration>`;

export const completeBody = (parts: { n: number; etag: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
