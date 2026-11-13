// etcd's keys as its v3 JSON gateway has them: bytes in base64, a prefix
// as a range [key, range_end), and a glob pattern (as the keys tab types
// it) as the prefix to range over and a test for what's in it.

/** Bytes, or text as UTF-8, in base64. */
export const b64 = (v: string | Buffer): string => (Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8')).toString('base64');

export const unb64 = (s: string | undefined): Buffer => Buffer.from(s ?? '', 'base64');

/** The end of the range of keys that start with `prefix`: the prefix with
 * its last byte under 0xff one up (trailing 0xff dropped). Every key
 * (`\0`) for an empty prefix or one of 0xff only. */
export function prefixEnd(prefix: Buffer): Buffer {
  const b = Buffer.from(prefix);
  for (let i = b.length - 1; i >= 0; i--) {
    if (b[i] < 0xff) {
      b[i]++;
      return b.subarray(0, i + 1);
    }
  }
  return Buffer.from([0]);
}

/** The literal start of a glob, before its first `*`, `?` or `[`
 * (`\` escapes taken as the character). */
export function globPrefix(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' || c === '?' || c === '[') break;
    if (c === '\\' && i + 1 < pattern.length) out += pattern[++i];
    else out += c;
  }
  return out;
}

/** A glob as Redis matches it (`*`, `?`, `[a-z]`, `[^x]`, `\`) as a RegExp. */
export function globRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '\\' && i + 1 < pattern.length) re += escapeRe(pattern[++i]);
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        let set = pattern.slice(i + 1, end);
        if (set.startsWith('^')) set = `^${set.slice(1).replace(/[\\\]]/g, '\\$&')}`;
        else set = set.replace(/[\\\]^]/g, '\\$&');
        re += `[${set}]`;
        i = end;
      }
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`, 's');
}

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
