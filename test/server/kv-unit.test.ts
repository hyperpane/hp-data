// The kv family's pure parts: RESP encoded and parsed (replies cut
// anywhere, many in one chunk), command lines split as redis-cli splits
// them, replies printed as it prints them, bytes escaped and back, which
// commands only read, and etcd's base64 keys, prefix ranges and globs.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { format, readsOnly, tokenize } from '../../src/server/drivers/kv/cli.ts';
import { b64, globPrefix, globRegex, prefixEnd, unb64 } from '../../src/server/drivers/kv/etcd-keys.ts';
import { keyspace, parseInfo } from '../../src/server/drivers/kv/redis.ts';
import { Parser, type Reply, RespError, encode } from '../../src/server/drivers/kv/resp.ts';
import { KeyNames, escapeBytes, show, unescapeBytes } from '../../src/server/drivers/kv/text.ts';
import { literal } from '../../src/server/calls/kv.ts';

const B = (s: string) => Buffer.from(s);

describe('RESP', () => {
  test('encodes a command as an array of bulk strings', () => {
    assert.equal(encode(['SET', 'k', 'é', 3]).toString(), '*4\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\né\r\n$1\r\n3\r\n');
    assert.deepEqual(encode([Buffer.from([0, 255])]), Buffer.concat([B('*1\r\n$2\r\n'), Buffer.from([0, 255]), B('\r\n')]));
  });

  const wire = '+OK\r\n-ERR wrong\r\n:42\r\n$5\r\nhe\r\nl\r\n$-1\r\n*-1\r\n*0\r\n*3\r\n:1\r\n*2\r\n$1\r\na\r\n$0\r\n\r\n$1\r\nz\r\n:9007199254740993\r\n';
  const check = (out: Reply[]) => {
    assert.equal(out.length, 9);
    assert.equal(out[0], 'OK');
    assert.ok(out[1] instanceof RespError);
    assert.equal((out[1] as RespError).code, 'ERR');
    assert.equal(out[2], 42);
    assert.deepEqual(out[3], B('he\r\nl'));
    assert.equal(out[4], null);
    assert.equal(out[5], null);
    assert.deepEqual(out[6], []);
    assert.deepEqual(out[7], [1, [B('a'), B('')], B('z')]);
    assert.equal(out[8], 9007199254740993n);
  };

  test('parses replies in one chunk', () => check(new Parser().push(B(wire))));

  test('parses replies cut at every byte', () => {
    const p = new Parser();
    const out: Reply[] = [];
    for (const byte of B(wire)) out.push(...p.push(Buffer.from([byte])));
    check(out);
    assert.equal(p.buffered, 0);
  });

  test('parses replies cut in random places', () => {
    for (let run = 0; run < 50; run++) {
      const p = new Parser();
      const out: Reply[] = [];
      const b = B(wire);
      let i = 0;
      while (i < b.length) {
        const n = 1 + Math.floor(Math.random() * 12);
        out.push(...p.push(b.subarray(i, i + n)));
        i += n;
      }
      check(out);
    }
  });

  test('waits for a big bulk string without joining every chunk', () => {
    const p = new Parser();
    const big = Buffer.alloc(1 << 20, 'x');
    assert.deepEqual(p.push(B(`$${big.length}\r\n`)), []);
    for (let i = 0; i < big.length; i += 1000) assert.deepEqual(p.push(big.subarray(i, i + 1000)), []);
    const [r] = p.push(B('\r\n'));
    assert.equal((r as Buffer).length, big.length);
  });

  test('refuses what isn’t RESP', () => assert.throws(() => new Parser().push(B('HTTP/1.1 400\r\n'))));
});

describe('command lines', () => {
  const t = (line: string) => tokenize(line).map((b) => b.toString('latin1'));
  test('splits on spaces, with quotes', () => {
    assert.deepEqual(t('SET k "a b"'), ['SET', 'k', 'a b']);
    assert.deepEqual(t("  set  'it\\'s'   x "), ['set', "it's", 'x']);
    assert.deepEqual(t('SET k ""'), ['SET', 'k', '']);
    assert.deepEqual(t('a"b c"d'.replace('d', '')), ['ab c']);
  });
  test('reads escapes in double quotes', () => {
    assert.deepEqual(tokenize('SET k "\\x00\\xff\\n\\"q\\""')[2], Buffer.from([0, 0xff, 10, 0x22, 0x71, 0x22]));
    assert.deepEqual(tokenize("SET k '\\x00'")[2], B('\\x00'));
    assert.equal(tokenize('SET k "héllo ✓"')[2].toString('utf8'), 'héllo ✓');
  });
  test('says when a quote isn’t closed', () => {
    assert.throws(() => tokenize('SET k "abc'), /isn’t closed/);
    assert.throws(() => tokenize('SET k "a"b'), /followed by a space/);
  });
  test('knows which commands only read', () => {
    assert.ok(readsOnly(['get', 'k']));
    assert.ok(readsOnly(['CONFIG', 'get', 'databases']));
    assert.ok(!readsOnly(['CONFIG', 'SET', 'x', 'y']));
    assert.ok(!readsOnly(['SET', 'k', 'v']));
    assert.ok(!readsOnly(['FLUSHALL']));
    assert.ok(!readsOnly(['SOMETHINGNEW']));
  });
});

describe('replies as redis-cli prints them', () => {
  test('scalars', () => {
    assert.equal(format(1), '(integer) 1');
    assert.equal(format(null), '(nil)');
    assert.equal(format('OK'), 'OK');
    assert.equal(format(B('value')), '"value"');
    assert.equal(format(B('a "b"\n')), '"a \\"b\\"\\n"');
    assert.equal(format(Buffer.from([0, 0xff, 0x41])), '"\\x00\\xffA"');
    assert.equal(format(new RespError('WRONGTYPE Operation against a key')), '(error) WRONGTYPE Operation against a key');
    assert.equal(format([]), '(empty array)');
  });
  test('arrays, nested and numbered to the widest index', () => {
    assert.equal(format([B('a'), [B('b'), 2], null]), '1) "a"\n2) 1) "b"\n   2) (integer) 2\n3) (nil)');
    const ten = Array.from({ length: 10 }, (_, i) => i);
    assert.equal(format(ten).split('\n')[0], ' 1) (integer) 0');
    assert.equal(format(ten).split('\n')[9], '10) (integer) 9');
  });
});

describe('bytes as text', () => {
  test('UTF-8 is kept, the rest escaped and back', () => {
    assert.deepEqual(show(B('héllo')), { text: 'héllo', binary: false });
    const bin = Buffer.from([0, 1, 0xff, 0x61, 0x5c, 0x22]);
    const s = show(bin);
    assert.equal(s.binary, true);
    assert.equal(s.text, '\\x00\\x01\\xffa\\\\\\"');
    assert.deepEqual(unescapeBytes(s.text), bin);
    assert.equal(escapeBytes(B('tab\there')), 'tab\\there');
  });
  test('binary keys come back as the same bytes', () => {
    const names = new KeyNames();
    const k = Buffer.from([0x6b, 0x00, 0xfe]);
    const shown = names.name(k);
    assert.equal(shown, 'k\\x00\\xfe');
    assert.deepEqual(names.bytes(shown), k);
    assert.deepEqual(names.bytes('plain'), B('plain'));
  });
  test('a key matched only by itself', () => assert.equal(literal('a*b?[c]\\'), 'a\\*b\\?\\[c\\]\\\\'));
});

describe('INFO', () => {
  test('fields and the keyspace', () => {
    const info = parseInfo('# Server\r\nredis_version:7.2.4\r\n\r\n# Keyspace\r\ndb0:keys=12,expires=1,avg_ttl=0\r\ndb3:keys=4,expires=0,avg_ttl=0\r\n');
    assert.equal(info.redis_version, '7.2.4');
    assert.deepEqual(
      [...keyspace(info)],
      [
        [0, 12],
        [3, 4],
      ],
    );
  });
});

describe('etcd keys', () => {
  test('base64 both ways', () => {
    assert.equal(b64('foo'), 'Zm9v');
    assert.deepEqual(unb64('Zm9v'), B('foo'));
    assert.deepEqual(unb64(undefined), Buffer.alloc(0));
  });
  test('the end of a prefix’s range', () => {
    assert.deepEqual(prefixEnd(B('abc')), B('abd'));
    assert.deepEqual(prefixEnd(Buffer.from([0x61, 0xff])), B('b'));
    assert.deepEqual(prefixEnd(Buffer.from([0xff, 0xff])), Buffer.from([0]));
    assert.deepEqual(prefixEnd(Buffer.alloc(0)), Buffer.from([0]));
  });
  test('globs: their literal start and what they match', () => {
    assert.equal(globPrefix('config/*'), 'config/');
    assert.equal(globPrefix('a\\*b*'), 'a*b');
    assert.equal(globPrefix('*'), '');
    const re = globRegex('user:[0-9]?:*');
    assert.ok(re.test('user:12:name'));
    assert.ok(!re.test('user:x2:name'));
    assert.ok(globRegex('a.b*').test('a.bc'));
    assert.ok(!globRegex('a.b*').test('axbc'));
    assert.ok(globRegex('[^x]y').test('ay'));
    assert.ok(!globRegex('[^x]y').test('xy'));
  });
});
