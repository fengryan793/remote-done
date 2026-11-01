export * from "./types.js";
export { remoteDone, watch, normalizeSpec, createTransport, exitCodeFor, statusIn, DEFAULTS } from "./engine.js";
export type { NormalizedSpec, RunOptions } from "./engine.js";
export { startDetached, runCondition } from "./run.js";
export type { Started, StartOptions } from "./run.js";
export { parseDuration, formatMs, formatBytes } from "./duration.js";
export { LogTailer } from "./tail.js";
export { LocalTransport } from "./transport/local.js";
export { SshTransport, classifySshFailure, parseSentinel, sshCommonOptions } from "./transport/ssh.js";
export { compile as compileCondition, describeCondition, hasStallSource } from "./conditions.js";
export type { Evaluator, EvalResult } from "./conditions.js";
export { runHook } from "./hooks.js";
export { shq } from "./shell.js";

import type {
  AllCondition,
  AnyCondition,
  CommandCondition,
  Condition,
  ExitFileCondition,
  FileCondition,
  HttpCondition,
  LocalTarget,
  LogCondition,
  PortCondition,
  ProcessCondition,
  SshTarget,
} from "./types.js";

/** Condition builders: `c.log("/tmp/x.log", { done: /DONE/ })`. */
export const conditions = {
  log: (path: string, o: Omit<LogCondition, "kind" | "path">): LogCondition => ({ kind: "log", path, ...o }),
  exitFile: (path: string): ExitFileCondition => ({ kind: "exitFile", path }),
  process: (o: Omit<ProcessCondition, "kind">): ProcessCondition => ({ kind: "process", ...o }),
  port: (port: number, o: Omit<PortCondition, "kind" | "port"> = {}): PortCondition => ({ kind: "port", port, ...o }),
  http: (url: string, o: Omit<HttpCondition, "kind" | "url"> = {}): HttpCondition => ({ kind: "http", url, ...o }),
  file: (path: string, o: Omit<FileCondition, "kind" | "path"> = {}): FileCondition => ({ kind: "file", path, ...o }),
  command: (cmd: string, o: Omit<CommandCondition, "kind" | "cmd"> = {}): CommandCondition => ({ kind: "command", cmd, ...o }),
  all: (...conditions: Condition[]): AllCondition => ({ kind: "all", conditions }),
  any: (...conditions: Condition[]): AnyCondition => ({ kind: "any", conditions }),
};

/** `ssh("root@1.2.3.4", { port: 22011 })` or `ssh("root@1.2.3.4:22011")`. */
export function ssh(dest: string, o: Omit<SshTarget, "kind" | "host" | "user"> & { user?: string } = {}): SshTarget {
  const parsed = parseSshDestination(dest);
  const t: SshTarget = { kind: "ssh", host: parsed.host, ...o };
  if (parsed.user && t.user === undefined) t.user = parsed.user;
  if (parsed.port !== undefined && t.port === undefined) t.port = parsed.port;
  return t;
}

export function local(): LocalTarget {
  return { kind: "local" };
}

/** Accepts `host`, `user@host`, `user@host:port`, `ssh://user@host:port`, `[v6::1]:port`. */
export function parseSshDestination(dest: string): { host: string; user?: string; port?: number } {
  let s = dest.trim().replace(/^ssh:\/\//, "");
  let user: string | undefined;
  const at = s.lastIndexOf("@");
  if (at !== -1) {
    user = s.slice(0, at);
    s = s.slice(at + 1);
  }
  let host = s;
  let port: number | undefined;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) {
    host = v6[1] as string;
    if (v6[2]) port = Number(v6[2]);
  } else if ((s.match(/:/g) ?? []).length === 1) {
    const [h, p] = s.split(":");
    host = h as string;
    if (p && /^\d+$/.test(p)) port = Number(p);
    else host = s;
  }
  return { host, ...(user ? { user } : {}), ...(port !== undefined ? { port } : {}) };
}
