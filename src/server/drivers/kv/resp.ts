// RESP2, Redis's wire format: commands encoded as arrays of bulk strings,
// and a parser for replies that takes bytes as they come (a reply split
// over many chunks, or many replies in one) and hands back whole ones.
// Bulk strings stay Buffers; text.ts turns them into what's shown.

/** An error reply (`-ERR …`): a value, not thrown, so a console shows it. */
export class RespError {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
  /** The first word: ERR, WRONGTYPE, NOAUTH, MOVED… */
  get code(): string {
    return /^\S+/.exec(this.message)?.[0] ?? 'ERR';
  }
}

/** A reply: a simple string, an integer (a bigint past 2^53), a bulk
 * string, nil, an array, or an error. */
export type Reply = string | number | bigint | Buffer | null | RespError | Reply[];

export type Arg = string | Buffer | number;

/** A command as RESP: `*n` and each argument as a bulk string. */
export function encode(args: Arg[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8');
    parts.push(Buffer.from(`$${b.length}\r\n`), b, CRLF);
  }
  return Buffer.concat(parts);
}

const CRLF = Buffer.from('\r\n');
const MORE = Symbol('more');
type Header = { array: number };

/** Replies from bytes, however they're cut. */
export class Parser {
  #buf: Buffer = Buffer.alloc(0);
  #off = 0;
  /** Chunks not joined yet: while a big bulk string is still arriving. */
  #pending: Buffer[] = [];
  #pendingLen = 0;
  /** Bytes needed (from #off) before trying again. */
  #need = 0;
  /** Arrays being filled, innermost last. */
  #stack: { items: Reply[]; left: number }[] = [];

  /** Takes a chunk; gives the replies it completed. */
  push(chunk: Buffer): Reply[] {
    this.#pending.push(chunk);
    this.#pendingLen += chunk.length;
    if (this.#buf.length - this.#off + this.#pendingLen < this.#need) return [];
    this.#buf = Buffer.concat([this.#buf.subarray(this.#off), ...this.#pending]);
    this.#off = 0;
    this.#pending = [];
    this.#pendingLen = 0;
    this.#need = 0;
    const out: Reply[] = [];
    for (;;) {
      const el = this.#element();
      if (el === MORE) break;
      let value: Reply;
      if (isHeader(el)) {
        if (el.array > 0) {
          this.#stack.push({ items: [], left: el.array });
          continue;
        }
        value = el.array < 0 ? null : [];
      } else value = el;
      for (;;) {
        const top = this.#stack.at(-1);
        if (!top) {
          out.push(value);
          break;
        }
        top.items.push(value);
        if (--top.left > 0) break;
        this.#stack.pop();
        value = top.items;
      }
    }
    return out;
  }

  /** Bytes held, for tests. */
  get buffered(): number {
    return this.#buf.length - this.#off + this.#pendingLen;
  }

  #element(): Reply | Header | typeof MORE {
    const buf = this.#buf;
    const start = this.#off;
    if (start >= buf.length) return MORE;
    const eol = buf.indexOf(CRLF, start);
    if (eol < 0) return MORE;
    const type = buf[start];
    const line = buf.toString('utf8', start + 1, eol);
    switch (type) {
      case 0x2b: // +
        this.#off = eol + 2;
        return line;
      case 0x2d: // -
        this.#off = eol + 2;
        return new RespError(line);
      case 0x3a: {
        // :
        this.#off = eol + 2;
        const n = Number(line);
        return Number.isSafeInteger(n) ? n : BigInt(line);
      }
      case 0x24: {
        // $
        const len = Number(line);
        if (len < 0) {
          this.#off = eol + 2;
          return null;
        }
        const from = eol + 2;
        if (buf.length < from + len + 2) {
          this.#need = from + len + 2 - start;
          return MORE;
        }
        this.#off = from + len + 2;
        return Buffer.from(buf.subarray(from, from + len));
      }
      case 0x2a: // *
        this.#off = eol + 2;
        return { array: Number(line) };
      default:
        throw new Error(`Not a RESP reply: ${JSON.stringify(buf.toString('latin1', start, Math.min(eol, start + 40)))}`);
    }
  }
}

const isHeader = (v: unknown): v is Header => !!v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && 'array' in v;
