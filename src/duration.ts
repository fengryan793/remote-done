import { SpecError, type Duration } from "./types.js";

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Numbers are milliseconds. Strings: "90" (bare = seconds), "90s", "1500ms", "15m", "2h", "1h30m", "1.5h".
 */
export function parseDuration(v: Duration | undefined, name = "duration"): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) throw new SpecError(`${name}: invalid number ${v}`);
    return v;
  }
  const s = v.trim().toLowerCase();
  if (s === "") throw new SpecError(`${name}: empty duration`);
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let total = 0;
  let consumed = 0;
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * (UNIT_MS[m[2] as string] as number);
    consumed += m[0].length;
  }
  if (consumed !== s.length) {
    throw new SpecError(`${name}: cannot parse "${v}" (use e.g. 90s, 15m, 2h, 1h30m)`);
  }
  return Math.round(total);
}

export function requireDuration(v: Duration | undefined, name: string, fallback: number): number {
  return parseDuration(v, name) ?? fallback;
}

/** 754321 -> "12m34s" */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m${String(sec).padStart(2, "0")}s`;
  if (m > 0) return `${m}m${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
