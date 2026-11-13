// DynamoDB's attribute values and plain JSON, both ways: {"S": "a"} is
// "a", {"N": "12"} is 12 (or "12" when it's past a double's integers),
// {"M": …} an object, {"L": …} an array, sets arrays, binary its base64 as
// {"$binary": …}. What goes back is the plain JSON a window edited.

import { PluginError } from '@hyperpane/sdk/server';

export type AttributeValue =
  | { S: string }
  | { N: string }
  | { B: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { M: Record<string, AttributeValue> }
  | { L: AttributeValue[] }
  | { SS: string[] }
  | { NS: string[] }
  | { BS: string[] };

export type Item = Record<string, AttributeValue>;

function number(n: string): number | string {
  const v = Number(n);
  return Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)) && (String(v) === n || !/^-?\d+$/.test(n)) ? v : n;
}

export function unmarshallValue(a: AttributeValue): unknown {
  if ('S' in a) return a.S;
  if ('N' in a) return number(a.N);
  if ('BOOL' in a) return a.BOOL;
  if ('NULL' in a) return null;
  if ('M' in a) return unmarshall(a.M);
  if ('L' in a) return a.L.map(unmarshallValue);
  if ('SS' in a) return [...a.SS];
  if ('NS' in a) return a.NS.map(number);
  if ('B' in a) return { $binary: a.B };
  if ('BS' in a) return a.BS.map((b) => ({ $binary: b }));
  return null;
}

export const unmarshall = (item: Item): Record<string, unknown> => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, unmarshallValue(v)]));

export function marshallValue(v: unknown, path = 'value'): AttributeValue {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === 'string') return { S: v };
  if (typeof v === 'boolean') return { BOOL: v };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new PluginError(`${path}: DynamoDB has no ${v}.`);
    return { N: String(v) };
  }
  if (typeof v === 'bigint') return { N: v.toString() };
  if (Array.isArray(v)) return { L: v.map((x, i) => marshallValue(x, `${path}[${i}]`)) };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o.$binary === 'string') return { B: o.$binary };
    // Big numbers as typed in relaxed JSON.
    if (keys.length === 1 && typeof o.$numberLong === 'string') return { N: o.$numberLong };
    return { M: marshall(o, path) };
  }
  throw new PluginError(`${path}: ${typeof v} can’t be stored.`);
}

export function marshall(o: Record<string, unknown>, path = ''): Item {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, marshallValue(v, path ? `${path}.${k}` : k)]));
}
