// The S3 driver against a real MinIO (skipped when none answers at
// localhost:9000: `docker run -d --name hp-data-minio -p 9000:9000 -p
// 9001:9001 minio/minio server /data --console-address :9001`). It leaves
// an `assets` bucket with folders, images, JSON and text behind, for the
// window to show.

import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import net from 'node:net';
import os from 'node:os';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { kindOf, withDefaults } from '../../src/shared/kinds.ts';
import { type S3Driver, s3 } from '../../src/server/drivers/object/s3.ts';

const up = await new Promise<boolean>((resolve) => {
  const s = net.connect(9000, '127.0.0.1');
  s.once('connect', () => {
    s.destroy();
    resolve(true);
  });
  s.once('error', () => resolve(false));
});

const kind = kindOf('minio')!;
const driver = (values: Record<string, string | boolean> = {}) =>
  s3({
    kind,
    values: withDefaults(kind, { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', ...values }),
    folder: null,
    dataDir: os.tmpdir(),
    log: () => {},
  }) as S3Driver;
const signal = new AbortController().signal;
const text = async (body: ReadableStream<Uint8Array>) => Buffer.from(await new Response(body).arrayBuffer()).toString();

/** A PNG of w×h, colored by `color(x, y)`. */
function png(w: number, h: number, color: (x: number, y: number) => [number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from(color(x, y)).copy(raw, y * (w * 3 + 1) + 1 + x * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const SAMPLES: [string, string | Uint8Array, string][] = [
  ['README.md', '# Assets\n\nSample files for hyperpane’s Data plugin: images, JSON, text.\n', 'text/markdown'],
  [
    'config/app.json',
    JSON.stringify(
      { name: 'shop', version: '2.4.1', features: { search: true, checkout: { provider: 'stripe', currency: 'EUR' } }, regions: ['eu-west-1', 'us-east-1'] },
      null,
      2,
    ),
    'application/json',
  ],
  ['config/flags.json', JSON.stringify({ newCheckout: false, darkMode: true, maxUpload: 104857600 }), 'application/json'],
  ['images/gradient.png', png(160, 100, (x, y) => [Math.round((x / 159) * 255), Math.round((y / 99) * 255), 180]), 'image/png'],
  ['images/stripes.png', png(64, 64, (x) => (Math.floor(x / 8) % 2 ? [240, 128, 32] : [30, 30, 40])), 'image/png'],
  [
    'images/icons/dot.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="24" fill="#569a31"/></svg>',
    'image/svg+xml',
  ],
  [
    'logs/2024-11-12.log',
    Array.from(
      { length: 200 },
      (_, i) =>
        `2024-11-12T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z INFO request ${i} GET /api/items 200 ${12 + (i % 40)}ms`,
    ).join('\n'),
    'text/plain',
  ],
  ['logs/2024-11-13.log', 'INFO started\nWARN slow query (812 ms)\nINFO stopped\n', 'text/plain'],
  ['data/users.csv', 'id,name,email\n1,Ada,ada@example.com\n2,Grace,grace@example.com\n3,Linus,linus@example.com\n', 'text/csv'],
  ['data/archive.bin', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)), 'application/octet-stream'],
  ['notes/hello world ü.txt', 'A name with a space and a ü in it.\n', 'text/plain'],
];

describe('MinIO', { skip: !up && 'nothing answers at localhost:9000' }, () => {
  test('info, buckets, and the sample bucket made (kept)', async () => {
    const d = driver();
    const existing = (await d.buckets()).map((b) => b.name);
    if (!existing.includes('assets')) await d.createBucket('assets');
    for (const [key, body, contentType] of SAMPLES) await d.write('assets', key, typeof body === 'string' ? Buffer.from(body) : body, { contentType });
    await d.write('assets', 'empty folder/', new Uint8Array(0), {});
    if (!existing.includes('backups')) await d.createBucket('backups');
    await d.write('backups', 'db/2024-11-13.sql.gz', Buffer.from('not really gzip'), { contentType: 'application/gzip' });
    const info = await d.info();
    assert.equal(info.version, 'MinIO');
    assert.match(info.detail!, /localhost:9000 · us-east-1 · \d+ buckets?/);
    const tree = await d.children([]);
    assert.ok(tree.some((n) => n.name === 'assets' && n.open?.tab === 'bucket'));
  });

  test('lists by folder and flat', async () => {
    const d = driver();
    const top = await d.list({ bucket: 'assets', prefix: '' }, signal);
    for (const p of ['config/', 'data/', 'empty folder/', 'images/', 'logs/', 'notes/']) assert.ok(top.prefixes.includes(p), p);
    assert.ok(top.objects.some((o) => o.key === 'README.md' && o.size > 0 && o.etag && o.storageClass));
    const images = await d.list({ bucket: 'assets', prefix: 'images/' }, signal);
    assert.deepEqual(images.prefixes, ['images/icons/']);
    const flat = await d.list({ bucket: 'assets', prefix: 'images/', flat: true }, signal);
    assert.ok(flat.objects.some((o) => o.key === 'images/icons/dot.svg'));
    const notes = await d.list({ bucket: 'assets', prefix: 'notes/' }, signal);
    assert.equal(notes.objects[0].key, 'notes/hello world ü.txt');
  });

  test('head, a range, metadata', async () => {
    const d = driver();
    const h = await d.head('assets', 'config/app.json');
    assert.equal(h.contentType, 'application/json');
    assert.ok(h.size > 50);
    const r = await d.read('assets', 'logs/2024-11-12.log', { limit: 20, signal });
    assert.equal((await text(r.body)).length, 20);
    assert.ok(r.size > 1000);
    const e = await d.read('assets', 'empty folder/', { limit: 20, signal });
    assert.equal(e.size, 0);
    assert.equal(await text(e.body), '');
  });

  test('a streamed upload (UNSIGNED-PAYLOAD, a content-length) and multipart, then copy, delete many, link', async () => {
    const d = driver();
    const bytes = Buffer.alloc(3 * 1024 * 1024, 'x');
    await d.client.send({
      method: 'PUT',
      bucket: 'assets',
      key: 'tmp/streamed.txt',
      stream: Readable.from([bytes]),
      headers: { 'content-length': String(bytes.length), 'content-type': 'text/plain' },
    });
    assert.equal((await d.head('assets', 'tmp/streamed.txt')).size, bytes.length);
    const big = Buffer.alloc(17 * 1024 * 1024 + 5, 'y');
    await d.write('assets', 'tmp/big.bin', new Blob([big]).stream(), { size: big.length });
    assert.equal((await d.head('assets', 'tmp/big.bin')).size, big.length);
    await d.write('assets', 'tmp/unknown-size.bin', new Blob([big]).stream(), {});
    assert.equal((await d.head('assets', 'tmp/unknown-size.bin')).size, big.length);
    await d.copy('assets', 'tmp/streamed.txt', 'tmp/copy of streamed.txt');
    const url = await d.presign('assets', 'tmp/copy of streamed.txt', 60);
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, bytes.length);
    const n = await d.remove('assets', ['tmp/streamed.txt', 'tmp/big.bin', 'tmp/unknown-size.bin', 'tmp/copy of streamed.txt']);
    assert.equal(n, 4);
    assert.deepEqual((await d.list({ bucket: 'assets', prefix: 'tmp/' }, signal)).objects, []);
  });

  test('one bucket only, wrong keys, no bucket', async () => {
    assert.deepEqual(
      (await driver({ bucket: 'assets' }).children([])).map((n) => n.name),
      ['assets'],
    );
    await assert.rejects(driver({ secretAccessKey: 'nope' }).info(), /secret access key is wrong/);
    await assert.rejects(driver({ bucket: 'no-such-bucket-here' }).info(), /no such bucket/i);
  });
});
