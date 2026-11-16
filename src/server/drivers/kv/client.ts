// One connection to a Redis server (or Valkey, Dragonfly: the same
// protocol), over node:net or node:tls: signs in (AUTH), picks the
// database each command is for (SELECT, only when it changes), and sends
// commands as they come, so many in a row are pipelined. Replies come back
// in order; an error reply is a value (RespError), not a throw.

import net from 'node:net';
import tls from 'node:tls';
import { PluginError } from '@hyperpane/sdk/server';
import { netError } from '../../net/http.ts';
import { type Arg, Parser, type Reply, RespError, encode } from './resp.ts';
import type { TlsOptions } from '../../net/tls.ts';

export interface ClientOptions {
  host: string;
  port: number;
  tls: boolean;
  user?: string;
  password?: string;
  /** ms to connect and sign in. */
  timeout?: number;
  name?: string;
  /** The connection's own CA, client certificate, server name; and accept any certificate. */
  tlsOptions?: TlsOptions;
  insecure?: boolean;
}

interface Waiting {
  resolve(r: Reply): void;
  reject(e: Error): void;
}

export class RespClient {
  readonly where: string;
  readonly #o: ClientOptions;
  #socket: net.Socket | null = null;
  #ready: Promise<void> | null = null;
  readonly #queue: Waiting[] = [];
  readonly #parser = new Parser();
  /** The database selected, as far as what's been sent goes (-1: not known). */
  #db = 0;
  #closed = false;

  constructor(o: ClientOptions) {
    this.#o = o;
    this.where = `${o.host}:${o.port}`;
  }

  get closed() {
    return this.#closed;
  }

  /** Connects and signs in, once. */
  connect(): Promise<void> {
    // A connection that failed stays failed: the driver makes a new one.
    this.#ready ??= this.#connect().catch((e: Error) => {
      this.#closed = true;
      throw e;
    });
    return this.#ready;
  }

  async #connect(): Promise<void> {
    const o = this.#o;
    const timeout = o.timeout ?? 10_000;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = o.tls
        ? tls.connect({ host: o.host, port: o.port, servername: net.isIP(o.host) ? undefined : o.host, ...o.tlsOptions, rejectUnauthorized: !o.insecure })
        : net.connect({ host: o.host, port: o.port });
      const timer = setTimeout(() => s.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeout);
      s.once(o.tls ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        s.removeAllListeners('error');
        resolve(s);
      });
      s.once('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(netError(e, this.where));
      });
    });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => {
      let replies: Reply[];
      try {
        replies = this.#parser.push(chunk);
      } catch (e) {
        this.#fail(new PluginError(`${this.where} doesn’t speak Redis’s protocol: ${(e as Error).message}`));
        return;
      }
      for (const r of replies) this.#queue.shift()?.resolve(r);
    });
    socket.on('error', (e: NodeJS.ErrnoException) => this.#fail(netError(e, this.where)));
    socket.on('close', () => this.#fail(new PluginError(`The connection to ${this.where} closed.`)));

    const hello: Promise<Reply>[] = [];
    if (o.password) hello.push(this.#send(o.user ? ['AUTH', o.user, o.password] : ['AUTH', o.password]));
    if (o.name) hello.push(this.#send(['CLIENT', 'SETNAME', o.name]));
    const replies = await Promise.race([
      Promise.all(hello),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new PluginError(`${this.where} accepted the connection but didn’t answer: TLS where it isn’t, or the other way round?`)),
          timeout,
        ).unref(),
      ),
    ]).catch((e: Error) => {
      this.close();
      throw e;
    });
    const auth = o.password ? replies[0] : null;
    if (auth instanceof RespError) {
      this.close();
      throw signInError(auth);
    }
  }

  /** Sends a command on the database `db` (when given) and waits for its
   * reply. */
  async call(args: Arg[], db?: number): Promise<Reply> {
    await this.connect();
    return this.#onDb(args, db);
  }

  /** Commands sent together, their replies in order. */
  async pipeline(cmds: Arg[][], db?: number): Promise<Reply[]> {
    await this.connect();
    const socket = this.#socket;
    socket?.cork();
    const replies = cmds.map((c) => this.#onDb(c, db));
    socket?.uncork();
    return Promise.all(replies);
  }

  #onDb(args: Arg[], db?: number): Promise<Reply> {
    const out: Promise<Reply>[] = [];
    if (db !== undefined && db !== this.#db) {
      const sel = this.#send(['SELECT', db]);
      this.#db = db;
      out.push(
        sel.then((r) => {
          if (r instanceof RespError) this.#db = -1;
          return r;
        }),
      );
    }
    const p = this.#send(args);
    if (!out.length) return p;
    return Promise.all([out[0], p]).then(([sel, r]) => (sel instanceof RespError ? sel : r));
  }

  #send(args: Arg[]): Promise<Reply> {
    if (this.#closed || !this.#socket) return Promise.reject(new PluginError(`The connection to ${this.where} closed.`));
    return new Promise<Reply>((resolve, reject) => {
      this.#queue.push({ resolve, reject });
      this.#socket!.write(encode(args));
    });
  }

  /** The database the next command runs on, as the server has it. */
  get db() {
    return this.#db;
  }

  /** After a SELECT typed in a console. */
  set db(n: number) {
    this.#db = n;
  }

  #fail(e: Error) {
    this.#closed = true;
    this.#socket?.destroy();
    for (const w of this.#queue.splice(0)) w.reject(e);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket?.end();
    this.#socket?.destroy();
    for (const w of this.#queue.splice(0)) w.reject(new PluginError('Disconnected.'));
  }
}

/** Why signing in failed, in words. */
function signInError(e: RespError): PluginError {
  const m = e.message;
  if (/WRONGPASS|invalid password|invalid username-password/i.test(m)) return new PluginError('Wrong user name or password.');
  if (/without any password configured|no password is set/i.test(m)) return new PluginError('This server has no password: leave the password empty.');
  return new PluginError(`Signing in failed: ${m}`);
}

/** An error reply as a sentence, for a call that isn’t a console's. */
export function replyError(e: RespError, where: string): PluginError {
  const m = e.message;
  switch (e.code) {
    case 'NOAUTH':
      return new PluginError('This server wants a password: put it in the connection’s settings.');
    case 'WRONGPASS':
      return new PluginError('Wrong user name or password.');
    case 'NOPERM':
      return new PluginError(`The user may not do that: ${m.replace(/^NOPERM\s*/, '')}`);
    case 'MOVED':
    case 'ASK':
      return new PluginError(
        `${where} is a node of a Redis cluster, and that key lives on another one (${m.split(' ').pop()}). Data doesn’t follow a cluster’s redirects: connect to that node, or to one without cluster mode.`,
      );
    case 'CROSSSLOT':
      return new PluginError(`${where} is a cluster node: those keys are in different slots.`);
    case 'WRONGTYPE':
      return new PluginError('That key holds another type now: refresh it.');
    case 'READONLY':
      return new PluginError(`${where} is a read-only replica: connect to the primary to make changes.`);
    case 'LOADING':
      return new PluginError(`${where} is still loading its data: try again in a moment.`);
    case 'BUSY':
      return new PluginError(`${where} is busy running a script.`);
    case 'OOM':
      return new PluginError(`${where} is out of memory (maxmemory): ${m.replace(/^OOM\s*/, '')}`);
  }
  if (/DB index is out of range|invalid DB index/i.test(m)) return new PluginError(`There’s no such database on ${where}.`);
  return new PluginError(m.replace(/^ERR\s+/, ''));
}
