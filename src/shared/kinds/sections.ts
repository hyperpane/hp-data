// The form's other tabs, added to every kind whose engine takes them: SSH
// (a tunnel through a host), SSL/TLS (certificates of its own), and
// Options (a time zone, a timeout, the rows a console gives…).

import type { Engine, Field, Kind } from './types.ts';

/** Engines that can be reached through an SSH tunnel: those on one host
 * and port (Kafka's brokers name themselves, and AWS's endpoints are
 * public, so neither is). */
export const SSH_ENGINES: Engine[] = ['postgres', 'mysql', 'clickhouse', 'redis', 'etcd', 'mongodb', 'elasticsearch', 'rabbitmq'];

/** Engines whose TLS can take certificates of their own. */
export const TLS_ENGINES: Engine[] = ['postgres', 'mysql', 'clickhouse', 'redis', 'etcd', 'mongodb', 'elasticsearch', 'rabbitmq', 'kafka'];

const onSsh = { key: 'sshEnabled', is: [true] };

export const SSH_FIELDS: Field[] = [
  {
    key: 'sshEnabled',
    label: 'Connect through an SSH tunnel',
    type: 'boolean',
    default: false,
    section: 'ssh',
    help: 'The server connects to the SSH host, and from there to the database’s host and port (as the SSH host sees them: localhost is the SSH host itself).',
  },
  { key: 'sshHost', label: 'SSH host', type: 'text', placeholder: 'bastion.example.com', section: 'ssh', half: true, when: onSsh, required: true },
  { key: 'sshPort', label: 'Port', type: 'number', default: 22, placeholder: '22', section: 'ssh', half: true, when: onSsh },
  { key: 'sshUser', label: 'User', type: 'text', placeholder: 'the server’s user', section: 'ssh', when: onSsh },
  {
    key: 'sshAuth',
    label: 'Sign in with',
    type: 'select',
    default: 'key',
    section: 'ssh',
    when: onSsh,
    options: [
      { value: 'key', label: 'A key file' },
      { value: 'pasted', label: 'A key, pasted' },
      { value: 'password', label: 'A password' },
      { value: 'agent', label: 'The SSH agent' },
    ],
  },
  {
    key: 'sshKeyFile',
    label: 'Key file',
    type: 'text',
    placeholder: '~/.ssh/id_ed25519',
    section: 'ssh',
    when: { key: 'sshAuth', is: ['key'] },
    help: 'On the server. Empty: the usual ones in ~/.ssh.',
  },
  {
    key: 'sshKey',
    label: 'Private key',
    type: 'textarea',
    secret: true,
    placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----',
    section: 'ssh',
    when: { key: 'sshAuth', is: ['pasted'] },
  },
  {
    key: 'sshPassphrase',
    label: 'Passphrase',
    type: 'password',
    secret: true,
    placeholder: 'if the key has one',
    section: 'ssh',
    when: { key: 'sshAuth', is: ['key', 'pasted'] },
  },
  { key: 'sshPassword', label: 'Password', type: 'password', secret: true, section: 'ssh', when: { key: 'sshAuth', is: ['password'] } },
  { key: 'sshKeepAlive', label: 'Keep-alive (s)', type: 'number', default: 30, section: 'ssh', when: onSsh, half: true, help: '0 for none.' },
];

export const TLS_FIELDS: Field[] = [
  {
    key: 'tlsCa',
    label: 'CA certificate',
    type: 'textarea',
    placeholder: 'a file on the server (~/certs/ca.pem), or the PEM pasted',
    section: 'tls',
    help: 'Trusted as well as the system’s authorities: for a server’s certificate signed by your own.',
  },
  {
    key: 'tlsCert',
    label: 'Client certificate',
    type: 'textarea',
    placeholder: 'a file on the server, or the PEM pasted',
    section: 'tls',
    help: 'For servers that sign you in by certificate.',
  },
  { key: 'tlsKey', label: 'Client key', type: 'textarea', secret: true, placeholder: 'a file on the server, or the PEM pasted', section: 'tls' },
  { key: 'tlsKeyPassphrase', label: 'Key passphrase', type: 'password', secret: true, section: 'tls', half: true },
  {
    key: 'tlsServername',
    label: 'Server name',
    type: 'text',
    placeholder: 'the host',
    section: 'tls',
    half: true,
    help: 'The name its certificate is checked against, when it isn’t the host.',
  },
];

const REDIS_TLS: Field = { key: 'tlsInsecure', label: 'Accept any certificate', type: 'boolean', default: false, section: 'tls' };
const SQL_INIT: Field = {
  key: 'initSql',
  label: 'Run on connect',
  type: 'textarea',
  placeholder: 'SET search_path TO app, public;',
  advanced: true,
  help: 'Statements every new connection runs first: a search path, a time zone, a role.',
};

const LIMITS = ['100', '500', '1000', '5000', '20000'].map((v) => ({ value: v, label: `${Number(v).toLocaleString('en')} rows` }));

/** Options every connection of an engine family has (the Options tab). */
function options(k: Kind): Field[] {
  const sql = k.family === 'sql';
  const server = k.engine === 'postgres' || k.engine === 'mysql' || k.engine === 'clickhouse';
  const out: Field[] = [];
  if (k.engine === 'postgres') {
    out.push({
      key: 'searchPath',
      label: 'Default schema',
      type: 'text',
      placeholder: 'public',
      advanced: true,
      half: true,
      help: 'search_path: where names without a schema are looked for.',
    });
    out.push({
      key: 'applicationName',
      label: 'Application name',
      type: 'text',
      placeholder: 'hyperpane Data',
      advanced: true,
      half: true,
      help: 'As pg_stat_activity shows it.',
    });
  }
  if (server) {
    out.push({
      key: 'timezone',
      label: 'Time zone',
      type: 'text',
      placeholder: 'the server’s',
      advanced: true,
      half: true,
      help: 'UTC, Europe/Berlin, +03:00: what times are shown in.',
    });
    out.push({
      key: 'queryTimeout',
      label: 'Statement timeout (s)',
      type: 'number',
      placeholder: 'none',
      advanced: true,
      half: true,
      help: k.engine === 'mysql' ? 'SELECTs that run longer are stopped (max_execution_time).' : 'Statements that run longer are stopped.',
    });
    out.push({ key: 'showSystem', label: 'Show system databases and schemas', type: 'boolean', default: false, advanced: true });
  }
  if (sql) {
    out.push({
      key: 'rowLimit',
      label: 'Rows a console gives',
      type: 'select',
      default: '500',
      options: LIMITS,
      advanced: true,
      half: true,
      help: 'New consoles start with this; each one can change it.',
    });
    out.push({
      key: 'pageSize',
      label: 'Rows per table page',
      type: 'select',
      default: '200',
      options: ['50', '100', '200', '500', '1000'].map((v) => ({ value: v, label: v })),
      advanced: true,
      half: true,
    });
    out.push({
      key: 'confirmWrites',
      label: 'Ask before a console runs what changes data',
      type: 'boolean',
      default: false,
      advanced: true,
      help: 'INSERT, UPDATE, DELETE, DROP and the like: a safety net for production.',
    });
  }
  if (k.family === 'kv')
    out.push({
      key: 'scanCount',
      label: 'Keys per scan',
      type: 'number',
      default: 200,
      advanced: true,
      help: 'How many keys each “Load more” asks for (SCAN’s COUNT).',
    });
  out.push({
    key: 'idleMinutes',
    label: 'Disconnect when idle (min)',
    type: 'number',
    default: 15,
    advanced: true,
    half: true,
    help: '0: stay connected while the server part runs.',
  });
  if (!k.fields.some((f) => f.key === 'timeout'))
    out.push({ key: 'timeout', label: 'Give up connecting after (s)', type: 'number', default: 20, advanced: true, half: true });
  out.push({
    key: 'notes',
    label: 'Notes',
    type: 'textarea',
    placeholder: 'What it is, who to ask, where the password lives…',
    advanced: true,
    help: 'Shown on its card.',
  });
  return out;
}

/** A kind with the sections its engine takes. */
export function withSections(k: Kind): Kind {
  const fields = [...k.fields, ...options(k)];
  if (k.engine === 'postgres' || k.engine === 'mysql')
    fields.push({ ...SQL_INIT, placeholder: k.engine === 'mysql' ? "SET time_zone = '+00:00';" : SQL_INIT.placeholder });
  if (TLS_ENGINES.includes(k.engine)) fields.push(...TLS_FIELDS, ...(k.engine === 'redis' ? [REDIS_TLS] : []));
  if (SSH_ENGINES.includes(k.engine)) fields.push(...SSH_FIELDS);
  return { ...k, fields };
}
