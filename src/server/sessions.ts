// Open sessions: one driver per connection, made on first use and kept
// while it's used. One that's idle for a while (15 minutes by default) is
// closed; the next call opens it again. Changing or removing a connection
// closes its session, so the next call uses what was saved.

import { EventEmitter } from 'node:events';
import { PluginError } from '@hyperpane/sdk/server';
import { type Kind, SSH_ENGINES, type Values, withDefaults } from '../shared/kinds.ts';
import type { Family } from '../shared/kinds.ts';
import type { SessionInfo } from '../shared/types.ts';
import { factoryFor } from './drivers/index.ts';
import type { Driver, DriverContext } from './drivers/types.ts';
import { kindFor, type Registry } from './registry.ts';
import { type Tunnel, openTunnel } from './net/ssh.ts';
import { resolveTls } from './net/tls.ts';

/** A promise, or an error after `seconds` (connecting: “it didn’t answer”). */
export function withTimeout<T>(p: Promise<T>, seconds: number): Promise<T> {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 20;
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PluginError(`It didn’t answer in ${s} seconds: check the host, the port and the network (or give it longer under Options).`)), s * 1000);
    }),
  ]).finally(() => clearTimeout(timer));
}

const URL_ENGINES = new Set(['etcd', 'elasticsearch', 'rabbitmq']);

/** Where the database is, as the SSH host sees it. */
export function targetOf(kind: Kind, v: Values): { host: string; port: number } {
  if (URL_ENGINES.has(kind.engine)) {
    const u = new URL(String(v.url ?? ''));
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
  }
  if (kind.engine === 'mongodb' && v.uri) throw new PluginError('An SSH tunnel goes to the host and port fields: clear the connection string under Options, or connect without SSH.');
  const port = Number(v.port ?? kind.fields.find((f) => f.key === 'port')?.default ?? 0);
  return { host: String(v.host || 'localhost'), port };
}

/** The values with the tunnel's end in place of the database's address; the
 * real host stays the name TLS checks. */
export function throughTunnel(kind: Kind, v: Values, t: { host: string; port: number }, host: string): Values {
  const out: Values = { ...v, _servername: host };
  if (URL_ENGINES.has(kind.engine)) {
    const u = new URL(String(v.url));
    u.hostname = t.host;
    u.port = String(t.port);
    out.url = u.toString().replace(/\/$/, '');
  } else {
    out.host = t.host;
    out.port = t.port;
  }
  return out;
}

interface Open {
  driver: Driver;
  info: SessionInfo;
  used: number;
  /** Closed after this long unused (0: never). */
  idleMs: number;
}

export interface SessionOptions {
  idleMs?: number;
  dataDir: string;
  /** The folder of a project, for SQLite's relative paths. */
  folderOf(project: string | null): string | null;
  log(line: string): void;
}

export class Sessions {
  readonly #open = new Map<string, Open>();
  readonly #opening = new Map<string, Promise<Open>>();
  readonly #changes = new EventEmitter();
  readonly #registry: Registry;
  readonly #o: SessionOptions;
  readonly #timer: NodeJS.Timeout;

  constructor(registry: Registry, o: SessionOptions) {
    this.#registry = registry;
    this.#o = o;
    this.#changes.setMaxListeners(0);
    this.#timer = setInterval(() => this.#sweep(), 30_000);
    this.#timer.unref();
  }

  get size() {
    return this.#open.size;
  }

  infos(): Record<string, SessionInfo> {
    return Object.fromEntries([...this.#open].map(([id, o]) => [id, o.info]));
  }

  onChange(fn: () => void): () => void {
    this.#changes.on('change', fn);
    return () => this.#changes.off('change', fn);
  }

  /** The driver of a connection's session, opened if it isn't. */
  /** Keeps it from being closed as idle (a tail that runs). */
  touch(id: string) {
    const o = this.#open.get(id);
    if (o) o.used = Date.now();
  }

  async get(id: string, project: string | null = null): Promise<Driver> {
    const open = this.#open.get(id) ?? (await this.#start(id, project));
    open.used = Date.now();
    return open.driver;
  }

  /** The session's driver, as its family's. */
  async family<F extends Family>(id: string, family: F, project: string | null = null): Promise<Extract<Driver, { family: F }>> {
    const d = await this.get(id, project);
    if (d.family !== family) throw new PluginError(`That connection doesn’t have ${family === 'sql' ? 'tables' : family === 'kv' ? 'keys' : family === 'document' ? 'collections' : family === 'queue' ? 'queues' : 'buckets'}.`);
    return d as Extract<Driver, { family: F }>;
  }

  #start(id: string, project: string | null): Promise<Open> {
    let p = this.#opening.get(id);
    if (!p) {
      p = (async () => {
        const { connection, values } = await this.#registry.values(id);
        const driver = await this.make(connection.kind, values, project);
        let info: Omit<SessionInfo, 'at'>;
        try {
          info = await withTimeout(driver.info(), Number(values.timeout ?? 20));
        } catch (e) {
          await driver.close().catch(() => {});
          throw e;
        }
        const minutes = values.idleMinutes === undefined || values.idleMinutes === '' ? null : Number(values.idleMinutes);
        const open: Open = { driver, info: { ...info, at: Date.now() }, used: Date.now(), idleMs: minutes === null || !Number.isFinite(minutes) ? (this.#o.idleMs ?? 15 * 60_000) : minutes * 60_000 };
        this.#open.set(id, open);
        this.#o.log(`connected: ${connection.name} (${info.version})`);
        void this.#registry.touch(id).catch(() => {});
        this.#changes.emit('change');
        return open;
      })().finally(() => this.#opening.delete(id));
      this.#opening.set(id, p);
    }
    return p;
  }

  /** A driver for values (a form's, to test it), not kept. */
  async make(kindId: string, values: DriverContext['values'], project: string | null): Promise<Driver> {
    const kind = kindFor(kindId);
    const factory = await factoryFor(kind.engine);
    const folder = this.#o.folderOf(project);
    let v = withDefaults(kind, values);
    let tunnel: Tunnel | null = null;
    if (v.sshEnabled && SSH_ENGINES.includes(kind.engine)) {
      const target = targetOf(kind, v);
      tunnel = await openTunnel(v, target, { dataDir: this.#o.dataDir, log: this.#o.log, timeout: Number(v.timeout ?? 15) });
      v = throughTunnel(kind, v, tunnel, target.host);
    }
    let driver: Driver;
    try {
      v = await resolveTls(v, folder);
      driver = factory({ kind, values: v, folder, dataDir: this.#o.dataDir, log: this.#o.log });
    } catch (e) {
      tunnel?.close();
      throw e;
    }
    if (tunnel) {
      const t = tunnel;
      const close = driver.close.bind(driver);
      driver.close = async () => {
        try {
          await close();
        } finally {
          t.close();
        }
      };
    }
    return driver;
  }

  async close(id: string): Promise<void> {
    const pending = this.#opening.get(id);
    if (pending) await pending.catch(() => {});
    const open = this.#open.get(id);
    if (!open) return;
    this.#open.delete(id);
    this.#changes.emit('change');
    await open.driver.close().catch((e: Error) => this.#o.log(`closing: ${e.message}`));
  }

  async #sweep() {
    for (const [id, o] of this.#open) if (o.idleMs > 0 && Date.now() - o.used > o.idleMs) await this.close(id);
  }

  async shutdown() {
    clearInterval(this.#timer);
    await Promise.all([...this.#open.keys()].map((id) => this.close(id)));
  }
}
