/**
 * The poll loop and the terminal pipeline (fetch -> hooks -> teardown -> notify).
 * Precedence while waiting: timeout > unreachableAfter > stall > condition result.
 */
import { compile, hasStallSource, type Evaluator } from "./conditions.js";
import { formatMs, parseDuration } from "./duration.js";
import { hookName, runHook } from "./hooks.js";
import { runNotify } from "./notify.js";
import { deadmanArmScript, killScript } from "./recipes.js";
import { finishState, newRunId, pruneOld, writeState } from "./state.js";
import { LocalTransport } from "./transport/local.js";
import { SshTransport } from "./transport/ssh.js";
import {
  AuthError,
  EXIT_CODES,
  FetchFailure,
  HostKeyError,
  SIGNAL_NUMBERS,
  SpecError,
  TransportError,
  type Condition,
  type Event,
  type FetchError,
  type FetchSpec,
  type Hook,
  type HookContext,
  type HookPhase,
  type HookResult,
  type Result,
  type Spec,
  type Status,
  type StatusSelector,
  type Target,
  type Transport,
} from "./types.js";

export interface NormalizedSpec {
  target: Target;
  until: Condition;
  intervalMs: number;
  timeoutMs?: number;
  stallMs?: number;
  progressLog?: string;
  unreachableAfterMs: number;
  keepGoing: boolean;
  fetch: FetchSpec[];
  fetchOn: StatusSelector[];
  teardown: Hook[];
  teardownOn: StatusSelector[];
  forceTeardown: boolean;
  forceTeardownAfterMin?: number;
  hooks: Partial<Record<Exclude<HookPhase, "teardown" | "notify">, Hook[]>>;
  notify: string[];
  hookTimeoutMs: number;
  execTimeoutMs: number;
  id: string;
  deadman?: string;
  deadmanGraceMs: number;
  idempotencyCheck?: string;
  signal?: AbortSignal;
}

export const DEFAULTS = {
  intervalMs: 15_000,
  unreachableAfterMs: 10 * 60_000,
  hookTimeoutMs: 10 * 60_000,
  execTimeoutMs: 2 * 60_000,
  deadmanGraceMs: 10 * 60_000,
  fetchOn: ["done", "fail", "timeout"] as StatusSelector[],
  teardownOn: ["done"] as StatusSelector[],
  reconnectMinMs: 3_000,
  reconnectMaxMs: 60_000,
  fetchAttempts: 5,
  fetchReadyTimeoutMs: 5 * 60_000,
};

const VALID_SELECTORS = new Set<string>(["all", "done", "fail", "timeout", "unreachable", "stalled", "aborted", "exited", "hostKeyChanged"]);

function selectors(v: StatusSelector[] | undefined, name: string, fallback: StatusSelector[]): StatusSelector[] {
  if (v === undefined) return fallback;
  for (const s of v) if (!VALID_SELECTORS.has(s)) throw new SpecError(`${name}: unknown status "${s}"`);
  return v;
}

export function normalizeSpec(spec: Spec): NormalizedSpec {
  if (!spec || typeof spec !== "object" || !spec.until) throw new SpecError("spec.until is required");
  const target: Target = spec.target ?? { kind: "local" };
  if (target.kind === "ssh" && !target.host) throw new SpecError("ssh target needs a host");
  if (target.kind === "ssh" && /(^|\.)ssh\.runpod\.io$/.test(target.host)) {
    throw new SpecError(
      "ssh.runpod.io is RunPod's basic proxy: it has no SCP/SFTP and no stable shell. Use the pod's public IP + exposed 22/tcp (\"Full SSH\") instead.",
    );
  }
  const stallMs = parseDuration(spec.stall, "stall");
  if (stallMs !== undefined && !hasStallSource(spec.until) && !spec.progressLog) {
    throw new SpecError("stall: no change source - use a log/file/http/command condition or --progress-log PATH");
  }
  const timeoutMs = parseDuration(spec.timeout, "timeout");
  if (spec.deadman && timeoutMs === undefined) throw new SpecError("deadman needs a timeout");
  if (spec.forceTeardownAfter !== undefined && !(spec.forceTeardownAfter >= 0)) throw new SpecError("forceTeardownAfter must be >= 0 (minutes)");
  const n: NormalizedSpec = {
    target,
    until: spec.until,
    intervalMs: parseDuration(spec.interval, "interval") ?? DEFAULTS.intervalMs,
    unreachableAfterMs: parseDuration(spec.unreachableAfter, "unreachableAfter") ?? DEFAULTS.unreachableAfterMs,
    keepGoing: spec.keepGoing ?? true,
    fetch: spec.fetch ?? [],
    fetchOn: selectors(spec.fetchOn, "fetchOn", DEFAULTS.fetchOn),
    teardown: spec.teardown ?? [],
    teardownOn: selectors(spec.teardownOn, "teardownOn", DEFAULTS.teardownOn),
    forceTeardown: spec.forceTeardown ?? false,
    hooks: {},
    notify: spec.notify ?? [],
    hookTimeoutMs: parseDuration(spec.hookTimeout, "hookTimeout") ?? DEFAULTS.hookTimeoutMs,
    execTimeoutMs: parseDuration(spec.execTimeout, "execTimeout") ?? DEFAULTS.execTimeoutMs,
    id: spec.id ?? newRunId(),
    deadmanGraceMs: parseDuration(spec.deadmanGrace, "deadmanGrace") ?? DEFAULTS.deadmanGraceMs,
  };
  if (timeoutMs !== undefined) n.timeoutMs = timeoutMs;
  if (stallMs !== undefined) n.stallMs = stallMs;
  if (spec.progressLog) n.progressLog = spec.progressLog;
  if (spec.forceTeardownAfter !== undefined) n.forceTeardownAfterMin = spec.forceTeardownAfter;
  if (spec.deadman) n.deadman = spec.deadman;
  if (spec.idempotencyCheck) n.idempotencyCheck = spec.idempotencyCheck;
  if (spec.signal) n.signal = spec.signal;
  for (const k of ["onDone", "onFail", "onTimeout", "onUnreachable", "onAbort", "onStalled"] as const) {
    if (spec[k]?.length) n.hooks[k] = spec[k];
  }
  if (n.intervalMs <= 0) throw new SpecError("interval must be > 0");
  for (const f of n.fetch) if (!f.from || !f.to) throw new SpecError("fetch entries need from and to");
  return n;
}

/** JSON-safe view of a normalized spec (function hooks become "<function>"). */
export function specToJSON(n: NormalizedSpec): unknown {
  const hooks = (h: Hook[] | undefined) => h?.map(hookName);
  const { signal: _s, hooks: phaseHooks, teardown, ...rest } = n;
  void _s;
  return {
    ...rest,
    teardown: hooks(teardown),
    ...Object.fromEntries(Object.entries(phaseHooks).map(([k, v]) => [k, hooks(v)])),
  };
}

export function createTransport(target: Target, runId: string, execTimeoutMs = DEFAULTS.execTimeoutMs): Transport {
  if (target.kind === "ssh") return new SshTransport(target, { runId, defaultTimeoutMs: execTimeoutMs });
  const t = new LocalTransport();
  t.defaultTimeoutMs = execTimeoutMs;
  return t;
}

export function statusIn(sel: StatusSelector[], status: Status): boolean {
  return sel.includes("all") || sel.includes(status);
}

export function exitCodeFor(r: { status: Status; fetchOk: boolean; hookFailed?: boolean; signal?: string }): number {
  switch (r.status) {
    case "done":
      if (!r.fetchOk) return EXIT_CODES.fetchFailed;
      return r.hookFailed ? EXIT_CODES.hookFailed : EXIT_CODES.done;
    case "fail":
      return EXIT_CODES.fail;
    case "timeout":
      return EXIT_CODES.timeout;
    case "unreachable":
      return EXIT_CODES.unreachable;
    case "stalled":
      return EXIT_CODES.stalled;
    case "exited":
      return EXIT_CODES.exited;
    case "hostKeyChanged":
      return EXIT_CODES.hostKeyChanged;
    case "aborted":
      return EXIT_CODES.signalBase + (SIGNAL_NUMBERS[r.signal ?? "SIGTERM"] ?? 15);
  }
}

export interface RunOptions {
  onEvent?: (e: Event) => void;
  /** Reuse a transport (the `run` subcommand starts the job through it first). */
  transport?: Transport;
  /** Clock and sleeper, injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Write ~/.cache/remote-done/<id>.json (default true). */
  stateFile?: boolean;
}

class AbortedError extends Error {
  constructor(readonly signalName: string) {
    super(`aborted by ${signalName}`);
  }
}

export async function remoteDone(spec: Spec, opts: RunOptions = {}): Promise<Result> {
  const n = normalizeSpec(spec);
  const run = new Run(n, opts);
  return run.execute();
}

/** Same as remoteDone, as an async iterator of events; the return value is the Result. */
export async function* watch(spec: Spec, opts: Omit<RunOptions, "onEvent"> = {}): AsyncGenerator<Event, Result> {
  const queue: Event[] = [];
  let wake: (() => void) | undefined;
  let finished: { result?: Result; error?: unknown } | undefined;
  const p = remoteDone(spec, {
    ...opts,
    onEvent: (e) => {
      queue.push(e);
      wake?.();
    },
  })
    .then((result) => (finished = { result }))
    .catch((error: unknown) => (finished = { error }))
    .finally(() => wake?.());
  for (;;) {
    while (queue.length) yield queue.shift() as Event;
    if (finished) break;
    await new Promise<void>((r) => (wake = r));
    wake = undefined;
  }
  await p;
  if (finished?.error) throw finished.error;
  return finished?.result as Result;
}

const NO_MATCH = /no file matches/;

/**
 * True when this terminal state proves the job's process is over (exit file or process gone), so
 * an unmatched fetch glob stays unmatched. A log marker proves nothing: a job may print "DONE" and
 * still be writing its outputs.
 */
function jobEnded(c: Condition, status: Status): boolean {
  if (status !== "done" && status !== "fail" && status !== "exited") return false;
  switch (c.kind) {
    case "exitFile":
    case "process":
      return true;
    case "all": // a fail comes from any one child, a done needs them all
      return status === "fail" ? c.conditions.every((x) => jobEnded(x, status)) : c.conditions.some((x) => jobEnded(x, status));
    case "any":
      return c.conditions.every((x) => jobEnded(x, status));
    default:
      return false;
  }
}

class Run {
  private readonly emit: (e: Event) => void;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly transport: Transport;
  private readonly ownsTransport: boolean;
  private aborted: string | undefined;
  private wakeSleep: (() => void) | undefined;
  private deadmanPid: number | undefined;
  private readonly t0: number;
  private readonly startedAt: string;

  constructor(
    private readonly spec: NormalizedSpec,
    private readonly opts: RunOptions,
  ) {
    this.emit = opts.onEvent ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ownsTransport = !opts.transport;
    this.transport = opts.transport ?? createTransport(spec.target, spec.id, spec.execTimeoutMs);
    this.t0 = this.now();
    this.startedAt = new Date().toISOString();
    const sig = spec.signal;
    if (sig) {
      const onAbort = () => {
        const reason = sig.reason as { signal?: string } | undefined;
        this.aborted = reason?.signal ?? "SIGTERM";
        this.wakeSleep?.();
      };
      if (sig.aborted) onAbort();
      else sig.addEventListener("abort", onAbort, { once: true });
    }
  }

  private elapsed(): number {
    return this.now() - this.t0;
  }

  /** Interruptible sleep: wakes on abort. */
  private async wait(ms: number): Promise<void> {
    if (this.aborted) return;
    if (ms <= 0) return;
    await Promise.race([
      this.sleepFn(ms),
      new Promise<void>((r) => {
        this.wakeSleep = r;
      }),
    ]);
    this.wakeSleep = undefined;
  }

  private checkAbort(): void {
    if (this.aborted) throw new AbortedError(this.aborted);
  }

  async execute(): Promise<Result> {
    const s = this.spec;
    pruneOld();
    this.emit({ type: "start", id: s.id, target: this.transport.label, at: this.startedAt, spec: specToJSON(s) });
    if (this.opts.stateFile !== false) {
      writeState({
        id: s.id,
        pid: process.pid,
        startedAt: this.startedAt,
        ...(s.timeoutMs !== undefined ? { deadline: new Date(Date.now() + s.timeoutMs).toISOString() } : {}),
        target: this.transport.label,
        until: s.until,
        teardown: s.teardown.map(hookName),
        fetch: s.fetch,
      });
    }

    let status: Status;
    let matched: string | undefined;
    let error: string | undefined;
    try {
      const evaluator = compile(s.until, this.transport, {
        now: this.now,
        execTimeoutMs: s.execTimeoutMs,
        sleep: (ms) => this.wait(ms),
      });
      await this.armDeadman();
      const outcome = await this.pollLoop(evaluator);
      status = outcome.status;
      matched = outcome.matched;
      error = outcome.error;
    } catch (e) {
      if (e instanceof AbortedError) {
        status = "aborted";
        error = e.message;
      } else if (e instanceof SpecError) {
        if (this.ownsTransport) await this.transport.close();
        throw e;
      } else {
        status = "fail";
        error = `engine error: ${(e as Error).message}`;
        this.emit({ type: "warn", message: error });
      }
    }
    try {
      return await this.terminal(status, matched, error);
    } finally {
      if (this.ownsTransport) await this.transport.close();
    }
  }

  private async armDeadman(): Promise<void> {
    const s = this.spec;
    if (!s.deadman || s.timeoutMs === undefined) return;
    const seconds = Math.ceil((s.timeoutMs + s.deadmanGraceMs) / 1000);
    try {
      const r = await this.transport.exec(deadmanArmScript(s.deadman, seconds));
      const pid = Number(r.stdout.trim());
      if (r.code === 0 && Number.isFinite(pid) && pid > 0) {
        this.deadmanPid = pid;
        this.emit({ type: "deadman", action: "armed", detail: `pid ${pid}, fires in ${formatMs(seconds * 1000)}` });
      } else {
        this.emit({ type: "deadman", action: "failed", detail: r.stderr.trim() || `exit ${r.code}` });
      }
    } catch (e) {
      this.emit({ type: "deadman", action: "failed", detail: (e as Error).message });
    }
  }

  private async disarmDeadman(): Promise<void> {
    if (this.deadmanPid === undefined) return;
    try {
      await this.transport.exec(killScript(this.deadmanPid));
      this.emit({ type: "deadman", action: "disarmed" });
      this.deadmanPid = undefined;
    } catch (e) {
      this.emit({ type: "deadman", action: "failed", detail: `could not disarm: ${(e as Error).message}` });
    }
  }

  private async progressKey(): Promise<string> {
    if (!this.spec.progressLog) return "";
    const st = await this.transport.stat(this.spec.progressLog);
    return st.exists ? `|p=${st.size}` : "|p=missing";
  }

  private async pollLoop(evaluator: Evaluator): Promise<{ status: Status; matched?: string; error?: string }> {
    const s = this.spec;
    let lastChangeAt = this.now();
    let lastKey: string | undefined;
    let disconnectedSince: number | undefined;
    let lastTransportError = "";
    let attempt = 0;

    for (;;) {
      this.checkAbort();
      const nowMs = this.now();
      if (s.timeoutMs !== undefined && nowMs - this.t0 >= s.timeoutMs) {
        const late = evaluator.finalCheck?.();
        if (late && (late.state === "done" || late.state === "fail")) return { status: late.state, ...(late.matched !== undefined ? { matched: late.matched } : {}) };
        return { status: "timeout", error: `timeout after ${formatMs(s.timeoutMs)}` };
      }
      if (disconnectedSince !== undefined && nowMs - disconnectedSince >= s.unreachableAfterMs) {
        return { status: "unreachable", error: `unreachable for ${formatMs(nowMs - disconnectedSince)}: ${lastTransportError}` };
      }

      try {
        const r = await evaluator.evaluate();
        const key = (r.changeKey ?? "") + (await this.progressKey());
        const after = this.now();
        if (disconnectedSince !== undefined) {
          const down = after - disconnectedSince;
          lastChangeAt += down; // stall clock is frozen while disconnected
          disconnectedSince = undefined;
          attempt = 0;
          this.emit({ type: "reconnected", downMs: down });
        }
        if (lastKey === undefined || key !== lastKey) {
          lastKey = key;
          lastChangeAt = after;
        }
        this.emit({ type: "poll", elapsedMs: after - this.t0, state: r.state, ...(r.summary !== undefined ? { summary: r.summary } : {}) });
        if (r.state === "done" || r.state === "fail") {
          this.emit({ type: "matched", matched: r.matched ?? "", state: r.state });
          return { status: r.state, ...(r.matched !== undefined ? { matched: r.matched } : {}) };
        }
        if (r.state === "exited") return { status: "exited", ...(r.matched !== undefined ? { matched: r.matched } : {}), error: r.matched ?? "process exited" };
        if (s.stallMs !== undefined && after - lastChangeAt >= s.stallMs) {
          const late = evaluator.finalCheck?.();
          if (late && (late.state === "done" || late.state === "fail")) return { status: late.state, ...(late.matched !== undefined ? { matched: late.matched } : {}) };
          return { status: "stalled", error: `no progress for ${formatMs(after - lastChangeAt)}` };
        }
        await this.wait(this.budgetedDelay(s.intervalMs, disconnectedSince));
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        if (e instanceof HostKeyError) return { status: "hostKeyChanged", error: e.message };
        if (e instanceof AuthError) return { status: "unreachable", error: e.message };
        if (e instanceof TransportError) {
          lastTransportError = e.message;
          if (!s.keepGoing) return { status: "unreachable", error: e.message };
          const t = this.now();
          if (disconnectedSince === undefined) disconnectedSince = t;
          attempt++;
          const delay = Math.min(DEFAULTS.reconnectMinMs * 2 ** (attempt - 1), DEFAULTS.reconnectMaxMs);
          this.emit({ type: "reconnect", attempt, delayMs: delay, error: e.message, downMs: t - disconnectedSince });
          await this.wait(this.budgetedDelay(delay, disconnectedSince));
          continue;
        }
        throw e;
      }
    }
  }

  /** Never sleep past the timeout or the unreachable deadline. */
  private budgetedDelay(wanted: number, disconnectedSince: number | undefined): number {
    const s = this.spec;
    let d = wanted;
    const nowMs = this.now();
    if (s.timeoutMs !== undefined) d = Math.min(d, Math.max(0, this.t0 + s.timeoutMs - nowMs));
    if (disconnectedSince !== undefined) d = Math.min(d, Math.max(0, disconnectedSince + s.unreachableAfterMs - nowMs));
    return d;
  }

  // ---------------------------------------------------------------- terminal

  private async terminal(status: Status, matched: string | undefined, error: string | undefined): Promise<Result> {
    const s = this.spec;
    const hooks: HookResult[] = [];
    const fetched: string[] = [];
    let fetchErrors: FetchError[] = [];

    const ctx = (phase: HookPhase): HookContext => ({
      id: s.id,
      phase,
      status,
      target: this.transport.label,
      ...(matched !== undefined ? { matched } : {}),
      fetched,
      fetchOk: fetchErrors.length === 0,
      fetchErrors,
      elapsedMs: this.elapsed(),
      startedAt: this.startedAt,
      ...(this.aborted ? { signal: this.aborted } : {}),
      ...(error !== undefined ? { error } : {}),
    });

    // 1. fetch
    if (s.fetch.length > 0 && statusIn(s.fetchOn, status)) {
      const ended = jobEnded(s.until, status);
      fetchErrors = await this.fetchAll(s.fetch, fetched, ended);
      let forced = false;
      if (status === "done" && fetchErrors.length > 0 && s.forceTeardownAfterMin !== undefined) {
        const deadline = this.now() + s.forceTeardownAfterMin * 60_000;
        const hopeless = () => ended && fetchErrors.every((e) => NO_MATCH.test(e.error));
        while (fetchErrors.length > 0 && this.now() < deadline && !this.aborted && !hopeless()) {
          await this.wait(Math.min(30_000, Math.max(0, deadline - this.now())));
          if (this.now() >= deadline) break;
          const retry = s.fetch.filter((f) => fetchErrors.some((e) => e.from === f.from && e.to === f.to));
          fetchErrors = await this.fetchAll(retry, fetched, ended);
        }
        if (fetchErrors.length > 0) {
          forced = true;
          const why = hopeless() ? "the job has ended and nothing matches the fetch glob" : `fetch still failing after ${s.forceTeardownAfterMin} min`;
          this.emit({ type: "warn", message: `${why}; tearing down anyway (--force-teardown-after)` });
        }
      }
      if (forced) s.forceTeardown = true;
    }
    const fetchOk = fetchErrors.length === 0;

    // 2. status hooks
    const phaseFor: Partial<Record<Status, Exclude<HookPhase, "teardown" | "notify">>> = {
      done: "onDone",
      fail: "onFail",
      timeout: "onTimeout",
      unreachable: "onUnreachable",
      aborted: "onAbort",
      stalled: "onStalled",
    };
    const phase = phaseFor[status];
    if (phase) {
      for (const h of s.hooks[phase] ?? []) {
        const r = await runHook(h, ctx(phase), { timeoutMs: s.hookTimeoutMs });
        hooks.push(r);
        this.emit({ type: "hook", result: r });
      }
    }

    // 3. teardown: (done && fetched) || (status != done && status in teardownOn)
    const teardownAllowed = status === "done" ? fetchOk || s.forceTeardown : statusIn(s.teardownOn, status);
    let teardownRan = false;
    const pendingTeardown: string[] = [];
    if (s.teardown.length > 0) {
      if (teardownAllowed) {
        teardownRan = true;
        for (const h of s.teardown) {
          const r = await runHook(h, ctx("teardown"), { timeoutMs: s.hookTimeoutMs });
          hooks.push(r);
          this.emit({ type: "hook", result: r });
        }
      } else {
        pendingTeardown.push(...s.teardown.map(hookName));
      }
    }

    // 4. dead-man: disarm once the job is settled or torn down; otherwise leave it as the safety net
    if (this.deadmanPid !== undefined) {
      if (status === "done" || teardownRan) await this.disarmDeadman();
      else this.emit({ type: "warn", message: `dead-man (pid ${this.deadmanPid}) left armed on ${this.transport.label}` });
    }

    // 5. notify, every terminal state
    for (const entry of s.notify) {
      const r = await runNotify(entry, ctx("notify"), s.hookTimeoutMs);
      hooks.push(r);
      this.emit({ type: "hook", result: r });
    }

    const hookFailed = hooks.some((h) => (h.phase === "teardown" || h.phase === "notify") && h.exitCode !== 0);
    const exitCode = exitCodeFor({ status, fetchOk, hookFailed, ...(this.aborted ? { signal: this.aborted } : {}) });
    if (pendingTeardown.length > 0 && exitCode !== EXIT_CODES.done && exitCode !== EXIT_CODES.fail && exitCode !== EXIT_CODES.timeout) {
      this.emit({ type: "warn", message: `teardown NOT run (status ${status}${!fetchOk ? ", fetch failed" : ""}); pending: ${pendingTeardown.join(" && ")}` });
    } else if (pendingTeardown.length > 0 && !teardownRan && (status === "fail" || status === "timeout")) {
      this.emit({ type: "warn", message: `teardown not run for status ${status} (add it to --teardown-on or use --profile pod); pending: ${pendingTeardown.join(" && ")}` });
    }

    const result: Result = {
      id: s.id,
      status,
      exitCode,
      target: this.transport.label,
      ...(matched !== undefined ? { matched } : {}),
      fetched,
      fetchErrors,
      fetchOk,
      hooks,
      elapsedMs: this.elapsed(),
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      ...(this.aborted ? { signal: this.aborted } : {}),
      ...(error !== undefined ? { error } : {}),
      pendingTeardown,
      teardownRan,
    };
    if (this.opts.stateFile !== false) finishState(s.id, { status, exitCode, at: result.finishedAt });
    this.emit({ type: "result", result });
    return result;
  }

  /** Fetch each spec with retries; returns the errors, appends successes to `fetched`. */
  private async fetchAll(specs: FetchSpec[], fetched: string[], ended: boolean): Promise<FetchError[]> {
    const errors: FetchError[] = [];
    for (const f of specs) {
      let lastErr = "";
      let ok = false;
      for (let attempt = 1; attempt <= DEFAULTS.fetchAttempts && !ok; attempt++) {
        if (this.aborted && attempt > 1) break;
        try {
          await this.waitFetchReady(f);
          const files = await this.transport.fetch(f.from, f.to, f.via);
          fetched.push(...files);
          ok = true;
          this.emit({ type: "fetch", from: f.from, to: f.to, ok: true, files, attempt });
        } catch (e) {
          lastErr = (e as Error).message;
          this.emit({ type: "fetch", from: f.from, to: f.to, ok: false, error: lastErr, attempt });
          if (e instanceof HostKeyError || e instanceof AuthError) break;
          if (ended && e instanceof FetchFailure && NO_MATCH.test(lastErr)) break; // nothing can create it any more
          if (attempt < DEFAULTS.fetchAttempts) await this.wait(Math.min(2_000 * 2 ** (attempt - 1), 30_000));
        }
      }
      if (!ok) errors.push({ from: f.from, to: f.to, error: lastErr });
    }
    return errors;
  }

  /** Honour fetch.stableFor / fetch.minBytes before copying. */
  private async waitFetchReady(f: FetchSpec): Promise<void> {
    const stableMs = parseDuration(f.stableFor, "fetch.stableFor");
    if (stableMs === undefined && f.minBytes === undefined) return;
    const deadline = this.now() + DEFAULTS.fetchReadyTimeoutMs;
    let last: number | undefined;
    let stableSince = this.now();
    for (;;) {
      const total = await this.transport.totalBytes(f.from);
      const t = this.now();
      if (total !== last) {
        last = total;
        stableSince = t;
      }
      const bigEnough = f.minBytes === undefined || (total !== undefined && total >= f.minBytes);
      const stable = stableMs === undefined || (total !== undefined && t - stableSince >= stableMs);
      if (total !== undefined && bigEnough && stable) return;
      if (t >= deadline || this.aborted) {
        throw new FetchFailure(`${f.from} not ready (total ${total ?? "none"} bytes${f.minBytes ? `, need ${f.minBytes}` : ""}${stableMs ? `, stable for ${stableMs} ms required` : ""})`);
      }
      await this.wait(Math.min(5_000, Math.max(0, deadline - t)));
    }
  }
}
