// Figures as the queue pages show them: a count with its noun, a span of
// time in its largest units, bytes in KB and MB.

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** ms as "7 days", "36 hours", "90 seconds". */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return String(ms);
  const s = ms / 1000;
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ];
  for (const [size, unit] of units) if (s >= size && s % size === 0) return plural(s / size, unit);
  for (const [size, unit] of units) if (s >= size * 2) return plural(Math.round(s / size), unit);
  return s >= 1 ? plural(Math.round(s), 'second') : `${ms} ms`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
