import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { shq } from "../shell.js";
import { FetchFailure, TransportError, type ExecOptions, type RawExecResult } from "../types.js";
import { ShellTransport, spawnCapture } from "./base.js";

/** Runs the recipes through the local `sh`; fetch is a plain copy. */
export class LocalTransport extends ShellTransport {
  readonly kind = "local" as const;
  readonly label: string = "local";

  protected async runScript(script: string, opts: Required<ExecOptions>): Promise<RawExecResult> {
    const r = await spawnCapture("sh", ["-c", script], { timeoutMs: opts.timeoutMs });
    if (r.spawnError) throw new Error(`cannot spawn sh: ${r.spawnError.message}`);
    if (r.timedOut) throw new TransportError(`local command timed out after ${opts.timeoutMs} ms`, "timeout");
    return { code: r.code ?? 128 + signalNumber(r.signal), stdout: r.stdout, stderr: r.stderr, sentinel: true };
  }

  async fetch(from: string, toDir: string): Promise<string[]> {
    const files = await this.listGlob(from);
    if (files.length === 0) throw new FetchFailure(`no file matches ${from} (local)`);
    const dir = resolve(toDir);
    mkdirSync(dir, { recursive: true });
    const r = await this.exec(`cp -R ${files.map(shq).join(" ")} ${shq(dir + "/")}`);
    if (r.code !== 0) throw new FetchFailure(`cp failed (exit ${r.code}): ${r.stderr.trim()}`);
    return files.map((f) => join(dir, basename(f)));
  }
}

function signalNumber(sig: NodeJS.Signals | null): number {
  switch (sig) {
    case "SIGHUP":
      return 1;
    case "SIGINT":
      return 2;
    case "SIGKILL":
      return 9;
    case "SIGTERM":
      return 15;
    default:
      return 0;
  }
}
