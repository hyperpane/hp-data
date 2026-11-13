// SigV4 (src/server/aws/sigv4.ts) against AWS's published S3 examples: the
// GET Object with a Range header, and the presigned GET link; and its
// encoding, INI reading and keys from the environment.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialsOf, parseIni, presign, sha256hex, sign, uriEncode } from '../../src/server/aws/sigv4.ts';

const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const date = new Date('2013-05-24T00:00:00Z');

test('GET Object example (S3 docs, sig-v4-header-based-auth)', () => {
  const h = sign({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { range: 'bytes=0-9' }, payloadHash: sha256hex(''), region: 'us-east-1', service: 's3', credentials, date });
  assert.equal(h['x-amz-date'], '20130524T000000Z');
  assert.equal(h['x-amz-content-sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(
    h.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

test('PUT Object example (S3 docs): a signed payload and a key with $', () => {
  const body = 'Welcome to Amazon S3.';
  const h = sign({
    method: 'PUT',
    url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    payloadHash: sha256hex(body),
    region: 'us-east-1',
    service: 's3',
    credentials,
    date,
  });
  assert.match(h.authorization, /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
});

test('GET Bucket lifecycle example (S3 docs): a query without a value', () => {
  const h = sign({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle='), headers: {}, payloadHash: sha256hex(''), region: 'us-east-1', service: 's3', credentials, date });
  assert.match(h.authorization, /Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543$/);
});

test('GET Bucket (list objects) example (S3 docs): a query sorted and encoded', () => {
  const h = sign({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'), headers: {}, payloadHash: sha256hex(''), region: 'us-east-1', service: 's3', credentials, date });
  assert.match(h.authorization, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
});

test('presigned GET example (S3 docs, sigv4-query-string-auth)', () => {
  const link = presign({ url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), region: 'us-east-1', credentials, seconds: 86400, date });
  const u = new URL(link);
  assert.equal(u.searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.equal(u.searchParams.get('X-Amz-Credential'), 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
  assert.equal(u.searchParams.get('X-Amz-Expires'), '86400');
  assert.equal(u.searchParams.get('X-Amz-SignedHeaders'), 'host');
});

test('a presigned link with a session token signs it', () => {
  const a = new URL(presign({ url: new URL('https://b.s3.amazonaws.com/k'), region: 'us-east-1', credentials, seconds: 60, date }));
  const b = new URL(presign({ url: new URL('https://b.s3.amazonaws.com/k'), region: 'us-east-1', credentials: { ...credentials, sessionToken: 'tok/en+=' }, seconds: 60, date }));
  assert.equal(b.searchParams.get('X-Amz-Security-Token'), 'tok/en+=');
  assert.notEqual(a.searchParams.get('X-Amz-Signature'), b.searchParams.get('X-Amz-Signature'));
});

test('uriEncode is RFC 3986, slashes kept when asked', () => {
  assert.equal(uriEncode('a b+c/d~e_.-*'), 'a%20b%2Bc%2Fd~e_.-%2A');
  assert.equal(uriEncode('photos/2024 ü.jpg', true), 'photos/2024%20%C3%BC.jpg');
});

test('the same key signs the same, however the URL spells it', () => {
  const s = (u: string) => sign({ method: 'GET', url: new URL(u), headers: {}, payloadHash: 'UNSIGNED-PAYLOAD', region: 'eu-west-1', service: 's3', credentials, date }).authorization;
  assert.equal(s('https://b.s3.eu-west-1.amazonaws.com/a%20b/%C3%BC'), s('https://b.s3.eu-west-1.amazonaws.com/a b/ü'));
});

test('parseIni reads profiles, [profile x] too', () => {
  const ini = parseIni('[default]\naws_access_key_id = A\naws_secret_access_key=S # c\n\n[profile dev]\nAWS_ACCESS_KEY_ID=B\n');
  assert.deepEqual(ini.default, { aws_access_key_id: 'A', aws_secret_access_key: 'S' });
  assert.equal(ini.dev.aws_access_key_id, 'B');
});

test('credentialsOf: the connection, then the environment, then ~/.aws', async () => {
  assert.deepEqual(await credentialsOf({ accessKeyId: 'A', secretAccessKey: 'S' }, '/nowhere', {}), { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: undefined });
  assert.equal((await credentialsOf({}, '/nowhere', { AWS_ACCESS_KEY_ID: 'E', AWS_SECRET_ACCESS_KEY: 'F' })).accessKeyId, 'E');
  await assert.rejects(credentialsOf({ accessKeyId: 'A' }, '/nowhere', {}), /secret access key/);
  await assert.rejects(credentialsOf({}, '/nowhere', {}), /no keys/);
});
