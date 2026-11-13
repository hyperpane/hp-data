// mongosh's lines, read: `show dbs`, `use shop`, `db.runCommand({…})`,
// `db.users.find({age: {$gt: 30}}).sort({name: 1}).limit(20)`,
// `db.getCollection("a.b").aggregate([…])`. Pure: what's read is run by
// mongo-console.ts. Several statements, by `;` or one after another, are
// run in order.

import { PluginError } from '@hyperpane/sdk/server';
import { Reader } from './relaxed.ts';

export interface ShellCall {
  name: string;
  args: unknown[];
}

export type Statement =
  | { kind: 'show'; what: string }
  | { kind: 'use'; database: string }
  /** `db` alone, or db's own methods (runCommand, getCollectionNames…). */
  | { kind: 'db'; database?: string; calls: ShellCall[] }
  /** A collection's method, then the cursor's (sort, limit…). */
  | { kind: 'collection'; database?: string; collection: string; calls: ShellCall[] };

function word(r: Reader): string {
  r.ws();
  const m = /^[^\s;]+/.exec(r.text.slice(r.pos));
  if (!m) r.fail('Expected a name');
  r.pos += m[0].length;
  return m[0];
}

function statement(r: Reader): Statement {
  const at = r.pos;
  const head = r.ident();
  if (head === 'show') return { kind: 'show', what: word(r) };
  if (head === 'use') return { kind: 'use', database: word(r).replace(/^["']|["']$/g, '') };
  if (head !== 'db') r.fail(head ? `“${head}” isn’t something the console knows: start with db., show or use` : 'Expected db., show or use', at);
  let database: string | undefined;
  const props: string[] = [];
  const calls: ShellCall[] = [];
  for (;;) {
    if (r.eat('[')) {
      const name = r.string();
      r.expect(']');
      if (calls.length) r.fail('A name after a call');
      props.push(name);
      continue;
    }
    if (!r.eat('.')) break;
    const name = r.ident();
    if (name === null) r.fail('Expected a name after “.”');
    if (r.peek() !== '(') {
      if (calls.length) r.fail(`“${name}” after a call isn’t something the console knows`);
      props.push(name);
      continue;
    }
    const args = r.args();
    if (!props.length && !calls.length && name === 'getSiblingDB') {
      if (typeof args[0] !== 'string') r.fail('getSiblingDB takes a database’s name');
      database = args[0];
      continue;
    }
    if (!props.length && !calls.length && name === 'getCollection') {
      if (typeof args[0] !== 'string') r.fail('getCollection takes a collection’s name');
      props.push(args[0]);
      continue;
    }
    calls.push({ name, args });
  }
  if (props.length) {
    if (!calls.length) r.fail(`Say what to do with ${props.join('.')}: find(), countDocuments()…`);
    return { kind: 'collection', database, collection: props.join('.'), calls };
  }
  return { kind: 'db', database, calls };
}

/** The statements in the text, in order. */
export function parseShell(text: string): Statement[] {
  const r = new Reader(text);
  const out: Statement[] = [];
  while (!r.done) {
    if (r.eat(';')) continue;
    out.push(statement(r));
    r.ws();
    // What's next starts a statement of its own, or it's a mistake.
    const next = r.text[r.pos];
    if (next !== undefined && next !== ';' && !/^\s*(db\b|show\b|use\b)/.test(r.text.slice(r.pos))) r.fail(`Unexpected “${next}”`);
  }
  if (!out.length) throw new PluginError('Type something to run: db.collection.find(), show collections…');
  return out;
}

const WRITES = /^(insert|insertOne|insertMany|update|updateOne|updateMany|replaceOne|delete|deleteOne|deleteMany|remove|findOneAndUpdate|findOneAndReplace|findOneAndDelete|findAndModify|bulkWrite|drop|dropIndex|dropIndexes|createIndex|createIndexes|renameCollection|createCollection|createView|dropDatabase|save)$/;
const COMMAND_WRITES = /^(insert|update|delete|drop|dropDatabase|create|createIndexes|dropIndexes|renameCollection|findAndModify|collMod|shutdown|createUser|dropUser|updateUser|grantRolesToUser|revokeRolesFromUser|compact|reIndex|applyOps)$/i;

/** It changes something (as far as can be told): for read-only
 * connections. Text that doesn't parse doesn't run, so isn't one. */
export function shellWrites(text: string): boolean {
  let statements: Statement[];
  try {
    statements = parseShell(text);
  } catch {
    return false;
  }
  return statements.some((s) => {
    if (s.kind === 'collection') return s.calls.some((c) => WRITES.test(c.name));
    if (s.kind !== 'db') return false;
    return s.calls.some((c) => {
      if (WRITES.test(c.name)) return true;
      if (c.name !== 'runCommand' && c.name !== 'adminCommand') return false;
      const cmd = c.args[0];
      const first = cmd && typeof cmd === 'object' ? Object.keys(cmd)[0] : typeof cmd === 'string' ? cmd : '';
      return COMMAND_WRITES.test(first ?? '');
    });
  });
}
