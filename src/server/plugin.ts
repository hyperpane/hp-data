// The server part's calls, apart from main.ts so the tests can make it with
// a test host. Connections are this server's (registry.ts); each one used
// has a session (sessions.ts) with its engine's driver (drivers/). The
// calls are in groups, by domain (calls/):
//
// - connections: state, save, remove, duplicate, order, test, connect,
//   disconnect, children (the tree); the subscription watch.
// - sql: query, browse, describe, apply, completions.
// - kv: kvScan, kvGet, kvSet, kvEdit, kvRemove, kvRename, kvExpire, kvCommand.
// - document: docFind, docInsert, docReplace, docRemove, docCommand.
// - queue: qDescribe, qPeek, qPublish, qCreate, qRemove, qPurge; the
//   subscription qTail.
// - object: objList, objHead, objRead, objDownload, objUpload, objRemove,
//   objCopy, objPresign, objCreateBucket.

import { type Host, json } from '@hyperpane/sdk/server';
import type { Group } from './calls/context.ts';
import { connections } from './calls/connections.ts';
import { document } from './calls/document.ts';
import { kv } from './calls/kv.ts';
import { object } from './calls/object.ts';
import { queue } from './calls/queue.ts';
import { sql } from './calls/sql.ts';
import { Registry } from './registry.ts';
import { Sessions } from './sessions.ts';

export interface Options {
  idleMs?: number;
}

export function make(o: Options = {}) {
  return json((host: Host) => {
    const registry = new Registry(host.dataDir);
    const sessions = new Sessions(registry, {
      idleMs: o.idleMs,
      dataDir: host.dataDir,
      folderOf: (project) => {
        if (!project) return null;
        try {
          return host.projectFolder(project);
        } catch {
          return null;
        }
      },
      log: (line) => host.log(line),
    });
    const d = { host, registry, sessions };
    const groups: Group[] = [connections(d), sql(d), kv(d), document(d), queue(d), object(d)];
    return {
      calls: Object.assign({}, ...groups.map((g) => g.calls ?? {})),
      subscriptions: Object.assign({}, ...groups.map((g) => g.subscriptions ?? {})),
      busy: () => sessions.size > 0,
      async shutdown() {
        for (const g of groups) await g.shutdown?.();
        await sessions.shutdown();
      },
    };
  });
}

export const plugin = make();
