import { spawn } from "node:child_process";
import {
  catOrAbsentScript,
  listGlobScript,
  parseStatOutput,
  parseTailOutput,
  portOpenScript,
  processAliveScript,
  statScript,
  tailScript,
  totalBytesScript,
} from "../recipes.js";
import type {
  ExecOptions,
  ExecResult,
  RawExecResult,
  StatResult,
  TailResult,
  Transport,
} from "../types.js";

export interface SpawnCapture {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
}

/** Spawn with stdin=/dev/null, stdout as a Buffer, stderr as text, and a hard timeout (TERM, then KILL). */
export function spawnCapture(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<SpawnCapture> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const spawnOpts: Parameters<typeof spawn>[2] = { stdio: ["ignore", "pipe", "pipe"] };
    if (opts.env) spawnOpts.env = opts.env;
    if (opts.cwd) spawnOpts.cwd = opts.cwd;
    const child = spawn(cmd, args, spawnOpts);
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    let killTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      }, opts.timeoutMs);
    }
    const finish = (r: Omit<SpawnCapture, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ ...r, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    };
    child.on("error", (e: NodeJS.ErrnoException) => finish({ code: null, signal: null, spawnError: e }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

/**
 * Shared implementation for transports that run POSIX sh recipes. Subclasses provide
 * `runScript` (local `sh -c` or ssh with the sentinel) and `fetch`.
 */
export abstract class ShellTransport implements Transport {
  abstract readonly kind: "local" | "ssh";
  abstract readonly label: string;
  defaultTimeoutMs = 120_000;

  protected abstract runScript(script: string, opts: Required<ExecOptions>): Promise<RawExecResult>;
  abstract fetch(from: string, toDir: string, via?: "scp" | "rsync"): Promise<string[]>;

  async execRaw(cmd: string, opts: ExecOptions = {}): Promise<RawExecResult> {
    return this.runScript(cmd, { timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs });
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const r = await this.execRaw(cmd, opts);
    return { code: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr, sentinel: r.sentinel };
  }

  async readTail(path: string, fromByte: number, maxBytes: number): Promise<TailResult> {
    const r = await this.execRaw(tailScript(path, fromByte, maxBytes));
    if (r.code !== 0) throw new Error(`tail recipe failed (exit ${r.code}) on ${this.label}: ${r.stderr.trim()}`);
    return parseTailOutput(r.stdout);
  }

  async stat(path: string): Promise<StatResult> {
    const r = await this.exec(statScript(path));
    if (r.code !== 0) throw new Error(`stat recipe failed (exit ${r.code}) on ${this.label}: ${r.stderr.trim()}`);
    return parseStatOutput(r.stdout);
  }

  async processAlive(sel: { pid?: number; pattern?: string }): Promise<boolean> {
    const r = await this.exec(processAliveScript(sel));
    return r.code === 0;
  }

  async portOpen(port: number, host?: string): Promise<boolean> {
    const r = await this.exec(portOpenScript(port, host));
    return r.code === 0;
  }

  async listGlob(glob: string): Promise<string[]> {
    const r = await this.exec(listGlobScript(glob));
    if (r.code !== 0) throw new Error(`glob listing failed (exit ${r.code}) on ${this.label}: ${r.stderr.trim()}`);
    return r.stdout.split("\n").filter((l) => l.length > 0);
  }

  async totalBytes(glob: string): Promise<number | undefined> {
    const r = await this.exec(totalBytesScript(glob));
    const t = r.stdout.trim();
    if (t === "") return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }

  /** Content of a small file, or undefined when absent. */
  async readSmallFile(path: string): Promise<string | undefined> {
    const r = await this.exec(catOrAbsentScript(path));
    if (r.stdout === "__RD_ABSENT") return undefined;
    return r.stdout;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
