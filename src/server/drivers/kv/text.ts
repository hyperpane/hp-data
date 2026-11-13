// Bytes as text and back: a value that's UTF-8 is shown as it is; one
// that isn't is shown as redis-cli shows it (`\x00`, `\n`), and turned
// back into the same bytes when it's saved. Binary keys are remembered as
// they're listed, so the key shown is the key used.

import { isUtf8 as utf8 } from 'node:buffer';

/** True when the bytes are UTF-8 (and so a string can carry them). */
export const isUtf8 = (b: Buffer): boolean => utf8(b);

/** Bytes as redis-cli quotes them, without the quotes: `\"`, `\\`, `\n`,
 * `\xNN` for what isn't printable. UTF-8 is kept as it is when `utf8`. */
export function escapeBytes(b: Buffer, utf8 = isUtf8(b)): string {
  if (utf8) {
    const s = b.toString('utf8');
    let out = '';
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      out += ESC[ch] ?? (c < 0x20 || c === 0x7f ? `\\x${c.toString(16).padStart(2, '0')}` : ch);
    }
    return out;
  }
  let out = '';
  for (const c of b) {
    const ch = String.fromCharCode(c);
    out += ESC[ch] ?? (c >= 0x20 && c < 0x7f ? ch : `\\x${c.toString(16).padStart(2, '0')}`);
  }
  return out;
}

const ESC: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\x07': '\\a', '\b': '\\b' };
const UNESC: Record<string, string> = { n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b', '"': '"', "'": "'", '\\': '\\' };

/** What escapeBytes gave, as the bytes again. */
export function unescapeBytes(s: string): Buffer {
  const parts: Buffer[] = [];
  let text = '';
  const flush = () => {
    if (text) parts.push(Buffer.from(text, 'utf8'));
    text = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) {
      text += c;
      continue;
    }
    const n = s[i + 1];
    if (n === 'x' && /^[0-9a-f]{2}$/i.test(s.slice(i + 2, i + 4))) {
      flush();
      parts.push(Buffer.from([parseInt(s.slice(i + 2, i + 4), 16)]));
      i += 3;
    } else if (n in UNESC) {
      text += UNESC[n];
      i++;
    } else text += c;
  }
  flush();
  return Buffer.concat(parts);
}

/** A value as text: as it is when it's UTF-8, escaped when it isn't. */
export function show(b: Buffer): { text: string; binary: boolean } {
  return plain(b) ? { text: b.toString('utf8'), binary: false } : { text: escapeBytes(b), binary: true };
}

/** UTF-8 without control characters (but tabs and line breaks). */
const plain = (b: Buffer): boolean => isUtf8(b) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(b.toString('latin1'));

/** Text as the bytes to store: escapes undone when it was shown escaped. */
export const bytesOf = (text: string, binary?: boolean): Buffer => (binary ? unescapeBytes(text) : Buffer.from(text, 'utf8'));

/** Binary keys seen, by how they're shown: so a key listed as `a\x00b`
 * is that key when it comes back. */
export class KeyNames {
  readonly #seen = new Map<string, Buffer>();
  readonly #max: number;
  constructor(max = 50_000) {
    this.#max = max;
  }
  /** A key's name for the window. */
  name(b: Buffer): string {
    if (plain(b) && !/[\t\r\n]/.test(b.toString('latin1'))) return b.toString('utf8');
    const s = escapeBytes(b);
    if (this.#seen.size >= this.#max) this.#seen.delete(this.#seen.keys().next().value!);
    this.#seen.set(s, b);
    return s;
  }
  /** The bytes of a key the window names. */
  bytes(s: string): Buffer {
    return this.#seen.get(s) ?? Buffer.from(s, 'utf8');
  }
}
