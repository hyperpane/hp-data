// The queue family's pure parts: where a Kafka peek starts and ends, bytes
// as text, each engine's messages as Data's, requests read, errors said.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headersOf, peekOf, publishOf } from '../../src/server/calls/queue.ts';
import { duration } from '../../src/server/drivers/queue/format.ts';
import { brokersOf, saslOf, said } from '../../src/server/drivers/queue/kafka-client.ts';
import { rangesFor, toMessage as kafkaMessage } from '../../src/server/drivers/queue/kafka-read.ts';
import { toMessage as rabbitMessage } from '../../src/server/drivers/queue/rabbitmq.ts';
import { queueName, toMessage as sqsMessage } from '../../src/server/drivers/queue/sqs.ts';
import { MAX_VALUE, decode, headerText, newest, refOf } from '../../src/server/drivers/queue/text.ts';

const marks = [
  { partition: 0, low: '0', high: '20' },
  { partition: 1, low: '5', high: '8' },
  { partition: 2, low: '0', high: '0' },
];

test('latest: the last n of each partition, empty ones left out', () => {
  assert.deepEqual(rangesFor({ from: 'latest', limit: 10 }, marks), [
    { partition: 0, start: 10n, end: 20n },
    { partition: 1, start: 5n, end: 8n },
  ]);
});

test('earliest, and one partition', () => {
  assert.deepEqual(rangesFor({ from: 'earliest', limit: 2, partition: 1 }, marks), [{ partition: 1, start: 5n, end: 7n }]);
  assert.throws(() => rangesFor({ from: 'earliest', limit: 2, partition: 9 }, marks), /no partition 9/);
});

test('an offset is kept inside the partition', () => {
  assert.deepEqual(rangesFor({ from: 'offset', limit: 5, partition: 0, offset: '18' }, marks), [{ partition: 0, start: 18n, end: 20n }]);
  assert.deepEqual(rangesFor({ from: 'offset', limit: 5, partition: 1, offset: '0' }, marks), [{ partition: 1, start: 5n, end: 8n }]);
  assert.throws(() => rangesFor({ from: 'offset', limit: 5, partition: 0, offset: 'x' }, marks), /isn’t an offset/);
});

test('bytes as text, or base64 when they aren’t', () => {
  assert.deepEqual(decode(Buffer.from('{"a":1}')), { text: '{"a":1}', binary: false, size: 7, cut: false });
  const bin = decode(Buffer.from([0, 159, 146, 150]));
  assert.equal(bin.binary, true);
  assert.equal(bin.text, Buffer.from([0, 159, 146, 150]).toString('base64'));
  const big = decode(Buffer.alloc(MAX_VALUE + 10, 97));
  assert.equal(big.cut, true);
  assert.equal(big.text.length, MAX_VALUE);
  assert.equal(headerText([Buffer.from('a'), 'b']), 'a, b');
});

test('a Kafka message', () => {
  const m = kafkaMessage(2, {
    key: Buffer.from('k1'),
    value: null,
    headers: { h: Buffer.from('v') },
    timestamp: '1700000000000',
    offset: '41',
    attributes: 0,
    size: 0,
  } as never);
  assert.equal(m.id, '2:41');
  assert.equal(m.key, 'k1');
  assert.equal(m.value, '');
  assert.equal(m.meta?.tombstone, true);
  assert.deepEqual(m.headers, { h: 'v' });
  assert.equal(m.at, 1700000000000);
});

test('the newest across partitions, oldest first', () => {
  const ms = [3, 1, 2, 5, 4].map((at, i) => ({ id: String(i), value: '', at, partition: i % 2, offset: String(i) }));
  assert.deepEqual(
    newest(ms, 2).map((m) => m.at),
    [4, 5],
  );
});

test('a RabbitMQ message', () => {
  const m = rabbitMessage(
    {
      payload: 'hi',
      payload_encoding: 'string',
      payload_bytes: 2,
      redelivered: true,
      exchange: '',
      routing_key: 'jobs',
      message_count: 3,
      properties: { headers: { n: 1 }, timestamp: 1700000000, message_id: 'x' },
    },
    0,
  );
  assert.equal(m.value, 'hi');
  assert.equal(m.key, 'jobs');
  assert.equal(m.at, 1700000000000);
  assert.deepEqual(m.headers, { n: '1' });
  assert.equal(m.meta?.redelivered, true);
  assert.equal(m.meta?.exchange, '(default)');
  assert.equal(
    rabbitMessage(
      { payload: 'AAE=', payload_encoding: 'base64', payload_bytes: 2, redelivered: false, exchange: 'x', routing_key: '', message_count: 0, properties: [] },
      1,
    ).binary,
    true,
  );
});

test('an SQS message', () => {
  const m = sqsMessage({
    MessageId: 'm1',
    Body: 'b',
    Attributes: { SentTimestamp: '1700000000000', ApproximateReceiveCount: '2', MessageGroupId: 'g' },
    MessageAttributes: { a: { DataType: 'String', StringValue: 'x' } },
  });
  assert.deepEqual([m.id, m.key, m.at, m.meta?.['receive count'], m.headers?.a], ['m1', 'g', 1700000000000, 2, 'x']);
  assert.equal(queueName('http://localhost:9324/000000000000/tasks'), 'tasks');
});

test('brokers and SASL from a connection’s values', () => {
  assert.deepEqual(brokersOf('kafka://a:9093, b ,c:1/'), ['a:9093', 'b:9092', 'c:1']);
  assert.throws(() => brokersOf(' '), /at least one broker/);
  assert.equal(saslOf({ sasl: 'none' }), undefined);
  assert.deepEqual(saslOf({ sasl: 'scram-sha-512', user: 'u', password: 'p' }), { mechanism: 'scram-sha-512', username: 'u', password: 'p' });
  assert.throws(() => saslOf({ sasl: 'plain' }), /needs a user/);
});

test('kafkajs errors said for the user', () => {
  assert.match(
    said(Object.assign(new Error('Connection error: connect ECONNREFUSED 127.0.0.1:9092'), { name: 'KafkaJSConnectionError' })).message,
    /Nothing answers at 127\.0\.0\.1:9092/,
  );
  assert.match(said(Object.assign(new Error('x'), { name: 'KafkaJSProtocolError', type: 'TOPIC_ALREADY_EXISTS' })).message, /already/);
  assert.match(
    said(
      Object.assign(new Error('retries'), {
        name: 'KafkaJSNumberOfRetriesExceeded',
        originalError: Object.assign(new Error('y'), { type: 'UNKNOWN_TOPIC_OR_PARTITION' }),
      }),
    ).message,
    /no such topic/,
  );
});

test('requests read', () => {
  assert.deepEqual(refOf({ topic: 't', queue: 1, vhost: '/' }), { topic: 't', vhost: '/' });
  assert.deepEqual(peekOf({ ref: { topic: 't' }, limit: 5000, from: 'nope' }), {
    ref: { topic: 't' },
    limit: 1000,
    from: 'latest',
    partition: undefined,
    offset: undefined,
  });
  assert.equal(peekOf({ ref: {}, partition: '2', from: 'offset', offset: 7 }).offset, '7');
  assert.deepEqual(headersOf({ ' a ': 1, '': 'x', b: null }), { a: '1', b: '' });
  assert.throws(() => publishOf({ ref: {} }), /a value/);
});

test('durations', () => {
  assert.equal(duration(604800000), '7 days');
  assert.equal(duration(30000), '30 seconds');
  assert.equal(duration(5400000), '90 minutes');
});
