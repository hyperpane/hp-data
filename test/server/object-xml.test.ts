// S3's XML read without a dependency (drivers/object/xml.ts), and where a
// request goes (drivers/object/address.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endpointOf, pathStyleFor, queryString, urlFor } from '../../src/server/drivers/object/address.ts';
import { deleteBody, parseBuckets, parseDeleteErrors, parseError, parseList, unescapeXml } from '../../src/server/drivers/object/xml.ts';

test('ListAllMyBuckets', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>x</ID></Owner><Buckets>
<Bucket><Name>assets</Name><CreationDate>2024-01-02T03:04:05.000Z</CreationDate></Bucket>
<Bucket><Name>logs.example</Name><CreationDate>2024-02-02T03:04:05.000Z</CreationDate><BucketRegion>eu-west-1</BucketRegion></Bucket>
</Buckets></ListAllMyBucketsResult>`;
  assert.deepEqual(parseBuckets(xml), [
    { name: 'assets', created: Date.UTC(2024, 0, 2, 3, 4, 5), region: undefined },
    { name: 'logs.example', created: Date.UTC(2024, 1, 2, 3, 4, 5), region: 'eu-west-1' },
  ]);
});

test('ListObjectsV2, url-encoded, with folders and a next page', () => {
  const xml = `<ListBucketResult><Name>b</Name><Prefix>photos%2F</Prefix><EncodingType>url</EncodingType><IsTruncated>true</IsTruncated>
<NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>
<Contents><Key>photos%2Fa+b%26c.jpg</Key><LastModified>2024-05-01T10:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>1234</Size><StorageClass>STANDARD</StorageClass></Contents>
<Contents><Key>photos%2F%C3%BC%2B.txt</Key><LastModified>2024-05-01T10:00:00.000Z</LastModified><ETag>"d-2"</ETag><Size>0</Size></Contents>
<CommonPrefixes><Prefix>photos%2F2024%2F</Prefix></CommonPrefixes></ListBucketResult>`;
  const r = parseList(xml);
  assert.equal(r.next, '1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=');
  assert.deepEqual(r.prefixes, ['photos/2024/']);
  assert.equal(r.objects[0].key, 'photos/a b&c.jpg');
  assert.equal(r.objects[0].etag, 'abc');
  assert.equal(r.objects[0].size, 1234);
  assert.equal(r.objects[0].storageClass, 'STANDARD');
  assert.equal(r.objects[1].key, 'photos/ü+.txt');
});

test('ListObjectsV2 not encoded, and the last page', () => {
  const r = parseList('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a &amp; b%.txt</Key><Size>3</Size></Contents></ListBucketResult>');
  assert.equal(r.objects[0].key, 'a & b%.txt');
  assert.equal(r.next, null);
  assert.equal(r.objects[0].modified, null);
});

test('DeleteObjects: its body, and the errors in its answer', () => {
  assert.match(deleteBody(['a<b', 'c']), /<Quiet>true<\/Quiet><Object><Key>a&lt;b<\/Key><\/Object><Object><Key>c<\/Key><\/Object><\/Delete>$/);
  const errs = parseDeleteErrors('<DeleteResult><Deleted><Key>x</Key></Deleted><Error><Key>y</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error></DeleteResult>');
  assert.deepEqual(errs, [{ key: 'y', code: 'AccessDenied', message: 'Access Denied' }]);
});

test('an error names its region', () => {
  const e = parseError('<Error><Code>AuthorizationHeaderMalformed</Code><Message>the region &apos;us-east-1&apos; is wrong; expecting &apos;eu-west-1&apos;</Message><Region>eu-west-1</Region></Error>');
  assert.equal(e.code, 'AuthorizationHeaderMalformed');
  assert.equal(e.region, 'eu-west-1');
  assert.match(e.message!, /'eu-west-1'/);
});

test('entities and CDATA', () => {
  assert.equal(unescapeXml('&#65;&#x42;&lt;&gt;<![CDATA[a&b]]>'), 'AB<>a&b');
});

test('endpoints: AWS by region, schemes filled in, placeholders refused', () => {
  assert.deepEqual(endpointOf('', 'eu-west-1'), { protocol: 'https:', host: 's3.eu-west-1.amazonaws.com', base: '', aws: true });
  assert.equal(endpointOf('localhost:9000', 'us-east-1').protocol, 'http:');
  assert.equal(endpointOf('nyc3.digitaloceanspaces.com', 'nyc3').protocol, 'https:');
  assert.equal(endpointOf('https://s3.us-west-2.amazonaws.com', 'us-west-2').aws, true);
  assert.equal(endpointOf('https://storage.googleapis.com', 'auto').aws, false);
  assert.throws(() => endpointOf('https://<account>.r2.cloudflarestorage.com', 'auto'), /placeholder/);
  assert.throws(() => endpointOf('ftp://x', 'auto'), /https:\/\//);
});

test('addressing: virtual-hosted on AWS, path-style for MinIO, dots, IPs', () => {
  const aws = endpointOf('', 'us-east-1');
  assert.equal(urlFor(aws, { bucket: 'assets', key: 'a b/ü.txt', region: 'eu-central-1' }).href, 'https://assets.s3.eu-central-1.amazonaws.com/a%20b/%C3%BC.txt');
  assert.equal(urlFor(aws, { bucket: 'my.site', key: 'x', region: 'us-east-1' }).href, 'https://s3.us-east-1.amazonaws.com/my.site/x');
  assert.equal(urlFor(aws, {}).href, 'https://s3.us-east-1.amazonaws.com/');
  const minio = endpointOf('http://localhost:9000', 'us-east-1');
  assert.equal(urlFor(minio, { bucket: 'assets', key: 'k' }).href, 'http://localhost:9000/assets/k');
  const spaces = endpointOf('https://nyc3.digitaloceanspaces.com', 'nyc3');
  assert.equal(urlFor(spaces, { bucket: 'b', key: 'k' }).href, 'https://b.nyc3.digitaloceanspaces.com/k');
  assert.equal(urlFor(spaces, { bucket: 'b', key: 'k', pathStyle: true }).href, 'https://nyc3.digitaloceanspaces.com/b/k');
  assert.equal(pathStyleFor(endpointOf('http://10.0.0.5:9000', ''), 'b', false), true);
});

test('query strings are encoded as they are signed', () => {
  assert.equal(queryString({ 'list-type': 2, prefix: 'a b/+', delimiter: '/', token: undefined, delete: '' }), 'list-type=2&prefix=a%20b%2F%2B&delimiter=%2F&delete=');
  const u = urlFor(endpointOf('', 'us-east-1'), { bucket: 'b', query: { prefix: 'a b' } });
  assert.equal(u.search, '?prefix=a%20b');
});
