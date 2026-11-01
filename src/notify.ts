/**
 * `notify` entries run for every terminal state:
 *   ntfy://ntfy.sh/topic      -> POST https://ntfy.sh/topic (ntfy headers)
 *   ntfy+http://host/topic    -> same over plain http
 *   https://... / http://...  -> POST JSON (webhook)
 *   anything else             -> shell command (same contract as hooks)
 */
import { formatMs } from "./duration.js";
import { runHook } from "./hooks.js";
import type { HookContext, HookResult } from "./types.js";

export function summaryLine(ctx: HookContext): string {
  const parts = [`remote-done ${ctx.status}`, `target ${ctx.target}`, `after ${formatMs(ctx.elapsedMs)}`];
  if (ctx.matched) parts.push(`matched: ${ctx.matched}`);
  if (ctx.fetched.length) parts.push(`fetched ${ctx.fetched.length} file(s)`);
  if (!ctx.fetchOk) parts.push(`FETCH FAILED`);
  if (ctx.error) parts.push(ctx.error);
  return parts.join(" · ");
}

export async function runNotify(entry: string, ctx: HookContext, timeoutMs: number): Promise<HookResult> {
  const started = Date.now();
  const base = { phase: "notify" as const, name: entry };
  const m = /^(ntfy|ntfy\+http|ntfy\+https):\/\/(.+)$/.exec(entry);
  try {
    if (m) {
      const scheme = m[1] === "ntfy+http" ? "http" : "https";
      const url = `${scheme}://${m[2]}`;
      const res = await fetch(url, {
        method: "POST",
        body: summaryLine(ctx),
        headers: {
          Title: `remote-done: ${ctx.status}`,
          Tags: ctx.status === "done" && ctx.fetchOk ? "white_check_mark" : "warning",
          Priority: ctx.status === "done" ? "default" : "high",
        },
        signal: AbortSignal.timeout(Math.min(timeoutMs, 30_000)),
      });
      return { ...base, exitCode: res.ok ? 0 : 1, ms: Date.now() - started, ...(res.ok ? {} : { error: `ntfy ${res.status}` }) };
    }
    if (/^https?:\/\//.test(entry)) {
      const res = await fetch(entry, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: summaryLine(ctx), ...ctx }),
        signal: AbortSignal.timeout(Math.min(timeoutMs, 30_000)),
      });
      return { ...base, exitCode: res.ok ? 0 : 1, ms: Date.now() - started, ...(res.ok ? {} : { error: `webhook ${res.status}` }) };
    }
  } catch (e) {
    return { ...base, exitCode: 1, ms: Date.now() - started, error: (e as Error).message };
  }
  return runHook(entry, ctx, { timeoutMs });
}
