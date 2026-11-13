// What every group of calls shares: the host, the saved connections and
// the open sessions. A call names its connection by `id`, and the project
// it's made from by `project` (SQLite's relative paths are its folder's).

import { type Host, type JsonSpec, PluginError } from '@hyperpane/sdk/server';
import type { Registry } from '../registry.ts';
import type { Sessions } from '../sessions.ts';

export interface Deps {
  host: Host;
  registry: Registry;
  sessions: Sessions;
}

/** A group of calls and subscriptions by op, and what ends its work. */
export interface Group {
  calls?: NonNullable<JsonSpec['calls']>;
  subscriptions?: NonNullable<JsonSpec['subscriptions']>;
  shutdown?(): void | Promise<void>;
}

export function idOf(req: { id?: unknown }): string {
  if (typeof req?.id !== 'string' || !req.id) throw new PluginError('Pick a connection first.');
  return req.id;
}

export const projectOf = (req: { project?: unknown }): string | null => (typeof req?.project === 'string' && req.project ? req.project : null);

/** A number in a range, or the fallback. */
export function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** Refuses a change on a connection marked read only. */
export async function writable({ registry }: Deps, id: string): Promise<void> {
  const c = await registry.get(id);
  if (c.readOnly) throw new PluginError(`“${c.name}” is read only: change that in its settings to make changes.`);
}
