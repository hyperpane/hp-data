// The object family's calls: a bucket's objects a page at a time, an
// object's head, a preview of its first bytes, a download (a stream, for
// host.app.saveStream), an upload (the frame's stream), deleting (keys and
// whole folders, counted first when asked), copying and moving (a folder
// with everything in it), presigned links, and new buckets. Each names the
// connection by `id` and the bucket by `bucket`.

import { PluginError } from '@hyperpane/sdk/server';
import type { ObjectDriver } from '../drivers/types.ts';
import type { ListRequest } from '../../shared/object.ts';
import { PREVIEW_BYTES, type RemoveResult } from '../../shared/object.ts';
import { type Deps, type Group, idOf, int, projectOf, writable } from './context.ts';

interface Req {
  id: string;
  project?: string;
  bucket?: unknown;
  key?: unknown;
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new PluginError(`Say which ${what}.`);
  return v;
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
const baseName = (key: string) => key.replace(/\/+$/, '').split('/').pop() || key;

/** The keys named, and every key under the folders named, once each. */
async function expand(d: ObjectDriver, bucket: string, keys: string[], prefixes: string[], signal?: AbortSignal): Promise<string[]> {
  const all = new Set(keys);
  for (const p of prefixes) for (const k of await keysUnder(d, bucket, p, signal)) all.add(k);
  return [...all];
}

async function keysUnder(d: ObjectDriver, bucket: string, prefix: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const page = await d.list({ bucket, prefix, flat: true, token }, signal ?? new AbortController().signal);
    out.push(...page.objects.map((o) => o.key));
    token = page.next ?? undefined;
  } while (token);
  return out;
}

export function object(d: Deps): Group {
  const driver = (req: Req) => d.sessions.family(idOf(req), 'object', projectOf(req));
  return {
    calls: {
      objList: async (req: Req & Partial<ListRequest>, ctx) => {
        const o = await driver(req);
        return o.list(
          {
            bucket: str(req.bucket, 'bucket'),
            prefix: typeof req.prefix === 'string' ? req.prefix : '',
            token: typeof req.token === 'string' ? req.token : undefined,
            flat: req.flat === true,
          },
          ctx.signal,
        );
      },
      objHead: async (req: Req) => (await driver(req)).head(str(req.bucket, 'bucket'), str(req.key, 'object')),
      /** The first bytes (1 MB unless `limit` says), as bytes. */
      objRead: async (req: Req & { limit?: unknown }, ctx) => {
        const o = await driver(req);
        const limit = int(req.limit, PREVIEW_BYTES, 1, 16 * PREVIEW_BYTES);
        const r = await o.read(str(req.bucket, 'bucket'), str(req.key, 'object'), { limit, signal: ctx.signal });
        const chunks: Uint8Array[] = [];
        let length = 0;
        for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
          chunks.push(c);
          length += c.length;
          if (length >= limit) break;
        }
        const bytes = Buffer.concat(chunks).subarray(0, limit);
        return {
          bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length),
          size: r.size,
          contentType: r.contentType,
          truncated: r.size > bytes.length,
        };
      },
      /** The whole object, as a stream to save. */
      objDownload: async (req: Req, ctx) => {
        const o = await driver(req);
        const key = str(req.key, 'object');
        const r = await o.read(str(req.bucket, 'bucket'), key, { signal: ctx.signal });
        return { name: baseName(key), size: r.size, contentType: r.contentType, data: r.body };
      },
      /** Puts `data` (the frame's stream; none: an empty object, which is
       * how a folder is made, as `name/`). */
      objUpload: async (req: Req & { data?: ReadableStream<Uint8Array>; size?: unknown; contentType?: unknown }) => {
        const id = idOf(req);
        await writable(d, id);
        const o = await driver(req);
        const key = str(req.key, 'name');
        const size = typeof req.size === 'number' && req.size >= 0 ? req.size : undefined;
        const contentType = typeof req.contentType === 'string' && req.contentType ? req.contentType : undefined;
        await o.write(str(req.bucket, 'bucket'), key, req.data ?? new Uint8Array(0), { size, contentType });
        return { key };
      },
      /** Deletes keys, and folders with all that's in them; with `dryRun`,
       * only counts what it would delete. */
      objRemove: async (req: Req & { keys?: unknown; prefixes?: unknown; dryRun?: unknown }, ctx): Promise<RemoveResult> => {
        const id = idOf(req);
        if (req.dryRun !== true) await writable(d, id);
        const o = await driver(req);
        const bucket = str(req.bucket, 'bucket');
        const prefixes = strings(req.prefixes);
        const keys = await expand(o, bucket, strings(req.keys), prefixes, ctx.signal);
        if (req.dryRun === true) return { count: keys.length };
        // The folders' own markers too (deleting one that isn't there is fine).
        const all = [...new Set([...keys, ...prefixes])];
        await o.remove(bucket, all);
        return { count: keys.length };
      },
      /** Copies an object (or a folder, `from` ending in '/', with all
       * that's in it) to `to`; `move` deletes what was copied after. */
      objCopy: async (req: Req & { from?: unknown; to?: unknown; move?: unknown }, ctx) => {
        const id = idOf(req);
        await writable(d, id);
        const o = await driver(req);
        const bucket = str(req.bucket, 'bucket');
        const from = str(req.from, 'object');
        const to = str(req.to, 'new name');
        if (from === to) return { count: 0 };
        const folder = from.endsWith('/');
        if (folder && !to.endsWith('/')) throw new PluginError('A folder’s new name ends with “/”.');
        if (folder && to.startsWith(from)) throw new PluginError('A folder can’t go inside itself.');
        const keys = folder ? await keysUnder(o, bucket, from, ctx.signal) : [from];
        // A folder's own marker (an empty "name/" object), if it has one.
        const marker =
          folder &&
          (await o.head(bucket, from).then(
            () => true,
            () => false,
          ));
        if (marker) await o.write(bucket, to, new Uint8Array(0), {});
        for (const k of keys) await o.copy(bucket, k, to + k.slice(from.length));
        if (req.move === true) await o.remove(bucket, marker ? [...keys, from] : keys);
        return { count: keys.length };
      },
      objPresign: async (req: Req & { seconds?: unknown }) => {
        const o = await driver(req);
        const seconds = int(req.seconds, 3600, 1, 604_800);
        return { url: await o.presign(str(req.bucket, 'bucket'), str(req.key, 'object'), seconds), expires: Date.now() + seconds * 1000 };
      },
      objCreateBucket: async (req: Req) => {
        const id = idOf(req);
        await writable(d, id);
        const o = await driver(req);
        await o.createBucket(str(req.bucket, 'name for the bucket'));
        return null;
      },
    },
  };
}
