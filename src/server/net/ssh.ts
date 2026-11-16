// An SSH tunnel for a connection (`ssh2`, in JavaScript): the server signs
// in to the SSH host (a key file, a pasted key, a password, or the agent),
// then listens on a port of its own on 127.0.0.1 and forwards each
// connection made to it on to the database's host and port, as the SSH
// host sees them. The driver connects to that port as if it were the
// database. The SSH host's key is remembered the first time (in the
// plugin's data folder) and checked after: a changed one stops it.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PluginError } from '@hyperpane/sdk/server';
import { Client, type ConnectConfig } from 'ssh2';
import type { Values } from '../../shared/kinds.ts';

export interface Tunnel {
  /** Where the driver connects: 127.0.0.1 and a port of the tunnel's. */
  host: string;
  port: number;
  close(): void;
}

const expand = (p: string) => p.trim().replace(/^~(?=\/|$)/, os.homedir());

const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

/** The key to sign in with, from the file named or the usual ones. */
async function keyOf(v: Values): Promise<Buffer> {
  if (v.sshAuth === 'pasted') {
    if (!v.sshKey) throw new PluginError('Paste the private key on the SSH tab.');
    return Buffer.from(`${String(v.sshKey).trim()}\n`);
  }
  const named = String(v.sshKeyFile ?? '').trim();
  const files = named ? [expand(named)] : DEFAULT_KEYS.map((k) => path.join(os.homedir(), '.ssh', k));
  for (const f of files) {
    try {
      return await readFile(f);
    } catch (e) {
      if (named)
        throw new PluginError(
          `Couldn’t read the key ${named} on the server: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'there’s no such file' : (e as Error).message}.`,
        );
    }
  }
  throw new PluginError('There’s no key in ~/.ssh on the server (id_ed25519, id_ecdsa, id_rsa): name the key file, paste a key, or use a password.');
}

/** The SSH host keys seen before, by host:port. */
async function knownHosts(file: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function sshError(e: Error & { level?: string; code?: string }, where: string, reached = false): PluginError {
  if (e instanceof PluginError) return e;
  if (e.level === 'client-authentication')
    return new PluginError(`The SSH host ${where} didn’t take the sign-in: check the user and the ${'key or password'}.`);
  if (/Encrypted private key detected, but no passphrase given/i.test(e.message)) return new PluginError('The key has a passphrase: give it on the SSH tab.');
  if (/bad passphrase|Unsupported key format|Cannot parse privateKey/i.test(e.message))
    return new PluginError(`The key couldn’t be read: ${e.message} (a wrong passphrase, or not a private key).`);
  if (e.level === 'client-timeout' || e.code === 'ETIMEDOUT')
    return new PluginError(
      reached
        ? `${where} took the connection but never said hello as SSH does: something between (a VPN, a firewall) lets the connection through but not SSH, or that port isn’t SSH. Try without the VPN, or SSH on another port (443).`
        : `The SSH host ${where} didn’t answer in time: a firewall, a VPN, or the wrong address?`,
    );
  if (e.code === 'ECONNREFUSED') return new PluginError(`Nothing answers at ${where}: is SSH running there, on that port?`);
  if (e.code === 'ENOTFOUND') return new PluginError(`There’s no host ${where.replace(/:\d+$/, '')}: check the SSH host’s name.`);
  return new PluginError(`SSH to ${where}: ${e.message}`);
}

/** Opens the tunnel to `target` (as the SSH host sees it). */
export async function openTunnel(
  v: Values,
  target: { host: string; port: number },
  o: { dataDir: string; log(line: string): void; timeout?: number },
): Promise<Tunnel> {
  const sshHost = String(v.sshHost ?? '').trim();
  if (!sshHost) throw new PluginError('Give the SSH host on the SSH tab.');
  const sshPort = Number(v.sshPort || 22);
  const where = `${sshHost}:${sshPort}`;
  const knownFile = path.join(o.dataDir, 'ssh_known_hosts.json');
  const known = await knownHosts(knownFile);
  let seen: string | null = null;

  const config: ConnectConfig = {
    host: sshHost,
    port: sshPort,
    username: String(v.sshUser || os.userInfo().username),
    readyTimeout: (o.timeout ?? 15) * 1000,
    keepaliveInterval: Number(v.sshKeepAlive ?? 30) * 1000,
    hostVerifier: (key: Buffer) => {
      seen = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
      return !known[where] || known[where] === seen;
    },
  };
  const auth = String(v.sshAuth || 'key');
  if (auth === 'password') {
    if (!v.sshPassword) throw new PluginError('Give the SSH password on the SSH tab.');
    config.password = String(v.sshPassword);
    config.tryKeyboard = true;
  } else if (auth === 'agent') {
    if (!process.env.SSH_AUTH_SOCK) throw new PluginError('The server has no SSH agent (SSH_AUTH_SOCK isn’t set where it runs): use a key instead.');
    config.agent = process.env.SSH_AUTH_SOCK;
  } else {
    config.privateKey = await keyOf(v);
    if (v.sshPassphrase) config.passphrase = String(v.sshPassphrase);
  }

  const client = new Client();
  let reached = false;
  client.once('connect', () => (reached = true));
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    // ssh2 can fail twice (a timeout, then the connection lost): only the
    // first is said; a listener stays so the second doesn't end the part.
    client.on('error', () => {});
    client.once('error', (e: Error & { level?: string }) => {
      if (seen && known[where] && known[where] !== seen)
        reject(
          new PluginError(
            `The SSH host ${where}’s key has changed (it was ${known[where]}, it’s ${seen} now): it may be another machine. If it was reinstalled, forget its key in the connection’s SSH tab.`,
          ),
        );
      else reject(sshError(e, where, reached));
    });
    if (config.password) client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => String(config.password))));
    try {
      client.connect(config);
    } catch (e) {
      reject(sshError(e as Error, where));
    }
  });
  if (seen && !known[where]) {
    known[where] = seen;
    await writeFile(knownFile, `${JSON.stringify(known, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
    o.log(`ssh: remembered ${where}’s key ${seen}`);
  }

  // A forward to the target must work before it's said to be open.
  await new Promise<void>((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) => {
      if (err)
        return reject(
          new PluginError(
            `The SSH host ${where} couldn’t reach ${target.host}:${target.port}: ${err.message} (is TCP forwarding allowed there, and is the address right as the SSH host sees it?)`,
          ),
        );
      stream.end();
      resolve();
    });
  }).catch((e) => {
    client.end();
    throw e;
  });

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    client.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, target.host, target.port, (err, stream) => {
      if (err) {
        o.log(`ssh: forwarding to ${target.host}:${target.port} failed: ${err.message}`);
        socket.destroy();
        return;
      }
      socket.pipe(stream).pipe(socket);
      stream.on('error', () => socket.destroy());
      socket.on('error', () => stream.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    for (const s of sockets) s.destroy();
    client.end();
  };
  client.on('close', () => {
    if (!closed) o.log(`ssh: the tunnel through ${where} closed`);
    close();
  });
  client.on('error', (e: Error) => o.log(`ssh: ${e.message}`));
  o.log(`ssh: tunnel through ${where} to ${target.host}:${target.port} on 127.0.0.1:${port}`);
  return { host: '127.0.0.1', port, close };
}

/** Forgets an SSH host's key (it was reinstalled). */
export async function forgetHost(dataDir: string, host: string, port: number): Promise<boolean> {
  const file = path.join(dataDir, 'ssh_known_hosts.json');
  const known = await knownHosts(file);
  const k = `${host}:${port}`;
  if (!known[k]) return false;
  delete known[k];
  await writeFile(file, `${JSON.stringify(known, null, 2)}\n`, { mode: 0o600 });
  return true;
}
