// The saved connections: this server's, for every project, in the
// plugin's data folder. `connections.json` has everything but the secret
// fields, whose values are in `secrets.json` beside it, readable by the
// server's user only. Files are written whole (a temporary file, then
// renamed over), one change at a time, and every change is told to the
// windows watching.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PluginError } from '@hyperpane/sdk/server';
import { type Kind, type Values, kindOf, secretKeys } from '../shared/kinds.ts';
import type { Connection, ConnectionInput } from '../shared/types.ts';

type Kept = Omit<Connection, 'saved'>;
type Secrets = Record<string, Record<string, string>>;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new PluginError(`Couldn’t read ${path.basename(file)}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new PluginError(`${path.basename(file)} isn’t JSON any more (${(e as Error).message}): fix it, or remove it to start again.`);
  }
}

async function writeJson(file: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  await rename(tmp, file);
}

export const kindFor = (id: string): Kind => {
  const k = kindOf(id);
  if (!k) throw new PluginError(`Data doesn’t know “${id}” connections.`);
  return k;
};

/** Only the kind's own fields, as their types. */
function clean(kind: Kind, values: Values): Values {
  const out: Values = {};
  for (const f of kind.fields) {
    if (f.secret) continue;
    const v = values?.[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (f.type === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[f.key] = n;
    } else if (f.type === 'boolean') out[f.key] = v === true || v === 'true';
    else out[f.key] = String(v).slice(0, 4000);
  }
  return out;
}

export class Registry {
  readonly #dir: string;
  readonly #changes = new EventEmitter();
  #lock: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.#dir = dataDir;
    this.#changes.setMaxListeners(0);
  }

  get #file() {
    return path.join(this.#dir, 'connections.json');
  }

  get #secretsFile() {
    return path.join(this.#dir, 'secrets.json');
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn);
    this.#lock = run.catch(() => {});
    return run;
  }

  async #kept(): Promise<Kept[]> {
    const k = await readJson<{ connections?: Kept[] }>(this.#file, {});
    return Array.isArray(k.connections) ? k.connections.filter((c) => c && typeof c.id === 'string') : [];
  }

  #secrets(): Promise<Secrets> {
    return readJson<Secrets>(this.#secretsFile, {});
  }

  async list(): Promise<Connection[]> {
    const [kept, secrets] = await Promise.all([this.#kept(), this.#secrets()]);
    return kept.map((c) => ({ ...c, color: c.color ?? null, group: c.group ?? '', readOnly: !!c.readOnly, used: c.used ?? null, saved: Object.keys(secrets[c.id] ?? {}) }));
  }

  async get(id: string): Promise<Connection> {
    const c = (await this.list()).find((x) => x.id === id);
    if (!c) throw new PluginError('That connection is gone: it was removed.');
    return c;
  }

  /** A connection's every value, secrets put back. */
  async values(id: string): Promise<{ connection: Connection; values: Values }> {
    const connection = await this.get(id);
    const secrets = (await this.#secrets())[id] ?? {};
    return { connection, values: { ...connection.values, ...secrets } };
  }

  /** The values a form gives, its secrets as the saved connection's where
   * it left them out (to test before saving). */
  async valuesOf(input: ConnectionInput): Promise<Values> {
    const kind = kindFor(input.kind);
    const saved = input.id ? ((await this.#secrets())[input.id] ?? {}) : {};
    const out: Values = clean(kind, input.values);
    for (const key of secretKeys(kind)) {
      const given = input.secrets?.[key];
      const v = given === undefined ? saved[key] : given;
      if (v) out[key] = v;
    }
    return out;
  }

  save(input: ConnectionInput): Promise<Connection> {
    const kind = kindFor(input.kind);
    const name = String(input.name ?? '').trim().slice(0, 120) || kind.name;
    return this.#serial(async () => {
      const [list, secrets] = await Promise.all([this.#kept(), this.#secrets()]);
      const old = input.id ? list.find((c) => c.id === input.id) : undefined;
      if (input.id && !old) throw new PluginError('That connection is gone: it was removed.');
      const id = old?.id ?? randomUUID();
      const next: Kept = {
        id,
        name,
        kind: kind.id,
        color: typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : null,
        group: String(input.group ?? '').trim().slice(0, 60),
        values: clean(kind, input.values ?? {}),
        readOnly: !!input.readOnly,
        created: old?.created ?? Date.now(),
        used: old?.used ?? null,
      };
      const mine: Record<string, string> = {};
      for (const key of secretKeys(kind)) {
        const given = input.secrets?.[key];
        const v = given === undefined ? secrets[id]?.[key] : given;
        if (v) mine[key] = String(v);
      }
      if (Object.keys(mine).length) secrets[id] = mine;
      else delete secrets[id];
      const i = list.findIndex((c) => c.id === id);
      if (i >= 0) list[i] = next;
      else list.push(next);
      await writeJson(this.#secretsFile, secrets, 0o600);
      await writeJson(this.#file, { version: 1, connections: list });
      this.#changes.emit('change');
      return { ...next, saved: Object.keys(mine) };
    });
  }

  remove(id: string): Promise<void> {
    return this.#serial(async () => {
      const [list, secrets] = await Promise.all([this.#kept(), this.#secrets()]);
      if (!list.some((c) => c.id === id)) return;
      delete secrets[id];
      await writeJson(this.#secretsFile, secrets, 0o600);
      await writeJson(this.#file, { version: 1, connections: list.filter((c) => c.id !== id) });
      this.#changes.emit('change');
    });
  }

  async duplicate(id: string): Promise<Connection> {
    const { connection } = await this.get(id).then((c) => ({ connection: c }));
    const secrets = (await this.#secrets())[id] ?? {};
    return this.save({ name: `${connection.name} copy`, kind: connection.kind, color: connection.color, group: connection.group, readOnly: connection.readOnly, values: connection.values, secrets });
  }

  /** Marks it connected now (for Recent). */
  touch(id: string): Promise<void> {
    return this.#serial(async () => {
      const list = await this.#kept();
      const c = list.find((x) => x.id === id);
      if (!c) return;
      c.used = Date.now();
      await writeJson(this.#file, { version: 1, connections: list });
      this.#changes.emit('change');
    });
  }

  /** Puts them in this order (ids not named stay last). */
  order(ids: string[]): Promise<void> {
    return this.#serial(async () => {
      const list = await this.#kept();
      const at = (c: Kept) => {
        const i = ids.indexOf(c.id);
        return i < 0 ? ids.length : i;
      };
      await writeJson(this.#file, { version: 1, connections: [...list].sort((a, b) => at(a) - at(b)) });
      this.#changes.emit('change');
    });
  }

  onChange(fn: () => void): () => void {
    this.#changes.on('change', fn);
    return () => this.#changes.off('change', fn);
  }
}
