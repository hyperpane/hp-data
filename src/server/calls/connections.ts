// The saved connections: listed, saved, removed, tested, watched; and
// their sessions: connected, disconnected, and what's in one (the tree).

import type { ConnectionInput, SessionInfo, State } from '../../shared/types.ts';
import { forgetHost } from '../net/ssh.ts';
import { withTimeout } from '../sessions.ts';
import { type Deps, type Group, idOf, projectOf } from './context.ts';

export function connections(d: Deps): Group {
  const { registry, sessions } = d;
  const state = async (): Promise<State> => ({ connections: await registry.list(), open: sessions.infos() });
  return {
    calls: {
      state,
      save: async ({ connection }: { connection: ConnectionInput }) => {
        const saved = await registry.save(connection);
        // What was open used the old values.
        if (connection.id) await sessions.close(saved.id);
        return saved;
      },
      remove: async (req) => {
        const id = idOf(req);
        await sessions.close(id);
        await registry.remove(id);
        return null;
      },
      duplicate: (req) => registry.duplicate(idOf(req)),
      order: ({ ids }) => registry.order(Array.isArray(ids) ? ids.map(String) : []).then(() => null),
      /** A form's values, tried: what the server says it is, or why not. */
      test: async (req: { connection: ConnectionInput; project?: string }): Promise<Omit<SessionInfo, 'at'>> => {
        const values = await registry.valuesOf(req.connection);
        const driver = await sessions.make(req.connection.kind, values, projectOf(req));
        try {
          return await withTimeout(driver.info(), Number(values.timeout ?? 20));
        } finally {
          void driver.close().catch(() => {});
        }
      },
      connect: async (req) => {
        const id = idOf(req);
        await sessions.get(id, projectOf(req));
        return sessions.infos()[id];
      },
      /** Forgets an SSH host's key, so the next connection takes the new one. */
      forgetSshHost: async (req: { host?: string; port?: number }) => ({
        forgotten: await forgetHost(d.host.dataDir, String(req.host ?? '').trim(), Number(req.port || 22)),
      }),
      disconnect: (req) => sessions.close(idOf(req)).then(() => null),
      /** What's under a path of the connection's tree. */
      children: async (req: { id: string; path?: unknown; project?: string }) => {
        const driver = await sessions.get(idOf(req), projectOf(req));
        const path = Array.isArray(req.path) ? req.path.map(String) : [];
        return driver.children(path);
      },
    },
    subscriptions: {
      /** The state now, and again on every change. */
      watch: (_req, out) => {
        let pending = false;
        const send = () => {
          if (pending) return;
          pending = true;
          queueMicrotask(() => {
            pending = false;
            void state().then(
              (s) => out.emit(s),
              () => {},
            );
          });
        };
        const offs = [registry.onChange(send), sessions.onChange(send)];
        out.signal.addEventListener(
          'abort',
          () => {
            for (const f of offs) f();
          },
          { once: true },
        );
        send();
      },
    },
  };
}
