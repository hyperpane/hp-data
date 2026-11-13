// The console's side of Redis, as redis-cli has it: a line split into
// arguments (quotes, `\x00` escapes), a reply printed as it prints them
// (`(integer) 1`, `"value"`, `1) …`, `(nil)`, `(error) …`), and which
// commands only read, for connections marked read only.

import { PluginError } from '@hyperpane/sdk/server';
import { RespError, type Reply } from './resp.ts';
import { escapeBytes } from './text.ts';

const HEX = /^[0-9a-f]{2}$/i;
const ESCAPES: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, a: 7 };

/** A command line as arguments, as redis-cli splits it. Throws on
 * unbalanced quotes. */
export function tokenize(line: string): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    const bytes: number[] = [];
    const text = (s: string) => bytes.push(...Buffer.from(s, 'utf8'));
    let quote: '"' | "'" | null = null;
    let done = false;
    while (!done) {
      if (i >= n) {
        if (quote) throw new PluginError(`The ${quote === '"' ? 'double' : 'single'} quote isn’t closed.`);
        break;
      }
      const c = line[i];
      if (quote === '"') {
        if (c === '\\' && line[i + 1] === 'x' && HEX.test(line.slice(i + 2, i + 4))) {
          bytes.push(parseInt(line.slice(i + 2, i + 4), 16));
          i += 4;
          continue;
        }
        if (c === '\\' && i + 1 < n) {
          const e = line[i + 1];
          if (e in ESCAPES) bytes.push(ESCAPES[e]);
          else text(e);
          i += 2;
          continue;
        }
        if (c === '"') {
          if (i + 1 < n && !/\s/.test(line[i + 1])) throw new PluginError('A closing quote must be followed by a space.');
          done = true;
        } else text(c);
      } else if (quote === "'") {
        if (c === '\\' && line[i + 1] === "'") {
          text("'");
          i += 2;
          continue;
        }
        if (c === "'") {
          if (i + 1 < n && !/\s/.test(line[i + 1])) throw new PluginError('A closing quote must be followed by a space.');
          done = true;
        } else text(c);
      } else if (/\s/.test(c)) {
        done = true;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else {
        // Code points, not UTF-16 halves.
        const cp = line.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        text(ch);
        i += ch.length;
        continue;
      }
      i++;
    }
    out.push(Buffer.from(bytes));
  }
  return out;
}

/** A reply as redis-cli prints it. */
export function format(r: Reply): string {
  return lines(r).join('\n');
}

function lines(r: Reply): string[] {
  if (r === null) return ['(nil)'];
  if (r instanceof RespError) return [`(error) ${r.message}`];
  if (typeof r === 'number' || typeof r === 'bigint') return [`(integer) ${r}`];
  if (typeof r === 'string') return [r];
  if (Buffer.isBuffer(r)) return [`"${escapeBytes(r)}"`];
  if (r.length === 0) return ['(empty array)'];
  const w = String(r.length).length;
  const out: string[] = [];
  r.forEach((item, i) => {
    const prefix = `${String(i + 1).padStart(w)}) `;
    const sub = lines(item);
    out.push(prefix + sub[0], ...sub.slice(1).map((l) => ' '.repeat(prefix.length) + l));
  });
  return out;
}

/** Commands that only read (with their subcommands, for those that have
 * both kinds). Anything else is taken to write. */
const READS = new Set(
  (
    'GET MGET STRLEN GETRANGE SUBSTR LCS EXISTS TYPE TTL PTTL EXPIRETIME PEXPIRETIME KEYS SCAN DBSIZE RANDOMKEY DUMP TOUCH ' +
    'INFO PING ECHO TIME LASTSAVE ROLE SELECT ' +
    'HGET HGETALL HMGET HKEYS HVALS HLEN HEXISTS HSCAN HSTRLEN HRANDFIELD HTTL HPTTL ' +
    'LRANGE LLEN LINDEX LPOS ' +
    'SMEMBERS SISMEMBER SMISMEMBER SCARD SSCAN SRANDMEMBER SINTER SUNION SDIFF SINTERCARD ' +
    'ZRANGE ZRANGEBYSCORE ZREVRANGE ZREVRANGEBYSCORE ZRANGEBYLEX ZREVRANGEBYLEX ZSCORE ZMSCORE ZCARD ZCOUNT ZLEXCOUNT ZRANK ZREVRANK ZSCAN ZRANDMEMBER ZINTER ZUNION ZDIFF ZINTERCARD ' +
    'XRANGE XREVRANGE XLEN XPENDING XREAD ' +
    'BITCOUNT GETBIT BITPOS BITFIELD_RO PFCOUNT GEOPOS GEODIST GEOHASH GEOSEARCH GEORADIUS_RO GEORADIUSBYMEMBER_RO ' +
    'JSON.GET JSON.MGET JSON.TYPE JSON.OBJKEYS JSON.OBJLEN JSON.STRLEN JSON.ARRLEN JSON.ARRINDEX JSON.RESP ' +
    'FT.SEARCH FT.INFO FT.AGGREGATE FT._LIST ' +
    'OBJECT MEMORY XINFO COMMAND LATENCY ' +
    'CONFIG|GET CLIENT|LIST CLIENT|INFO CLIENT|GETNAME CLIENT|ID SLOWLOG|GET SLOWLOG|LEN CLUSTER|INFO CLUSTER|NODES CLUSTER|SLOTS CLUSTER|SHARDS CLUSTER|MYID CLUSTER|KEYSLOT CLUSTER|COUNTKEYSINSLOT ' +
    'FUNCTION|LIST FUNCTION|STATS SCRIPT|EXISTS ACL|WHOAMI ACL|LIST ACL|USERS ACL|CAT ACL|GETUSER MODULE|LIST ' +
    // etcd's console
    'LS COUNT VERSION HELP'
  ).split(/\s+/),
);
const WITH_SUBCOMMANDS = new Set(['CONFIG', 'CLIENT', 'SLOWLOG', 'CLUSTER', 'FUNCTION', 'SCRIPT', 'ACL', 'MODULE']);

/** True when the command only reads. */
export function readsOnly(args: string[]): boolean {
  const name = (args[0] ?? '').toUpperCase();
  if (WITH_SUBCOMMANDS.has(name)) return READS.has(`${name}|${(args[1] ?? '').toUpperCase()}`);
  if (name === 'XREAD') return true;
  if (name === 'HELLO') return args.length <= 2;
  return READS.has(name);
}

/** Commands the console doesn't run: they'd turn the connection into
 * something else than a request and a reply. */
export function refused(name: string): string | null {
  switch (name.toUpperCase()) {
    case 'SUBSCRIBE':
    case 'PSUBSCRIBE':
    case 'SSUBSCRIBE':
      return 'The console doesn’t subscribe: it runs a command and shows its reply.';
    case 'MONITOR':
      return 'MONITOR doesn’t end: run it in redis-cli in a terminal.';
    case 'SYNC':
    case 'PSYNC':
      return 'That’s for replicas.';
    case 'QUIT':
    case 'RESET':
      return 'The console keeps its connection: close the tab instead.';
    default:
      return null;
  }
}
