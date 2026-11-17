// Relaxed JSON, as people type it in a filter or in mongosh: unquoted
// keys, single quotes, trailing commas, comments, and the shell's literals
// (ObjectId("…"), ISODate("…"), NumberLong(…), /regex/i, MinKey…), each
// turned into its Extended JSON form ({"$oid": "…"}), so the MongoDB driver
// can read it with EJSON and the others get plain JSON. The Reader is also
// what the mongosh line parser (shell.ts) reads values with.

import { randomBytes } from 'node:crypto';
import { PluginError } from '@hyperpane/sdk/server';

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[A-Za-z0-9_$]/;

export class Reader {
  readonly text: string;
  pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  get done(): boolean {
    this.ws();
    return this.pos >= this.text.length;
  }

  /** Where it is, for an error: "line 2, column 5". */
  where(at = this.pos): string {
    const before = this.text.slice(0, at);
    const line = before.split('\n').length;
    const col = at - before.lastIndexOf('\n');
    return `line ${line}, column ${col}`;
  }

  fail(what: string, at = this.pos): never {
    throw new PluginError(`${what} at ${this.where(at)}.`);
  }

  /** Skips spaces and comments. */
  ws(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.pos++;
      else if (c === '/' && t[this.pos + 1] === '/') {
        while (this.pos < t.length && t[this.pos] !== '\n') this.pos++;
      } else if (c === '/' && t[this.pos + 1] === '*') {
        const end = t.indexOf('*/', this.pos + 2);
        this.pos = end < 0 ? t.length : end + 2;
      } else break;
    }
  }

  peek(): string {
    this.ws();
    return this.text[this.pos] ?? '';
  }

  /** Takes `s` if it's next. */
  eat(s: string): boolean {
    this.ws();
    if (this.text.startsWith(s, this.pos)) {
      this.pos += s.length;
      return true;
    }
    return false;
  }

  expect(s: string): void {
    if (!this.eat(s)) this.fail(`Expected “${s}”${this.pos < this.text.length ? ` but found “${this.text[this.pos]}”` : ' but the text ended'}`);
  }

  /** A name: letters, digits, _ and $ (or null when none is next). */
  ident(): string | null {
    this.ws();
    if (!IDENT_START.test(this.text[this.pos] ?? '')) return null;
    const start = this.pos;
    while (this.pos < this.text.length && IDENT.test(this.text[this.pos])) this.pos++;
    return this.text.slice(start, this.pos);
  }

  string(): string {
    this.ws();
    const q = this.text[this.pos];
    if (q !== '"' && q !== "'" && q !== '`') this.fail('Expected a string');
    const start = this.pos;
    this.pos++;
    let out = '';
    const t = this.text;
    while (this.pos < t.length && t[this.pos] !== q) {
      const c = t[this.pos++];
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = t[this.pos++];
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
      if (e === 'u') {
        const hex = t[this.pos] === '{' ? t.slice(this.pos + 1, t.indexOf('}', this.pos)) : t.slice(this.pos, this.pos + 4);
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) this.fail('A bad \\u escape');
        out += String.fromCodePoint(parseInt(hex, 16));
        this.pos += t[this.pos] === '{' ? hex.length + 2 : 4;
      } else if (e === 'x') {
        out += String.fromCharCode(parseInt(t.slice(this.pos, this.pos + 2), 16));
        this.pos += 2;
      } else if (e === '\n') {
        // A line continued.
      } else out += map[e] ?? e;
    }
    if (this.pos >= t.length) this.fail('A string that isn’t closed', start);
    this.pos++;
    return out;
  }

  number(): number | { $numberLong: string } {
    this.ws();
    const m = /^[+-]?(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(this.text.slice(this.pos));
    if (!m) this.fail('Expected a number');
    this.pos += m[0].length;
    const n = Number(m[0]);
    // An integer too big for a double keeps its digits.
    if (Number.isInteger(n) && !Number.isSafeInteger(n) && /^[+-]?\d+$/.test(m[0])) return { $numberLong: m[0].replace(/^\+/, '') };
    return n;
  }

  regex(): { $regularExpression: { pattern: string; options: string } } {
    this.ws();
    const start = this.pos;
    const t = this.text;
    this.pos++;
    let inClass = false;
    let pattern = '';
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === '\n') break;
      if (c === '\\') {
        // \/ is only there for the slash: the pattern doesn't need it.
        pattern += t[this.pos + 1] === '/' ? '/' : c + (t[this.pos + 1] ?? '');
        this.pos += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      pattern += c;
      this.pos++;
    }
    if (t[this.pos] !== '/') this.fail('A regular expression that isn’t closed', start);
    this.pos++;
    let options = '';
    while (/[a-z]/.test(t[this.pos] ?? '')) options += t[this.pos++];
    return { $regularExpression: { pattern, options: [...options].sort().join('') } };
  }

  /** Arguments between parentheses: `(a, b)`. */
  args(): unknown[] {
    this.expect('(');
    const out: unknown[] = [];
    while (!this.eat(')')) {
      out.push(this.value());
      if (!this.eat(',')) {
        this.expect(')');
        break;
      }
    }
    return out;
  }

  object(): Record<string, unknown> {
    this.expect('{');
    const out: Record<string, unknown> = {};
    while (!this.eat('}')) {
      const c = this.peek();
      let key: string;
      if (c === '"' || c === "'" || c === '`') key = this.string();
      else if (/[0-9.+-]/.test(c)) key = String(this.number());
      else {
        const id = this.ident();
        if (id === null) this.fail(c ? `Expected a key but found “${c}”` : 'Expected a key but the text ended');
        key = id;
        // Dotted paths unquoted: {address.city: 1}.
        while (this.text[this.pos] === '.' && IDENT_START.test(this.text[this.pos + 1] ?? '')) {
          this.pos++;
          key += `.${this.ident()}`;
        }
      }
      this.expect(':');
      out[key] = this.value();
      if (!this.eat(',')) {
        this.expect('}');
        break;
      }
    }
    return out;
  }

  array(): unknown[] {
    this.expect('[');
    const out: unknown[] = [];
    while (!this.eat(']')) {
      out.push(this.value());
      if (!this.eat(',')) {
        this.expect(']');
        break;
      }
    }
    return out;
  }

  value(): unknown {
    const c = this.peek();
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"' || c === "'" || c === '`') return this.string();
    if (c === '/') return this.regex();
    if (c === '-' && this.text.startsWith('-Infinity', this.pos)) {
      this.pos += 9;
      return { $numberDouble: '-Infinity' };
    }
    if (/[0-9.+-]/.test(c)) return this.number();
    const at = this.pos;
    let name = this.ident();
    if (name === null) this.fail(c ? `Unexpected “${c}”` : 'Expected a value but the text ended');
    if (name === 'new') {
      name = this.ident();
      if (name === null) this.fail('Expected a name after “new”');
    }
    return this.literal(name, at);
  }

  literal(name: string, at: number): unknown {
    const called = this.peek() === '(';
    const args = called ? this.args() : [];
    const str = (i = 0) => {
      const a = args[i];
      if (typeof a !== 'string') this.fail(`${name} takes a string`, at);
      return a;
    };
    switch (name) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
      case 'undefined':
        return null;
      case 'NaN':
        return { $numberDouble: 'NaN' };
      case 'Infinity':
        return { $numberDouble: 'Infinity' };
      case 'ObjectId':
      case 'ObjectID': {
        if (!args.length) return { $oid: newObjectId() };
        const s = str();
        if (!/^[0-9a-fA-F]{24}$/.test(s)) this.fail('An ObjectId is 24 hexadecimal digits', at);
        return { $oid: s.toLowerCase() };
      }
      case 'ISODate':
      case 'Date': {
        const a = args[0];
        const d = a === undefined ? new Date() : typeof a === 'string' || typeof a === 'number' ? new Date(a) : null;
        if (!d || Number.isNaN(d.getTime())) this.fail('Not a date', at);
        return { $date: d.toISOString() };
      }
      case 'NumberLong':
      case 'Long': {
        const a = args[0] ?? 0;
        const s = typeof a === 'object' && a && '$numberLong' in a ? String((a as { $numberLong: string }).$numberLong) : String(a);
        if (!/^-?\d+$/.test(s)) this.fail('NumberLong takes an integer', at);
        return { $numberLong: s };
      }
      case 'NumberInt':
      case 'Int32': {
        const n = Number(args[0] ?? 0);
        if (!Number.isInteger(n)) this.fail('NumberInt takes an integer', at);
        return { $numberInt: String(n) };
      }
      case 'NumberDecimal':
      case 'Decimal128':
        return { $numberDecimal: String(args[0] ?? '0') };
      case 'Double':
        return Number(args[0] ?? 0);
      case 'Timestamp': {
        const a = args[0];
        if (a && typeof a === 'object') return { $timestamp: a };
        return { $timestamp: { t: Number(a ?? 0), i: Number(args[1] ?? 0) } };
      }
      case 'UUID':
        return { $uuid: args.length ? str() : crypto.randomUUID() };
      case 'BinData':
        return {
          $binary: {
            base64: str(1),
            subType: Number(args[0] ?? 0)
              .toString(16)
              .padStart(2, '0'),
          },
        };
      case 'MinKey':
        return { $minKey: 1 };
      case 'MaxKey':
        return { $maxKey: 1 };
      case 'RegExp':
        return { $regularExpression: { pattern: str(), options: typeof args[1] === 'string' ? args[1] : '' } };
      default:
        this.fail(`“${name}” isn’t something that can be written here`, at);
    }
  }
}

/** An ObjectId's hex, as the shell makes one: the time, then random. */
function newObjectId(): string {
  const time = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, '0');
  return time + randomBytes(8).toString('hex');
}

/** One value from the whole text ('' is undefined). */
export function parseRelaxed(text: string): unknown {
  const r = new Reader(text);
  if (r.done) return undefined;
  const v = r.value();
  if (!r.done) r.fail(`Unexpected “${r.text[r.pos]}” after the value`);
  return v;
}

/** An object from the text, or `fallback` when it's blank. */
export function parseObject(text: string | undefined, what: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  const v = parseRelaxed(text ?? '');
  if (v === undefined) return fallback;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PluginError(`The ${what} has to be an object: { key: value }`);
  return v as Record<string, unknown>;
}
