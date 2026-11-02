/**
 * Hook runner. Shell hooks run as `sh -c` with stdin=/dev/null (an ssh inside a hook cannot
 * swallow the engine's stdin), the context in RD_* env vars and a JSON file (RD_CTX_FILE),
 * stdout/stderr captured (last 4 KiB). Only the engine ever writes to the process stdout.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailText } from "./shell.js";
import type { Hook, HookContext, HookResult } from "./types.js";

const running = new Set<ChildProcess>();

function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

// a second Ctrl-C exits at once: take any still-running hook down with us
process.on("exit", () => {
  for (const ch of running) killGroup(ch, "SIGTERM");
});

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
    RD_PID: String(process.pid),
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
      // Own process group: on timeout the whole group is killed, so a `sh -c` that did not
      // exec its child (dash) cannot leave an orphan holding our pipes open.
      const child = spawn("sh", ["-c", hook], { stdio: ["ignore", "pipe", "pipe"], env, detached: true });
      running.add(child);
      child.stdout?.on("data", (d: Buffer) => chunks.push(d));
      child.stderr?.on("data", (d: Buffer) => chunks.push(d));
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, "SIGTERM");
        setTimeout(() => killGroup(child, "SIGKILL"), 5000).unref();
      }, opts.timeoutMs);
      let settled = false;
      const done = (exitCode: number | null, error?: string) => {
        if (settled) return;
        settled = true;
        running.delete(child);
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
      const finish = (code: number | null, signal: NodeJS.Signals | null) =>
        done(code ?? (signal ? 128 : null), signal ? `killed by ${signal}` : undefined);
      child.on("close", finish);
      // if a grandchild keeps the pipes open, do not wait for it beyond a short grace
      child.on("exit", (code, signal) => setTimeout(() => finish(code, signal), 1000).unref());
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
