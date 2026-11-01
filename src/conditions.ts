/**
 * Condition evaluators. Each poll returns pending/done/fail/exited plus an optional
 * changeKey (stall source) and a one-line summary for the human output.
 */
import { createHash } from "node:crypto";
import { formatBytes } from "./duration.js";
import { parseDuration } from "./duration.js";
import { LogTailer, matcherLength, matcherTest, matcherToString, scanLines } from "./tail.js";
import {
  SpecError,
  type Condition,
  type LogCondition,
  type Matcher,
  type ProcessCondition,
  type Transport,
} from "./types.js";

export type EvalState = "pending" | "done" | "fail" | "exited";

export interface EvalResult {
  state: EvalState;
  matched?: string;
  changeKey?: string;
  summary?: string;
}

export interface Evaluator {
  readonly kind: string;
  readonly hasChangeKey: boolean;
  evaluate(): Promise<EvalResult>;
  /** Called once at timeout/stall so an unterminated last line can still match. */
  finalCheck?(): EvalResult | undefined;
  describe(): string;
}

export interface CompileOptions {
  now?: () => number;
  execTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const sha = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 16);
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function compile(c: Condition, t: Transport, opts: CompileOptions = {}): Evaluator {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const execOpts = opts.execTimeoutMs !== undefined ? { timeoutMs: opts.execTimeoutMs } : {};
  switch (c.kind) {
    case "log":
      return logEvaluator(c, t);
    case "exitFile":
      return {
        kind: "exitFile",
        hasChangeKey: false,
        describe: () => `exit file ${c.path}`,
        evaluate: async () => readExitFile(t, c.path, `exit file ${c.path}`),
      };
    case "process":
      return processEvaluator(c, t, sleep);
    case "port":
      return {
        kind: "port",
        hasChangeKey: false,
        describe: () => `port ${c.host ?? "127.0.0.1"}:${c.port} ${c.closed ? "closed" : "open"}`,
        evaluate: async () => {
          const open = await t.portOpen(c.port, c.host);
          const want = !c.closed;
          return open === want
            ? { state: "done", matched: `port ${c.port} ${open ? "open" : "closed"}` }
            : { state: "pending", summary: `port ${c.port} ${open ? "open" : "closed"}` };
        },
      };
    case "http":
      return httpEvaluator(c);
    case "file": {
      const stableFor = parseDuration(c.stableFor, "file.stableFor");
      let stableSince: number | undefined;
      let lastKey: string | undefined;
      return {
        kind: "file",
        hasChangeKey: true,
        describe: () => `file ${c.path}${c.exists === false ? " gone" : ""}${stableFor ? ` stable ${stableFor}ms` : ""}`,
        evaluate: async () => {
          const st = await t.stat(c.path);
          const wantExists = c.exists !== false;
          if (!st.exists) {
            return wantExists
              ? { state: "pending", summary: "file missing", changeKey: "missing" }
              : { state: "done", matched: `${c.path} gone`, changeKey: "missing" };
          }
          if (!wantExists) return { state: "pending", summary: `file present (${formatBytes(st.size)})`, changeKey: `${st.size}:${st.mtimeMs}` };
          const key = `${st.size}:${st.mtimeMs}`;
          const summary = `${formatBytes(st.size)}`;
          if (c.minBytes !== undefined && st.size < c.minBytes) {
            return { state: "pending", summary: `${summary} < ${formatBytes(c.minBytes)}`, changeKey: key };
          }
          if (stableFor === undefined) return { state: "done", matched: `${c.path} ${summary}`, changeKey: key };
          const tNow = now();
          if (key !== lastKey) {
            lastKey = key;
            stableSince = tNow;
          }
          const stableMs = tNow - (stableSince ?? tNow);
          if (stableMs >= stableFor) return { state: "done", matched: `${c.path} ${summary} stable`, changeKey: key };
          return { state: "pending", summary: `${summary}, stable ${Math.round(stableMs / 1000)}s`, changeKey: key };
        },
      };
    }
    case "command": {
      const failFrom = c.failFrom ?? 100;
      return {
        kind: "command",
        hasChangeKey: true,
        describe: () => `command ${c.cmd}`,
        evaluate: async () => {
          const r = await t.exec(c.cmd, execOpts);
          const last = r.stdout.trim().split("\n").pop() ?? "";
          const key = sha(r.stdout);
          if (r.code === 0) return { state: "done", matched: last || `exit 0`, changeKey: key };
          if (r.code >= failFrom) return { state: "fail", matched: `exit ${r.code}${last ? `: ${last}` : ""}`, changeKey: key };
          return { state: "pending", summary: `exit ${r.code}${last ? ` · ${last}` : ""}`, changeKey: key };
        },
      };
    }
    case "all":
    case "any":
      return comboEvaluator(c.kind, c.conditions.map((x) => compile(x, t, opts)));
  }
}

/** The stall rule: `stall` needs at least one change source (Plan v2.1 "Stall sources"). */
export function hasStallSource(c: Condition): boolean {
  switch (c.kind) {
    case "log":
    case "file":
    case "http":
    case "command":
      return true;
    case "all":
    case "any":
      return c.conditions.some(hasStallSource);
    default:
      return false;
  }
}

export function describeCondition(c: Condition): string {
  switch (c.kind) {
    case "log":
      return `log ${c.path}${c.done !== undefined ? ` done=${matcherToString(c.done)}` : ""}${c.fail !== undefined ? ` fail=${matcherToString(c.fail)}` : ""}`;
    case "exitFile":
      return `exit file ${c.path}`;
    case "process":
      return `process ${c.pid ?? c.pattern}${c.exitFile ? ` + ${c.exitFile}` : ""}`;
    case "port":
      return `port ${c.port}`;
    case "http":
      return `http ${c.url}`;
    case "file":
      return `file ${c.path}`;
    case "command":
      return `command ${c.cmd}`;
    case "all":
    case "any":
      return `${c.kind}(${c.conditions.map(describeCondition).join(", ")})`;
  }
}

// ---------------------------------------------------------------------------

function logEvaluator(c: LogCondition, t: Transport): Evaluator {
  if (c.done === undefined && c.fail === undefined) throw new SpecError(`log ${c.path}: done or fail marker required`);
  const floor = Math.max(matcherLength(c.done), matcherLength(c.fail)) - 1;
  const tailer = new LogTailer(t, c.path, { carryFloor: Math.max(0, floor), ...(c.fromStart !== undefined ? { fromStart: c.fromStart } : {}) });
  let lastSize = 0;
  return {
    kind: "log",
    hasChangeKey: true,
    describe: () => describeCondition(c),
    evaluate: async () => {
      const p = await tailer.poll();
      lastSize = p.size;
      const key = p.exists ? String(p.size) : "missing";
      if (!p.exists) return { state: "pending", summary: "log not yet created", changeKey: key };
      const lines = p.stablePartial !== undefined ? [...p.lines, p.stablePartial] : p.lines;
      const hit = scanLines(lines, c.done, c.fail);
      if (hit) return { state: hit.state, matched: hit.line, changeKey: key };
      const last = (p.lastLine ?? "").slice(0, 100);
      return { state: "pending", summary: `${formatBytes(p.size)}${last ? ` · ${last}` : ""}`, changeKey: key };
    },
    finalCheck: () => {
      const rest = tailer.partial();
      if (rest === undefined) return undefined;
      const hit = scanLines([rest], c.done, c.fail);
      return hit ? { state: hit.state, matched: hit.line, changeKey: String(lastSize) } : undefined;
    },
  };
}

async function readExitFile(t: Transport, path: string, label: string): Promise<EvalResult> {
  const content = await readSmall(t, path);
  if (content === undefined) return { state: "pending", summary: `${label} absent` };
  const v = content.trim();
  if (v === "") return { state: "pending", summary: `${label} empty` };
  if (!/^-?\d+$/.test(v)) return { state: "fail", matched: `${label} unparseable: ${v.slice(0, 40)}` };
  return Number(v) === 0 ? { state: "done", matched: `rc=0` } : { state: "fail", matched: `rc=${v}` };
}

async function readSmall(t: Transport, path: string): Promise<string | undefined> {
  const r = await t.exec(`if [ -f ${quote(path)} ]; then cat ${quote(path)}; else printf '__RD_ABSENT'; fi`);
  return r.stdout === "__RD_ABSENT" ? undefined : r.stdout;
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function processEvaluator(c: ProcessCondition, t: Transport, sleep: (ms: number) => Promise<void>): Evaluator {
  if (c.pid === undefined && c.pattern === undefined) throw new SpecError("process: pid or pattern required");
  const sel = c.pid !== undefined ? { pid: c.pid } : { pattern: c.pattern as string };
  const who = c.pid !== undefined ? `pid ${c.pid}` : `pattern ${c.pattern}`;
  return {
    kind: "process",
    hasChangeKey: false,
    describe: () => describeCondition(c),
    evaluate: async () => {
      if (await t.processAlive(sel)) return { state: "pending", summary: `${who} alive` };
      if (c.exitFile === undefined) return { state: "exited", matched: `${who} gone` };
      let r = await readExitFile(t, c.exitFile, `rc file`);
      if (r.state === "pending") {
        // the writer may be a hair behind the process exit
        await sleep(1000);
        r = await readExitFile(t, c.exitFile, `rc file`);
      }
      if (r.state === "pending") return { state: "fail", matched: `${who} gone and ${c.exitFile} absent (crashed before writing the exit code)` };
      return r;
    },
  };
}

function httpEvaluator(c: Extract<Condition, { kind: "http" }>): Evaluator {
  if (c.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return {
    kind: "http",
    hasChangeKey: true,
    describe: () => describeCondition(c),
    evaluate: async () => {
      let res: Response;
      try {
        res = await fetch(c.url, { method: c.method ?? "GET", signal: AbortSignal.timeout(10_000), redirect: "follow" });
      } catch (e) {
        return { state: "pending", summary: `http: ${(e as Error).message}`, changeKey: "unreachable" };
      }
      const body = await res.text();
      const key = `${res.status}:${sha(body)}`;
      const okStatus = c.status ? c.status.includes(res.status) : res.status >= 200 && res.status < 300;
      if (c.failMatch !== undefined && matcherTest(c.failMatch, body)) {
        return { state: "fail", matched: `http ${res.status} body matches ${matcherToString(c.failMatch)}`, changeKey: key };
      }
      if (!okStatus) return { state: "pending", summary: `http ${res.status}`, changeKey: key };
      if (c.bodyMatch !== undefined && !matcherTest(c.bodyMatch, body)) {
        return { state: "pending", summary: `http ${res.status}, body not matching yet`, changeKey: key };
      }
      return { state: "done", matched: `http ${res.status}`, changeKey: key };
    },
  };
}

function comboEvaluator(kind: "all" | "any", children: Evaluator[]): Evaluator {
  if (children.length === 0) throw new SpecError(`${kind}: at least one condition required`);
  const evalAll = async (): Promise<EvalResult[]> => {
    const out: EvalResult[] = [];
    for (const ch of children) out.push(await ch.evaluate());
    return out;
  };
  const merge = (results: EvalResult[]): EvalResult => {
    const keys = results.map((r) => r.changeKey ?? "").join("|");
    const summary = results
      .map((r, i) => `${children[i]?.kind}:${r.state === "pending" ? r.summary ?? "pending" : r.state}`)
      .join(" ");
    const fail = results.find((r) => r.state === "fail");
    if (fail) return { state: "fail", ...(fail.matched !== undefined ? { matched: fail.matched } : {}), changeKey: keys };
    const dones = results.filter((r) => r.state === "done");
    const exited = results.filter((r) => r.state === "exited");
    const settled = dones.length + exited.length === results.length;
    if (kind === "all" && settled && dones.length > 0) {
      // "process gone" counts as satisfied once every other child is done (DONE line + process exit)
      return { state: "done", matched: dones.map((d) => d.matched).filter(Boolean).join("; "), changeKey: keys };
    }
    if (kind === "any" && dones.length > 0) {
      const d = dones[0] as EvalResult;
      return { state: "done", ...(d.matched !== undefined ? { matched: d.matched } : {}), changeKey: keys };
    }
    if (exited.length > 0 && (kind === "all" || settled)) {
      const e = exited[0] as EvalResult;
      return { state: "exited", ...(e.matched !== undefined ? { matched: e.matched } : {}), changeKey: keys };
    }
    return { state: "pending", summary, changeKey: keys };
  };
  return {
    kind,
    hasChangeKey: children.some((ch) => ch.hasChangeKey),
    describe: () => `${kind}(${children.map((ch) => ch.describe()).join(", ")})`,
    evaluate: async () => {
      let results = await evalAll();
      // A process may vanish between two child reads while its final log line was written in
      // between: give the still-pending children one immediate re-read before concluding "exited".
      if (results.some((r) => r.state === "exited") && results.some((r) => r.state === "pending")) {
        results = await Promise.all(results.map((r, i) => (r.state === "pending" ? (children[i] as Evaluator).evaluate() : r)));
      }
      return merge(results);
    },
    finalCheck: () => {
      const results = children.map((ch) => ch.finalCheck?.());
      const hit = results.find((r) => r && (r.state === "done" || r.state === "fail"));
      return hit ?? undefined;
    },
  };
}

export type { Matcher };
