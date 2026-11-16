// The object family end to end, through its calls (calls/object.ts) and
// the S3 driver, against the S3 in memory (object-fake.ts), which checks
// every signature: buckets as the tree, folders and pages, previews,
// downloads and uploads as streams (multipart too), deletes of folders,
// moves, links, new buckets, and read-only connections.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { invoke, readAll, testHost } from '@hyperpane/sdk/testing';
import { make } from '../../src/server/plugin.ts';
import { KEYS, fakeS3 } from './object-fake.ts';

describe('object calls against an S3 in memory', () => {
  let s3: Awaited<ReturnType<typeof fakeS3>>;
  let plugin: ReturnType<ReturnType<typeof make>>;
  let id = '';
  let readOnlyId = '';
  const call = <T = any>(op: string, req: Record<string, unknown> = {}) => invoke<T>(plugin, { op, id, ...req });

  before(async () => {
    s3 = await fakeS3({ pageSize: 3 });
    plugin = make()(testHost({ id: 'data' }));
    const connection = (name: string, readOnly: boolean) => ({
      name,
      kind: 'minio',
      readOnly,
      values: { endpoint: s3.endpoint, accessKeyId: KEYS.accessKeyId, region: 'us-east-1' },
      secrets: { secretAccessKey: KEYS.secretAccessKey },
    });
    id = (await invoke<{ id: string }>(plugin, { op: 'save', connection: connection('fake', false) })).id;
    readOnlyId = (await invoke<{ id: string }>(plugin, { op: 'save', connection: connection('fake (read only)', true) })).id;
  });
  after(async () => {
    await plugin.shutdown?.();
    await s3.close();
  });

  test('a new bucket, then the tree lists it', async () => {
    await call('objCreateBucket', { bucket: 'assets' });
    const info = await invoke<{ version: string; detail: string }>(plugin, { op: 'connect', id });
    assert.equal(info.version, 'MinIO');
    assert.match(info.detail, /127\.0\.0\.1:\d+ · us-east-1 · \d bucket/);
    const nodes = await invoke<any[]>(plugin, { op: 'children', id, path: [] });
    assert.deepEqual(nodes, [{ name: 'assets', type: 'bucket', leaf: true, open: { tab: 'bucket', ref: { bucket: 'assets' }, title: 'assets' } }]);
    await assert.rejects(call('objCreateBucket', { bucket: 'No_Such' }), /lowercase/);
  });

  test('uploads: small, empty folders, odd names', async () => {
    const put = (key: string, text: string, contentType = 'text/plain') =>
      call('objUpload', { bucket: 'assets', key, size: Buffer.byteLength(text), contentType, data: new Blob([text]).stream() });
    await put('readme.txt', 'hello, world\n');
    await put('data/one.json', '{"a":1}', 'application/json');
    await put('data/two.json', '{"b":2}', 'application/json');
    await put('data/deep/x y+ü&.txt', 'odd');
    await put('empty.txt', '');
    await call('objUpload', { bucket: 'assets', key: 'photos/' });
    for (const k of ['a', 'b', 'c', 'd']) await put(`many/${k}.txt`, k);
    assert.equal(s3.buckets.get('assets')!.get('data/deep/x y+ü&.txt')!.body.toString(), 'odd');
    assert.equal(s3.buckets.get('assets')!.get('data/one.json')!.type, 'application/json');
  });

  test('listing by folder, in pages, and flat', async () => {
    const top = await call('objList', { bucket: 'assets', prefix: '' });
    assert.equal(top.prefixes.length + top.objects.length, 3);
    assert.ok(top.next);
    const all = { prefixes: [...top.prefixes], keys: top.objects.map((o: any) => o.key) };
    for (let token = top.next; token; ) {
      const page = await call('objList', { bucket: 'assets', prefix: '', token });
      all.prefixes.push(...page.prefixes);
      all.keys.push(...page.objects.map((o: any) => o.key));
      token = page.next;
    }
    assert.deepEqual(all.prefixes, ['data/', 'many/', 'photos/']);
    assert.deepEqual(all.keys, ['empty.txt', 'readme.txt']);
    const data = await call('objList', { bucket: 'assets', prefix: 'data/' });
    assert.deepEqual(data.prefixes, ['data/deep/']);
    assert.deepEqual(
      data.objects.map((o: any) => o.key),
      ['data/one.json', 'data/two.json'],
    );
    assert.equal(data.objects[0].size, 7);
    assert.equal(typeof data.objects[0].modified, 'number');
    const photos = await call('objList', { bucket: 'assets', prefix: 'photos/' });
    assert.deepEqual(photos, { prefixes: [], objects: [], next: null });
    const flat = await call('objList', { bucket: 'assets', prefix: 'data/', flat: true });
    assert.deepEqual(
      flat.objects.map((o: any) => o.key),
      ['data/deep/x y+ü&.txt', 'data/one.json', 'data/two.json'],
    );
  });

  test('head, preview (a range), empty objects, download', async () => {
    const head = await call('objHead', { bucket: 'assets', key: 'data/one.json' });
    assert.equal(head.size, 7);
    assert.equal(head.contentType, 'application/json');
    assert.equal(typeof head.etag, 'string');
    const part = await call('objRead', { bucket: 'assets', key: 'readme.txt', limit: 5 });
    assert.equal(Buffer.from(part.bytes).toString(), 'hello');
    assert.equal(part.size, 13);
    assert.equal(part.truncated, true);
    const empty = await call('objRead', { bucket: 'assets', key: 'empty.txt' });
    assert.equal(empty.bytes.length, 0);
    assert.equal(empty.truncated, false);
    const d = await call('objDownload', { bucket: 'assets', key: 'data/deep/x y+ü&.txt' });
    assert.equal(d.name, 'x y+ü&.txt');
    assert.equal(Buffer.from(await readAll(d.data)).toString(), 'odd');
    await assert.rejects(call('objHead', { bucket: 'assets', key: 'nope' }), /no object “nope”/);
    await assert.rejects(call('objList', { bucket: 'nope', prefix: '' }), /no such bucket/);
  });

  test('a big upload goes in parts', async () => {
    const big = Buffer.alloc(40 * 1024 * 1024 + 123, 7);
    big[0] = 1;
    big[big.length - 1] = 2;
    await call('objUpload', { bucket: 'assets', key: 'big.bin', size: big.length, data: new Blob([big]).stream() });
    const stored = s3.buckets.get('assets')!.get('big.bin')!.body;
    assert.equal(stored.length, big.length);
    assert.ok(stored.equals(big));
    assert.ok(s3.log.some((l) => l.includes('partNumber=3')));
    assert.equal(s3.uploads.size, 0);
  });

  test('rename a file, move a folder, copy one', async () => {
    await call('objCopy', { bucket: 'assets', from: 'readme.txt', to: 'README.md', move: true });
    const b = s3.buckets.get('assets')!;
    assert.ok(b.has('README.md') && !b.has('readme.txt'));
    await call('objCopy', { bucket: 'assets', from: 'data/', to: 'archive/data/', move: true });
    assert.deepEqual([...b.keys()].filter((k) => k.startsWith('archive/')).sort(), [
      'archive/data/deep/x y+ü&.txt',
      'archive/data/one.json',
      'archive/data/two.json',
    ]);
    assert.ok(![...b.keys()].some((k) => k.startsWith('data/')));
    const r = await call('objCopy', { bucket: 'assets', from: 'photos/', to: 'pictures/' });
    assert.equal(r.count, 0);
    assert.ok(b.has('pictures/') && b.has('photos/'));
    await assert.rejects(call('objCopy', { bucket: 'assets', from: 'many/', to: 'many/sub/' }), /inside itself/);
  });

  test('deleting a folder counts first, then deletes all of it', async () => {
    const dry = await call('objRemove', { bucket: 'assets', prefixes: ['many/'], dryRun: true });
    assert.equal(dry.count, 4);
    assert.ok(s3.buckets.get('assets')!.has('many/a.txt'));
    const done = await call('objRemove', { bucket: 'assets', prefixes: ['many/', 'photos/'], keys: ['empty.txt'] });
    assert.equal(done.count, 5);
    const b = s3.buckets.get('assets')!;
    assert.ok(![...b.keys()].some((k) => k.startsWith('many/') || k.startsWith('photos/') || k === 'empty.txt'));
    assert.ok(s3.log.some((l) => l.startsWith('POST assets?delete')));
  });

  test('a presigned link opens without keys, for its time', async () => {
    const { url, expires } = await call('objPresign', { bucket: 'assets', key: 'README.md', seconds: 3600 });
    assert.ok(expires > Date.now());
    const u = new URL(url);
    assert.equal(u.searchParams.get('X-Amz-Expires'), '3600');
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello, world\n');
  });

  test('a read-only connection reads, and refuses changes', async () => {
    const ro = <T = any>(op: string, req: Record<string, unknown>) => invoke<T>(plugin, { op, id: readOnlyId, ...req });
    assert.ok((await ro('objList', { bucket: 'assets', prefix: '' })).objects.length);
    for (const [op, req] of [
      ['objUpload', { bucket: 'assets', key: 'x/' }],
      ['objRemove', { bucket: 'assets', keys: ['README.md'] }],
      ['objCopy', { bucket: 'assets', from: 'README.md', to: 'y' }],
      ['objCreateBucket', { bucket: 'other' }],
    ] as const)
      await assert.rejects(ro(op, req), /read only/);
    assert.ok(s3.buckets.get('assets')!.has('README.md'));
  });

  test('wrong keys are said so', async () => {
    const bad = (
      await invoke<{ id: string }>(plugin, {
        op: 'save',
        connection: { name: 'bad', kind: 'minio', values: { endpoint: s3.endpoint, accessKeyId: KEYS.accessKeyId }, secrets: { secretAccessKey: 'wrong' } },
      })
    ).id;
    await assert.rejects(invoke(plugin, { op: 'connect', id: bad }), /secret access key is wrong/);
  });
});
