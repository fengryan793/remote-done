#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { describeCondition } from "./conditions.js";
import { formatMs, parseDuration } from "./duration.js";
import { createTransport, normalizeSpec, remoteDone, specToJSON } from "./engine.js";
import { parseSshDestination } from "./index.js";
import { runCondition, startDetached } from "./run.js";
import {
  EXIT_CODES,
  SIGNAL_NUMBERS,
  SpecError,
  type Condition,
  type Event,
  type FetchSpec,
  type HostKeyPolicy,
  type Spec,
  type StatusSelector,
  type Target,
} from "./types.js";

const require = createRequire(import.meta.url);
const VERSION: string = (require("../package.json") as { version: string }).version;

const HELP = `remote-done ${VERSION} - wait for a job (local or over ssh), then fetch, hook, exit meaningfully.

USAGE
  remote-done [wait] [target] <condition>... [timing] [fetch] [hooks] [output]
  remote-done run [target] --log LOG [--done RE] [--fail RE] ... -- CMD...     start CMD detached, then wait

TARGET (default: local)
  --ssh [user@]host[:port]     -p, --ssh-port N    -i, --identity KEY
  --host-key accept-new|strict|insecure   (default accept-new: per-run known_hosts, exit 7 on a changed key)
  --ssh-arg ARG                extra ssh argument (repeatable, e.g. --ssh-arg=-oProxyJump=bastion)

CONDITIONS (several = all of them; --any = any of them)
  --log PATH --done RE [--fail RE] [--from-start]     line markers (regex), tail from the current end
  --exit-file PATH             file whose content is the exit code (0 = done)
  --process PID|PATTERN        exited (status 6) unless paired with --exit-file / --fail
  --port N [--port-host H] [--port-closed]
  --http URL [--status 200,201] [--body-match RE] [--fail-match RE] [--insecure]   (evaluated locally)
  --file PATH [--stable 30s] [--min-bytes N]
  --cmd 'CMD' [--fail-from 100]            exit 0 = done, >= fail-from = fail, else keep polling

TIMING
  --interval 15s   --timeout 2h   --stall 20m [--progress-log PATH]   --unreachable-after 10m
  --no-keep-going  first transport error = unreachable

FETCH (after the terminal state, before teardown)
  --fetch 'REMOTE_GLOB[:LOCAL_DIR]'   (repeatable; default dir = --to or .)   --rsync
  --fetch-on done,fail,timeout        statuses that fetch (default) or "all"

PERIODIC (while the job runs; failures are reported and never end the wait)
  --every 30m                  copy the --fetch entries on this schedule
  --every-fetch 'GLOB[:DIR]'   copy these instead (repeatable)      --every-no-fetch   copy nothing
  --every-hook CMD             run this each time (repeatable); RD_STATUS=running, and
                               kill -TERM "$RD_PID" stops the wait through the abort path

HOOKS (sh -c; env RD_STATUS RD_MATCH RD_FETCHED RD_FETCH_OK RD_ELAPSED_MS RD_TARGET RD_CTX_FILE)
  --on-done CMD --on-fail CMD --on-timeout CMD --on-unreachable CMD --on-abort CMD --on-stalled CMD
  --teardown CMD               destructive cleanup; runs when (done AND fetched) or status in --teardown-on
  --teardown-on done           (default) or e.g. done,fail,timeout or all
  --force-teardown             tear down even when a fetch failed
  --force-teardown-after MIN   keep retrying a failed fetch MIN minutes, then tear down anyway
  --profile pod                = --teardown-on all --fetch-on all --force-teardown-after 5  (hourly-billed pods)
  --notify ntfy://ntfy.sh/topic | https://webhook | CMD    every terminal state (repeatable)
  --deadman CMD                remote 'sleep timeout+10m && CMD' safety net (needs --timeout)
  --hook-timeout 10m

OUTPUT
  --json        NDJSON events on stdout (nothing else)      --quiet   no poll lines
  --dry-run     print the resolved spec and exit            --id ID   run id
  --no-caffeinate (macOS)   -h, --help   -V, --version

EXIT CODES
  0 done+fetched  1 fail  2 timeout  3 unreachable  4 done but fetch failed (teardown skipped unless forced)
  5 stalled  6 process exited, outcome unknown  7 host key changed  8 teardown/notify hook failed
  64 bad arguments  128+signo aborted (130 INT, 143 TERM, 129 HUP)

NOTES
  Values starting with "-" need --flag=value. --cmd runs on every poll and must be idempotent.
  Remote http must go through --cmd 'curl -fsS ...'. RunPod: public IP + exposed 22/tcp only.
`;

type Opt = { type: "string" | "boolean"; short?: string; multiple?: boolean };
const OPTIONS: Record<string, Opt> = {
  ssh: { type: "string" },
  "ssh-port": { type: "string", short: "p" },
  identity: { type: "string", short: "i" },
  "host-key": { type: "string" },
  "ssh-arg": { type: "string", multiple: true },
  log: { type: "string" },
  done: { type: "string" },
  fail: { type: "string" },
  "from-start": { type: "boolean" },
  "exit-file": { type: "string" },
  process: { type: "string" },
  port: { type: "string" },
  "port-host": { type: "string" },
  "port-closed": { type: "boolean" },
  http: { type: "string" },
  status: { type: "string" },
  "body-match": { type: "string" },
  "fail-match": { type: "string" },
  insecure: { type: "boolean" },
  file: { type: "string" },
  stable: { type: "string" },
  "min-bytes": { type: "string" },
  cmd: { type: "string" },
  "fail-from": { type: "string" },
  any: { type: "boolean" },
  interval: { type: "string" },
  timeout: { type: "string" },
  stall: { type: "string" },
  "progress-log": { type: "string" },
  "unreachable-after": { type: "string" },
  "no-keep-going": { type: "boolean" },
  fetch: { type: "string", multiple: true },
  to: { type: "string" },
  rsync: { type: "boolean" },
  "fetch-on": { type: "string" },
  every: { type: "string" },
  "every-fetch": { type: "string", multiple: true },
  "every-hook": { type: "string", multiple: true },
  "every-no-fetch": { type: "boolean" },
  teardown: { type: "string", multiple: true },
  "teardown-on": { type: "string" },
  "force-teardown": { type: "boolean" },
  "force-teardown-after": { type: "string" },
  profile: { type: "string" },
  "on-done": { type: "string", multiple: true },
  "on-fail": { type: "string", multiple: true },
  "on-timeout": { type: "string", multiple: true },
  "on-unreachable": { type: "string", multiple: true },
  "on-abort": { type: "string", multiple: true },
  "on-stalled": { type: "string", multiple: true },
  notify: { type: "string", multiple: true },
  deadman: { type: "string" },
  "deadman-grace": { type: "string" },
  "idempotency-check": { type: "string" },
  "hook-timeout": { type: "string" },
  "exec-timeout": { type: "string" },
  id: { type: "string" },
  "no-caffeinate": { type: "boolean" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
};

export interface ParsedCli {
  mode: "wait" | "run";
  spec: Spec;
  command?: string;
  markers: { done?: RegExp; fail?: RegExp };
  json: boolean;
  quiet: boolean;
  dryRun: boolean;
  caffeinate: boolean;
}

function regex(v: string | undefined, name: string): RegExp | undefined {
  if (v === undefined) return undefined;
  try {
    return new RegExp(v);
  } catch (e) {
    throw new SpecError(`${name}: invalid regex ${JSON.stringify(v)}: ${(e as Error).message}`);
  }
}

function int(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new SpecError(`${name}: expected an integer, got ${JSON.stringify(v)}`);
  return Number(v);
}

function list(v: string | undefined): StatusSelector[] | undefined {
  if (v === undefined) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean) as StatusSelector[];
}

/** Pure: argv -> Spec. Throws SpecError (exit 64). */
export function parseCli(argv: string[]): ParsedCli {
  let mode: "wait" | "run" = "wait";
  let args = argv;
  if (args[0] === "run") {
    mode = "run";
    args = args.slice(1);
  } else if (args[0] === "wait") {
    args = args.slice(1); // explicit alias of the default mode: people type it by symmetry with `run`
  }
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true }));
  } catch (e) {
    throw new SpecError((e as Error).message.replace(/^.*?: /, ""));
  }
  const v = values as Record<string, string | boolean | string[] | undefined>;
  const str = (k: string): string | undefined => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  const bool = (k: string): boolean => v[k] === true;
  const multi = (k: string): string[] => (Array.isArray(v[k]) ? (v[k] as string[]) : []);

  if (bool("help")) throw new HelpRequested(HELP);
  if (bool("version")) throw new HelpRequested(`${VERSION}\n`);

  if (mode === "wait" && positionals.length > 0) {
    throw new SpecError(`unexpected argument ${JSON.stringify(positionals[0])} (did you mean "remote-done run ... -- CMD"?)`);
  }

  // target
  let target: Target = { kind: "local" };
  if (str("ssh")) {
    const d = parseSshDestination(str("ssh") as string);
    target = { kind: "ssh", host: d.host };
    if (d.user) target.user = d.user;
    const port = int(str("ssh-port"), "--ssh-port") ?? d.port;
    if (port !== undefined) target.port = port;
    if (str("identity")) target.identity = str("identity") as string;
    const hk = str("host-key");
    if (hk !== undefined) {
      if (!["accept-new", "strict", "insecure"].includes(hk)) throw new SpecError(`--host-key: accept-new, strict or insecure (got ${hk})`);
      target.hostKey = hk as HostKeyPolicy;
    }
    if (multi("ssh-arg").length) target.sshArgs = multi("ssh-arg");
  } else if (str("ssh-port") || str("identity") || str("host-key") || multi("ssh-arg").length) {
    throw new SpecError("--ssh-port/--identity/--host-key/--ssh-arg need --ssh");
  }

  // conditions
  const markers = { done: regex(str("done"), "--done"), fail: regex(str("fail"), "--fail") };
  const conds: Condition[] = [];
  if (str("log") && mode === "wait") {
    if (!markers.done && !markers.fail) throw new SpecError("--log needs --done RE (and/or --fail RE)");
    conds.push({
      kind: "log",
      path: str("log") as string,
      ...(markers.done ? { done: markers.done } : {}),
      ...(markers.fail ? { fail: markers.fail } : {}),
      ...(bool("from-start") ? { fromStart: true } : {}),
    });
  } else if (mode === "wait" && (markers.done || markers.fail || bool("from-start"))) {
    throw new SpecError("--done/--fail/--from-start need --log PATH");
  }
  if (str("exit-file")) conds.push({ kind: "exitFile", path: str("exit-file") as string });
  if (str("process")) {
    const p = str("process") as string;
    const c: Condition = /^\d+$/.test(p) ? { kind: "process", pid: Number(p) } : { kind: "process", pattern: p };
    if (str("exit-file") && conds.length) {
      // `--process X --exit-file F` = one process condition resolved through F
      conds.pop();
      c.exitFile = str("exit-file") as string;
    }
    conds.push(c);
  }
  if (str("port")) {
    conds.push({
      kind: "port",
      port: int(str("port"), "--port") as number,
      ...(str("port-host") ? { host: str("port-host") as string } : {}),
      ...(bool("port-closed") ? { closed: true } : {}),
    });
  }
  if (str("http")) {
    const status = str("status")?.split(",").map((s) => int(s.trim(), "--status") as number);
    const bodyMatch = regex(str("body-match"), "--body-match");
    const failMatch = regex(str("fail-match"), "--fail-match");
    conds.push({
      kind: "http",
      url: str("http") as string,
      ...(status ? { status } : {}),
      ...(bodyMatch ? { bodyMatch } : {}),
      ...(failMatch ? { failMatch } : {}),
      ...(bool("insecure") ? { insecure: true } : {}),
    });
  }
  if (str("file")) {
    const minBytes = int(str("min-bytes"), "--min-bytes");
    conds.push({
      kind: "file",
      path: str("file") as string,
      ...(str("stable") ? { stableFor: str("stable") as string } : {}),
      ...(minBytes !== undefined ? { minBytes } : {}),
    });
  }
  if (str("cmd")) {
    const failFrom = int(str("fail-from"), "--fail-from");
    conds.push({ kind: "command", cmd: str("cmd") as string, ...(failFrom !== undefined ? { failFrom } : {}) });
  }

  let until: Condition;
  let command: string | undefined;
  if (mode === "run") {
    if (positionals.length === 0) throw new SpecError("run: give the command after `--`, e.g. remote-done run --log /tmp/x.log -- python train.py");
    if (!str("log")) throw new SpecError("run: --log PATH is required (the command's stdout+stderr and <log>.rc live there)");
    if (conds.some((c) => c.kind !== "log")) throw new SpecError("run: only --log/--done/--fail conditions are allowed (the exit code comes from <log>.rc)");
    command = positionals.join(" ");
    until = { kind: "exitFile", path: `${str("log")}.rc` }; // replaced after start
    // the job log is the natural progress source for --stall in run mode
    if (str("stall") && !str("progress-log")) v["progress-log"] = str("log");
  } else {
    if (conds.length === 0) throw new SpecError("no condition given (try --log PATH --done RE, --exit-file, --process, --port, --http, --file or --cmd)");
    until = conds.length === 1 ? (conds[0] as Condition) : { kind: bool("any") ? "any" : "all", conditions: conds };
  }

  // fetch
  const defaultTo = str("to") ?? ".";
  const fetchSpec = (f: string): FetchSpec => {
    const i = f.lastIndexOf(":");
    const from = i > 0 ? f.slice(0, i) : f;
    const to = i > 0 ? f.slice(i + 1) : defaultTo;
    return { from, to: to || defaultTo, ...(bool("rsync") ? { via: "rsync" as const } : {}) };
  };
  const fetch = multi("fetch").map(fetchSpec);

  const spec: Spec = { target, until };
  if (fetch.length) spec.fetch = fetch;
  if (str("every")) {
    spec.every = { interval: str("every") as string };
    if (bool("every-no-fetch") && multi("every-fetch").length) throw new SpecError("--every-no-fetch and --every-fetch are opposites");
    if (bool("every-no-fetch")) spec.every.fetch = [];
    else if (multi("every-fetch").length) spec.every.fetch = multi("every-fetch").map(fetchSpec);
    if (multi("every-hook").length) spec.every.hook = multi("every-hook");
  } else if (multi("every-fetch").length || multi("every-hook").length || bool("every-no-fetch")) {
    throw new SpecError("--every-fetch/--every-hook/--every-no-fetch need --every INTERVAL");
  }
  const set = <K extends keyof Spec>(k: K, val: Spec[K] | undefined) => {
    if (val !== undefined) spec[k] = val;
  };
  set("interval", str("interval"));
  set("timeout", str("timeout"));
  set("stall", str("stall"));
  set("progressLog", str("progress-log"));
  set("unreachableAfter", str("unreachable-after"));
  if (bool("no-keep-going")) spec.keepGoing = false;
  set("fetchOn", list(str("fetch-on")));
  if (multi("teardown").length) spec.teardown = multi("teardown");
  set("teardownOn", list(str("teardown-on")));
  if (bool("force-teardown")) spec.forceTeardown = true;
  const fta = str("force-teardown-after");
  if (fta !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(fta)) throw new SpecError("--force-teardown-after: minutes expected");
    spec.forceTeardownAfter = Number(fta);
  }
  const profile = str("profile");
  if (profile !== undefined) {
    if (profile !== "pod") throw new SpecError(`--profile: only "pod" exists (got ${profile})`);
    spec.teardownOn ??= ["all"];
    spec.fetchOn ??= ["all"];
    spec.forceTeardownAfter ??= 5;
  }
  for (const [flag, key] of [
    ["on-done", "onDone"],
    ["on-fail", "onFail"],
    ["on-timeout", "onTimeout"],
    ["on-unreachable", "onUnreachable"],
    ["on-abort", "onAbort"],
    ["on-stalled", "onStalled"],
  ] as const) {
    if (multi(flag).length) spec[key] = multi(flag);
  }
  if (multi("notify").length) spec.notify = multi("notify");
  set("deadman", str("deadman"));
  set("deadmanGrace", str("deadman-grace"));
  set("idempotencyCheck", str("idempotency-check"));
  set("hookTimeout", str("hook-timeout"));
  set("execTimeout", str("exec-timeout"));
  set("id", str("id"));

  // validate early so bad args exit 64 before anything starts
  normalizeSpec(spec);

  return {
    mode,
    spec,
    ...(command !== undefined ? { command } : {}),
    markers: { ...(markers.done ? { done: markers.done } : {}), ...(markers.fail ? { fail: markers.fail } : {}) },
    json: bool("json"),
    quiet: bool("quiet"),
    dryRun: bool("dry-run"),
    caffeinate: !bool("no-caffeinate"),
  };
}

class HelpRequested extends Error {}

// ---------------------------------------------------------------------------- output

function makePrinter(json: boolean, quiet: boolean): (e: Event) => void {
  const err = (s: string) => process.stderr.write(s + "\n");
  if (json) return (e) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n");
  return (e) => {
    switch (e.type) {
      case "start":
        err(`remote-done ${e.id} · ${e.target} · ${describeCondition((e.spec as { until: Condition }).until)}`);
        break;
      case "poll":
        if (!quiet) err(`[${formatMs(e.elapsedMs).padStart(7)}] ${e.summary ?? e.state}`);
        break;
      case "matched":
        err(`${e.state === "done" ? "✓" : "✗"} matched: ${e.matched}`);
        break;
      case "reconnect":
        err(`! transport error (attempt ${e.attempt}, retry in ${formatMs(e.delayMs)}, down ${formatMs(e.downMs)}): ${e.error}`);
        break;
      case "reconnected":
        err(`· reconnected after ${formatMs(e.downMs)}`);
        break;
      case "fetch":
        err(e.ok ? `↓ fetched ${e.files?.length ?? 0} file(s) from ${e.from} → ${e.to}` : `! fetch ${e.from} failed (attempt ${e.attempt}): ${e.error}`);
        break;
      case "tick":
        if (!quiet || e.errors.length) err(`· tick ${e.n}: ${e.files} file(s) in ${formatMs(e.ms)}${e.errors.length ? `; ${e.errors.join("; ")}` : ""}`);
        break;
      case "hook": {
        const r = e.result;
        err(`» ${r.phase} ${r.name} → exit ${r.exitCode ?? "?"}${r.timedOut ? " (timed out)" : ""} in ${formatMs(r.ms)}${r.error ? `: ${r.error}` : ""}`);
        if (r.output && !quiet) err(r.output.trimEnd().split("\n").map((l) => `    ${l}`).join("\n"));
        break;
      }
      case "deadman":
        err(`· dead-man ${e.action}${e.detail ? `: ${e.detail}` : ""}`);
        break;
      case "warn":
        err(`! ${e.message}`);
        break;
      case "result": {
        const r = e.result;
        const bits = [r.status, formatMs(r.elapsedMs)];
        if (r.matched) bits.push(r.matched);
        if (r.fetched.length) bits.push(`fetched ${r.fetched.length}`);
        if (!r.fetchOk) bits.push("FETCH FAILED");
        if (r.teardownRan) bits.push("torn down");
        if (r.error && !r.matched) bits.push(r.error);
        bits.push(`exit ${r.exitCode}`);
        process.stdout.write(bits.join(" · ") + "\n");
        break;
      }
    }
  };
}

// ---------------------------------------------------------------------------- main

export async function main(argv: string[]): Promise<number> {
  let cli: ParsedCli;
  try {
    cli = parseCli(argv);
  } catch (e) {
    if (e instanceof HelpRequested) {
      process.stdout.write(e.message);
      return 0;
    }
    process.stderr.write(`remote-done: ${(e as Error).message}\n(see remote-done --help)\n`);
    return EXIT_CODES.badArgs;
  }
  const emit = makePrinter(cli.json, cli.quiet);

  if (cli.dryRun) {
    process.stdout.write(JSON.stringify({ mode: cli.mode, command: cli.command, spec: specToJSON(normalizeSpec(cli.spec)) }, null, 2) + "\n");
    return 0;
  }

  const ac = new AbortController();
  let signalled: string | undefined;
  const onSignal = (sig: NodeJS.Signals) => {
    if (signalled) {
      process.stderr.write(`remote-done: second ${sig}, exiting now\n`);
      process.exit(EXIT_CODES.signalBase + (SIGNAL_NUMBERS[sig] ?? 15));
    }
    signalled = sig;
    process.stderr.write(`remote-done: ${sig} received, stopping (onAbort hooks run; press again to exit at once)\n`);
    ac.abort({ signal: sig });
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, onSignal);

  if (cli.caffeinate && process.platform === "darwin") {
    try {
      spawn("caffeinate", ["-i", "-w", String(process.pid)], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* optional */
    }
  }

  const spec: Spec = { ...cli.spec, signal: ac.signal };
  try {
    if (cli.mode === "run") {
      const n = normalizeSpec(spec);
      const transport = createTransport(n.target, n.id, n.execTimeoutMs);
      const log = (spec.until as { path: string }).path.replace(/\.rc$/, "");
      try {
        const started = await startDetached(transport, cli.command as string, log, {
          onEvent: emit,
          unreachableAfterMs: n.unreachableAfterMs,
          ...(n.idempotencyCheck ? { idempotencyCheck: n.idempotencyCheck } : {}),
        });
        process.stderr.write(`remote-done: started on ${transport.label}${started.pid ? ` (pid ${started.pid})` : ""}, log ${started.log}\n`);
        spec.until = runCondition(started, cli.markers);
        spec.id = n.id;
        const result = await remoteDone(spec, { onEvent: emit, transport });
        return result.exitCode;
      } finally {
        await transport.close();
      }
    }
    const result = await remoteDone(spec, { onEvent: emit });
    return result.exitCode;
  } catch (e) {
    if (e instanceof SpecError) {
      process.stderr.write(`remote-done: ${e.message}\n`);
      return EXIT_CODES.badArgs;
    }
    process.stderr.write(`remote-done: ${(e as Error).stack ?? (e as Error).message}\n`);
    return signalled ? EXIT_CODES.signalBase + (SIGNAL_NUMBERS[signalled] ?? 15) : 70;
  }
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === require("node:fs").realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`remote-done: ${(e as Error).stack ?? e}\n`);
      process.exitCode = 70;
    },
  );
}
