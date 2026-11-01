/** Single-quote a string for POSIX sh. */
export function shq(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function shqAll(parts: string[]): string {
  return parts.map(shq).join(" ");
}

/** Keep the last `max` bytes of a string (used for captured hook output). */
export function tailText(s: string, max = 4096): string {
  if (Buffer.byteLength(s) <= max) return s;
  const b = Buffer.from(s);
  return b.subarray(b.length - max).toString();
}
