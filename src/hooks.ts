/**
 * Hook runner. Shell hooks run as `sh -c` with stdin=/dev/null (an ssh inside a hook cannot
 * swallow the engine's stdin), the context in RD_* env vars and a JSON file (RD_CTX_FILE),
 * stdout/stderr captured (last 4 KiB). Only the engine ever writes to the process stdout.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailText } from "./shell.js";
import type { Hook, HookContext, HookResult } from "./types.js";

export interface HookRunOptions {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export function hookName(h: Hook): string {
  return typeof h === "string" ? h : h.name || "<function>";
}

export function hookEnv(ctx: HookContext): NodeJS.ProcessEnv {
  return {
    RD_ID: ctx.id,
    RD_PHASE: ctx.phase,
    RD_STATUS: ctx.status,
    RD_TARGET: ctx.target,
    RD_MATCH: ctx.matched ?? "",
    RD_FETCHED: ctx.fetched.join("\n"),
    RD_FETCH_OK: ctx.fetchOk ? "1" : "0",
    RD_ELAPSED_MS: String(Math.round(ctx.elapsedMs)),
    RD_STARTED_AT: ctx.startedAt,
    RD_SIGNAL: ctx.signal ?? "",
    RD_ERROR: ctx.error ?? "",
  };
}

export async function runHook(hook: Hook, ctx: HookContext, opts: HookRunOptions): Promise<HookResult> {
  const name = hookName(hook);
  const started = Date.now();
  if (typeof hook === "function") {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve(hook(ctx)),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("hook timed out")), opts.timeoutMs);
        }),
      ]);
      return { phase: ctx.phase, name, exitCode: 0, ms: Date.now() - started };
    } catch (e) {
      const msg = (e as Error).message;
      return {
        phase: ctx.phase,
        name,
        exitCode: 1,
        ms: Date.now() - started,
        error: msg,
        ...(msg === "hook timed out" ? { timedOut: true } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "remote-done-"));
  const ctxFile = join(dir, "ctx.json");
  writeFileSync(ctxFile, JSON.stringify(ctx, null, 2));
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env, ...hookEnv(ctx), RD_CTX_FILE: ctxFile };
  try {
    return await new Promise<HookResult>((resolve) => {
      const chunks: Buffer[] = [];
      let timedOut = false;
      const child = spawn("sh", ["-c", hook], { stdio: ["ignore", "pipe", "pipe"], env });
      child.stdout?.on("data", (d: Buffer) => chunks.push(d));
      child.stderr?.on("data", (d: Buffer) => chunks.push(d));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, opts.timeoutMs);
      const done = (exitCode: number | null, error?: string) => {
        clearTimeout(timer);
        const output = tailText(Buffer.concat(chunks).toString("utf8"));
        resolve({
          phase: ctx.phase,
          name,
          exitCode,
          ms: Date.now() - started,
          ...(timedOut ? { timedOut: true } : {}),
          ...(output ? { output } : {}),
          ...(error ? { error } : {}),
        });
      };
      child.on("error", (e) => done(null, e.message));
      child.on("close", (code, signal) => done(code ?? (signal ? 128 : null), signal ? `killed by ${signal}` : undefined));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
