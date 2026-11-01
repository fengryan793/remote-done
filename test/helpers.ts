import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport } from "../src/transport/local.js";
import type { ExecOptions, RawExecResult } from "../src/types.js";

export function tmp(prefix = "rd-test-"): { dir: string; path: (n: string) => string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, path: (n) => join(dir, n), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A LocalTransport whose next calls can be made to throw (transport errors, host-key errors...)
 * or to drop the sentinel. Every operation funnels through execRaw, so one hook covers all.
 */
export class FakeTransport extends LocalTransport {
  override readonly label = "fake@host:22";
  queue: Array<Error | { sentinelLost: true }> = [];
  calls: string[] = [];

  failNext(err: Error, times = 1): void {
    for (let i = 0; i < times; i++) this.queue.push(err);
  }

  loseSentinelNext(): void {
    this.queue.push({ sentinelLost: true });
  }

  override async execRaw(cmd: string, opts: ExecOptions = {}): Promise<RawExecResult> {
    this.calls.push(cmd);
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    const r = await super.execRaw(cmd, opts);
    if (next && "sentinelLost" in next) return { ...r, code: 255, sentinel: false };
    return r;
  }
}

/** Virtual clock: `sleep` advances `now` instead of waiting. */
export function virtualClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      await new Promise((r) => setImmediate(r));
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
