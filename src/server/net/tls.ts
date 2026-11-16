// A connection's own TLS: a CA certificate (trusted as well as the
// system's authorities), a client certificate and key, the name the
// server's certificate is checked against. Each is a file on the server or
// the PEM pasted; files are read when the session opens (`resolveTls`),
// and every driver takes the result as Node's TLS options (`tlsOf`).

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { PluginError } from '@hyperpane/sdk/server';
import type { Values } from '../../shared/kinds.ts';

export interface TlsOptions {
  ca?: string[];
  cert?: string;
  key?: string;
  passphrase?: string;
  servername?: string;
}

const isPem = (s: string) => /-----BEGIN [A-Z0-9 ]+-----/.test(s);

async function pem(value: unknown, what: string, folder: string | null): Promise<string | undefined> {
  const s = String(value ?? '').trim();
  if (!s) return undefined;
  if (isPem(s)) return `${s}\n`;
  const file = s.replace(/^~(?=\/|$)/, os.homedir());
  const full = path.isAbsolute(file) ? file : folder ? path.join(folder, file) : file;
  try {
    const text = await readFile(full, 'utf8');
    if (!isPem(text)) throw new PluginError(`${s} isn’t a PEM file (the ${what} should start with -----BEGIN …-----).`);
    return text;
  } catch (e) {
    if (e instanceof PluginError) throw e;
    throw new PluginError(
      `Couldn’t read the ${what} ${s} on the server: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'there’s no such file' : (e as Error).message}.`,
    );
  }
}

/** The values with their certificates read in (as `_tls`, JSON). */
export async function resolveTls(v: Values, folder: string | null): Promise<Values> {
  const ca = await pem(v.tlsCa, 'CA certificate', folder);
  const cert = await pem(v.tlsCert, 'client certificate', folder);
  const key = await pem(v.tlsKey, 'client key', folder);
  if (!ca && !cert && !key && !v.tlsServername && !v._servername) return v;
  if (!!cert !== !!key) throw new PluginError(cert ? 'Give the client key too.' : 'Give the client certificate too.');
  const o: TlsOptions = {
    ca: ca ? [...tls.rootCertificates, ca] : undefined,
    cert,
    key,
    passphrase: v.tlsKeyPassphrase ? String(v.tlsKeyPassphrase) : undefined,
    servername: String(v.tlsServername || v._servername || '') || undefined,
  };
  return { ...v, _tls: JSON.stringify(o) };
}

/** Node's TLS options for a connection (empty when it has none of its own). */
export function tlsOf(v: Values): TlsOptions {
  if (!v._tls) return {};
  try {
    return JSON.parse(String(v._tls)) as TlsOptions;
  } catch {
    return {};
  }
}

/** Has certificates or a server name of its own. */
export const hasOwnTls = (v: Values) => !!v._tls;
