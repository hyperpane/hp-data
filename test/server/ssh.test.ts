// Connections through an SSH tunnel and with their own TLS: the target and
// the values rewritten for the tunnel, and live, PostgreSQL and Redis
// through an SSH server (skipped unless HP_DATA_SSH_KEY names a key the
// test SSH server on :2222 takes: see the README's Develop).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { kindOf } from '../../src/shared/kinds.ts';
import type { Registry } from '../../src/server/registry.ts';
import { Sessions, targetOf, throughTunnel } from '../../src/server/sessions.ts';
import { resolveTls, tlsOf } from '../../src/server/net/tls.ts';
import type { KvDriver, SqlDriver } from '../../src/server/drivers/types.ts';

const up = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });

describe('the tunnel’s values', () => {
  test('host and port, or the URL, go to the tunnel’s end; the real host is what TLS checks', () => {
    const pg = kindOf('postgresql')!;
    assert.deepEqual(targetOf(pg, { host: 'db.internal', port: 6432 }), { host: 'db.internal', port: 6432 });
    assert.deepEqual(targetOf(pg, {}), { host: 'localhost', port: 5432 });
    const v = throughTunnel(pg, { host: 'db.internal', port: 6432, user: 'a' }, { host: '127.0.0.1', port: 50001 }, 'db.internal');
    assert.equal(v.host, '127.0.0.1');
    assert.equal(v.port, 50001);
    assert.equal(v._servername, 'db.internal');
    const es = kindOf('elasticsearch')!;
    assert.deepEqual(targetOf(es, { url: 'https://search.internal' }), { host: 'search.internal', port: 443 });
    assert.equal(throughTunnel(es, { url: 'https://search.internal/' }, { host: '127.0.0.1', port: 4000 }, 'search.internal').url, 'https://127.0.0.1:4000');
    assert.throws(() => targetOf(kindOf('mongodb')!, { uri: 'mongodb+srv://x' }), /connection string/);
  });
  test('the form has SSH where it can be used, and TLS where it takes certificates', () => {
    assert.ok(kindOf('postgresql')!.fields.some((f) => f.key === 'sshHost'));
    assert.ok(kindOf('redis')!.fields.some((f) => f.key === 'tlsInsecure'));
    assert.ok(!kindOf('kafka')!.fields.some((f) => f.key === 'sshHost'));
    assert.ok(kindOf('kafka')!.fields.some((f) => f.key === 'tlsCa'));
    assert.ok(!kindOf('s3')!.fields.some((f) => f.section));
  });
});

describe('TLS of its own', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hp-data-tls-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  test('a file or a pasted PEM; the CA joins the system’s', async () => {
    writeFileSync(path.join(dir, 'ca.pem'), PEM);
    const v = await resolveTls({ tlsCa: 'ca.pem', tlsServername: 'db' }, dir);
    const o = tlsOf(v);
    assert.ok(o.ca!.length > 1 && o.ca!.at(-1) === PEM);
    assert.equal(o.servername, 'db');
    assert.deepEqual(tlsOf(await resolveTls({}, dir)), {});
  });
  test('says what’s wrong', async () => {
    await assert.rejects(resolveTls({ tlsCa: 'nope.pem' }, dir), /no such file/);
    writeFileSync(path.join(dir, 'bad.pem'), 'hello');
    await assert.rejects(resolveTls({ tlsCa: 'bad.pem' }, dir), /isn’t a PEM/);
    await assert.rejects(resolveTls({ tlsCert: PEM }, dir), /client key too/);
  });
});

describe('through SSH, live', async () => {
  const key = process.env.HP_DATA_SSH_KEY;
  const live = !!key && (await up(2222)) && (await up(5432));
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'hp-data-ssh-'));
  after(() => rmSync(dataDir, { recursive: true, force: true }));
  const sessions = new Sessions({} as Registry, { dataDir, folderOf: () => null, log: () => {} });
  after(() => sessions.shutdown());
  const ssh = { sshEnabled: true, sshHost: '127.0.0.1', sshPort: 2222, sshUser: 'tunnel' };
  const skip = !live && 'set HP_DATA_SSH_KEY, and run the SSH server on :2222 (README)';

  test('PostgreSQL by a password; the host key is remembered', { skip }, async () => {
    const d = (await sessions.make(
      'postgresql',
      { host: 'hp-data-postgres', database: 'shop', password: 'postgres', ...ssh, sshAuth: 'password', sshPassword: 'tunnel' },
      null,
    )) as SqlDriver;
    try {
      assert.match((await d.info()).version, /^PostgreSQL/);
      const [r] = await d.query('select count(*) from customers', { limit: 5, signal: new AbortController().signal });
      assert.equal(r.rows[0][0], '250');
    } finally {
      await d.close();
    }
    const known = JSON.parse(readFileSync(path.join(dataDir, 'ssh_known_hosts.json'), 'utf8'));
    assert.match(known['127.0.0.1:2222'], /^SHA256:/);
  });
  test('Redis by a key file, and by a pasted key with a passphrase', { skip }, async () => {
    const d = (await sessions.make('redis', { host: 'hp-data-redis', ...ssh, sshAuth: 'key', sshKeyFile: key! }, null)) as KvDriver;
    assert.match((await d.info()).version, /^Redis/);
    await d.close();
    const pp = (await sessions.make(
      'redis',
      { host: 'hp-data-redis', ...ssh, sshAuth: 'pasted', sshKey: readFileSync(`${key}_pp`, 'utf8'), sshPassphrase: 'secret' },
      null,
    )) as KvDriver;
    assert.match((await pp.info()).version, /^Redis/);
    await pp.close();
  });
  test('says why not: a wrong password, a target it can’t reach, a changed host key', { skip }, async () => {
    await assert.rejects(sessions.make('redis', { host: 'hp-data-redis', ...ssh, sshAuth: 'password', sshPassword: 'wrong' }, null), /didn’t take the sign-in/);
    await assert.rejects(
      sessions.make('redis', { host: 'hp-data-redis', port: 1, ...ssh, sshAuth: 'key', sshKeyFile: key! }, null),
      /couldn’t reach hp-data-redis:1/,
    );
    writeFileSync(path.join(dataDir, 'ssh_known_hosts.json'), JSON.stringify({ '127.0.0.1:2222': 'SHA256:someoneelse' }));
    await assert.rejects(sessions.make('redis', { host: 'hp-data-redis', ...ssh, sshAuth: 'key', sshKeyFile: key! }, null), /key has changed/);
  });
});
