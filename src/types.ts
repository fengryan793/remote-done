/**
 * remote-done public types. This file is the design freeze (Plan v2.1, M0.5):
 * status enum + precedence, exit codes, Spec/Result shapes and the Transport
 * contract. Everything else in src/ implements what is declared here.
 */

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type HostKeyPolicy = "accept-new" | "strict" | "insecure";

export interface LocalTarget {
  kind: "local";
}

export interface SshTarget {
  kind: "ssh";
  host: string;
  user?: string;
  port?: number;
  identity?: string;
  /** Default "accept-new": pin into a per-run known_hosts file, fail fast (exit 7) on a changed key. */
  hostKey?: HostKeyPolicy;
  /** Extra raw arguments inserted before the destination (e.g. ["-o", "ProxyJump=bastion"]). */
  sshArgs?: string[];
}

export type Target = LocalTarget | SshTarget;

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** A string is matched as a substring; a RegExp is tested per line. */
export type Matcher = string | RegExp;

/** Numbers are milliseconds; strings are "90" (seconds), "90s", "15m", "2h", "1h30m". */
export type Duration = number | string;

export interface LogCondition {
  kind: "log";
  path: string;
  /** Line that means success. Optional only when `fail` is given (early-fail detector). */
  done?: Matcher;
  fail?: Matcher;
  /** Scan the whole file instead of only what is appended after start (default false). */
  fromStart?: boolean;
}

export interface ExitFileCondition {
  kind: "exitFile";
  /** File whose content is the exit code ("0" = done, anything else = fail). */
  path: string;
}

export interface ProcessCondition {
  kind: "process";
  pid?: number;
  /** `pgrep -f` pattern. Remember the `[p]ython` idiom. */
  pattern?: string;
  /**
   * When given, "process gone" is resolved through this file: content 0 = done,
   * other = fail, absent = fail (crashed before writing). Without it a vanished
   * process only yields status "exited" (outcome unknown, exit code 6).
   */
  exitFile?: string;
}

export interface PortCondition {
  kind: "port";
  port: number;
  /** Host to probe from the target's point of view (default 127.0.0.1). */
  host?: string;
  /** Done when the port is closed instead of open. */
  closed?: boolean;
}

export interface HttpCondition {
  kind: "http";
  /** Evaluated LOCALLY with fetch(); for a URL only reachable on the remote use `command` + curl. */
  url: string;
  /** Accepted status codes (default: any 2xx). */
  status?: number[];
  bodyMatch?: Matcher;
  failMatch?: Matcher;
  /** Disable TLS verification (process-wide, sets NODE_TLS_REJECT_UNAUTHORIZED=0). */
  insecure?: boolean;
  method?: string;
}

export interface FileCondition {
  kind: "file";
  path: string;
  /** Default true. `false` means done when the file is gone. */
  exists?: boolean;
  /** Done only after size+mtime stayed unchanged for this long. */
  stableFor?: Duration;
  minBytes?: number;
}

export interface CommandCondition {
  kind: "command";
  /** Runs on the target every poll: exit 0 = done, exit >= failFrom (100) = fail, else pending. */
  cmd: string;
  failFrom?: number;
}

export interface AllCondition {
  kind: "all";
  conditions: Condition[];
}

export interface AnyCondition {
  kind: "any";
  conditions: Condition[];
}

export type Condition =
  | LogCondition
  | ExitFileCondition
  | ProcessCondition
  | PortCondition
  | HttpCondition
  | FileCondition
  | CommandCondition
  | AllCondition
  | AnyCondition;

// ---------------------------------------------------------------------------
// Status, precedence, exit codes
// ---------------------------------------------------------------------------

/**
 * Terminal statuses. Precedence while waiting:
 *   timeout (wall clock, never paused)
 *     > unreachableAfter (only while disconnected)
 *     > stall (only while connected; frozen during reconnect)
 *     > condition result (done / fail / exited)
 * hostKeyChanged and aborted interrupt everything at once.
 */
export type Status =
  | "done"
  | "fail"
  | "timeout"
  | "unreachable"
  | "stalled"
  | "aborted"
  | "exited"
  | "hostKeyChanged";

export const STATUSES: readonly Status[] = [
  "done",
  "fail",
  "timeout",
  "unreachable",
  "stalled",
  "aborted",
  "exited",
  "hostKeyChanged",
];

export const EXIT_CODES = {
  /** done AND every fetch succeeded */
  done: 0,
  fail: 1,
  timeout: 2,
  unreachable: 3,
  /** job done but at least one fetch failed; teardown was skipped */
  fetchFailed: 4,
  stalled: 5,
  /** process gone, outcome unknown */
  exited: 6,
  hostKeyChanged: 7,
  /** job outcome fine, but a teardown/notify hook failed */
  hookFailed: 8,
  badArgs: 64,
  /** aborted by a signal: 128 + signal number (130 INT, 143 TERM, 129 HUP) */
  signalBase: 128,
} as const;

export const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGTERM: 15,
};

// ---------------------------------------------------------------------------
// Hooks, fetch, notify
// ---------------------------------------------------------------------------

export type HookPhase =
  | "onDone"
  | "onFail"
  | "onTimeout"
  | "onUnreachable"
  | "onAbort"
  | "onStalled"
  | "every"
  | "teardown"
  | "notify";

export interface HookContext {
  id: string;
  phase: HookPhase;
  /** "running" only for `every` hooks: the job has not reached a terminal state yet. */
  status: Status | "running";
  target: string;
  matched?: string;
  fetched: string[];
  fetchOk: boolean;
  fetchErrors: FetchError[];
  elapsedMs: number;
  startedAt: string;
  signal?: string;
  error?: string;
}

/** A shell command (run with `sh -c`, stdin=/dev/null) or an async function. */
export type Hook = string | ((ctx: HookContext) => Promise<void> | void);

export interface HookResult {
  phase: HookPhase;
  name: string;
  exitCode: number | null;
  ms: number;
  timedOut?: boolean;
  /** last 4 KiB of stdout+stderr */
  output?: string;
  error?: string;
}

export interface FetchSpec {
  /** Remote glob (or path). */
  from: string;
  /** Local directory. */
  to: string;
  via?: "scp" | "rsync";
  /** Wait until the total byte size of the matches is unchanged for this long before copying. */
  stableFor?: Duration;
  minBytes?: number;
}

export interface FetchError {
  from: string;
  to: string;
  error: string;
}

export type StatusSelector = Status | "all";

export interface EverySpec {
  /** Time between ticks. A tick that overruns skips the ticks it missed. */
  interval: Duration;
  /** Copied on each tick. Default: the top-level `fetch`; `[]` copies nothing. */
  fetch?: FetchSpec[];
  /** Run on each tick, with status "running". */
  hook?: Hook[];
}

// ---------------------------------------------------------------------------
// Spec and Result
// ---------------------------------------------------------------------------

export interface Spec {
  target?: Target;
  until: Condition;
  /** Poll interval (default 15s). */
  interval?: Duration;
  /** Wall-clock budget; never paused. */
  timeout?: Duration;
  /**
   * Fail with status "stalled" when no change source moved for this long. Requires a
   * condition with a change key (log/file/http/command) or `progressLog`.
   */
  stall?: Duration;
  /** A log whose byte size counts as progress for `stall` (default: none). */
  progressLog?: string;
  /** Give up with status "unreachable" after this long without a successful transport call (default 10m). */
  unreachableAfter?: Duration;
  /** Keep polling across transport errors (default true). false = first transport error is "unreachable". */
  keepGoing?: boolean;

  fetch?: FetchSpec[];
  /** Statuses that trigger a (best-effort) fetch. Default ["done","fail","timeout"]. */
  fetchOn?: StatusSelector[];
  /** Periodic work while the job runs. Failures are reported and never end the wait. */
  every?: EverySpec;
  /** Destructive cleanup. Runs when (done AND fetched) OR (status != done AND status in teardownOn). */
  teardown?: Hook[];
  /** Default ["done"]; "done" always means done-and-fetched. */
  teardownOn?: StatusSelector[];
  /** Run teardown even when a fetch failed. */
  forceTeardown?: boolean;
  /** Keep retrying a failed fetch for this many minutes, then tear down anyway. */
  forceTeardownAfter?: number;

  onDone?: Hook[];
  onFail?: Hook[];
  onTimeout?: Hook[];
  /** Notify-only by default: never falls back to onFail. */
  onUnreachable?: Hook[];
  onAbort?: Hook[];
  onStalled?: Hook[];
  /** Runs for every terminal state: "ntfy://host/topic", "https://webhook" (POST JSON) or a shell command. */
  notify?: string[];

  /** Per-hook timeout (default 10m). */
  hookTimeout?: Duration;
  /** Per transport call timeout (default 2m). */
  execTimeout?: Duration;
  /** Run id (default: random). Used for the state file and the per-run known_hosts file. */
  id?: string;
  /** Remote dead-man command armed with `sleep timeout+grace && CMD` on the target; disarmed on exit. Needs `timeout`. */
  deadman?: string;
  /** Grace added to the dead-man timer (default 10m). */
  deadmanGrace?: Duration;
  /** Probe used by `run` after a sentinel loss to find out whether the job already started. */
  idempotencyCheck?: string;
  /** Abort signal; `signal.reason.signal` (e.g. "SIGINT") selects the 128+signo exit code. */
  signal?: AbortSignal;
}

export interface Result {
  id: string;
  status: Status;
  exitCode: number;
  target: string;
  matched?: string;
  fetched: string[];
  fetchErrors: FetchError[];
  fetchOk: boolean;
  hooks: HookResult[];
  elapsedMs: number;
  startedAt: string;
  finishedAt: string;
  signal?: string;
  error?: string;
  /** Teardown commands that were NOT run (printed to stderr on exit 3-7 and 4). */
  pendingTeardown: string[];
  teardownRan: boolean;
}

// ---------------------------------------------------------------------------
// Events (NDJSON in --json mode)
// ---------------------------------------------------------------------------

export type Event =
  | { type: "start"; id: string; target: string; at: string; spec: unknown }
  | { type: "poll"; elapsedMs: number; state: "pending" | "done" | "fail" | "exited"; summary?: string }
  | { type: "matched"; matched: string; state: "done" | "fail" }
  | { type: "reconnect"; attempt: number; delayMs: number; error: string; downMs: number }
  | { type: "reconnected"; downMs: number }
  | { type: "fetch"; from: string; to: string; ok: boolean; files?: string[]; error?: string; attempt: number }
  | { type: "tick"; n: number; files: number; errors: string[]; ms: number }
  | { type: "hook"; result: HookResult }
  | { type: "deadman"; action: "armed" | "disarmed" | "failed"; detail?: string }
  | { type: "warn"; message: string }
  | { type: "result"; result: Result };

// ---------------------------------------------------------------------------
// Transport contract
// ---------------------------------------------------------------------------

export interface ExecOptions {
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** false when an ssh sentinel was expected but not seen (remote code unknown). */
  sentinel: boolean;
}

export interface RawExecResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  sentinel: boolean;
}

export interface TailResult {
  exists: boolean;
  /** "ino:dev" identity, "" when missing */
  ino: string;
  size: number;
  bytes: Buffer;
}

export interface StatResult {
  exists: boolean;
  ino: string;
  size: number;
  mtimeMs: number;
}

export interface Transport {
  readonly kind: "local" | "ssh";
  /** Human label, e.g. "local" or "root@1.2.3.4:22011". */
  readonly label: string;
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  execRaw(cmd: string, opts?: ExecOptions): Promise<RawExecResult>;
  readTail(path: string, fromByte: number, maxBytes: number): Promise<TailResult>;
  stat(path: string): Promise<StatResult>;
  processAlive(sel: { pid?: number; pattern?: string }): Promise<boolean>;
  portOpen(port: number, host?: string): Promise<boolean>;
  listGlob(glob: string): Promise<string[]>;
  totalBytes(glob: string): Promise<number | undefined>;
  /** Copies every match of `from` into local dir `toDir`; returns local paths. Throws on no match. */
  fetch(from: string, toDir: string, via?: "scp" | "rsync"): Promise<string[]>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TransportPhase = "connect" | "session" | "timeout";

/** A transport (ssh client) failure, never a remote command's own exit status. */
export class TransportError extends Error {
  readonly phase: TransportPhase;
  constructor(message: string, phase: TransportPhase) {
    super(message);
    this.name = "TransportError";
    this.phase = phase;
  }
}

/** Terminal: host key changed / unknown under strict. Exit 7, never retried. */
export class HostKeyError extends Error {
  readonly file?: string;
  readonly line?: number;
  readonly fix?: string;
  constructor(message: string, info: { file?: string; line?: number; fix?: string } = {}) {
    super(message);
    this.name = "HostKeyError";
    if (info.file !== undefined) this.file = info.file;
    if (info.line !== undefined) this.line = info.line;
    if (info.fix !== undefined) this.fix = info.fix;
  }
}

/** Terminal: authentication refused. Status unreachable at once (exit 3). */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** Bad spec / bad CLI arguments: exit 64. */
export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

export class FetchFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchFailure";
  }
}
