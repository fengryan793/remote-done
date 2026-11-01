import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { shq } from "../shell.js";
import { knownHostsDir } from "../state.js";
import {
  AuthError,
  FetchFailure,
  HostKeyError,
  TransportError,
  type ExecOptions,
  type RawExecResult,
  type SshTarget,
  type TransportPhase,
} from "../types.js";
import { ShellTransport, spawnCapture } from "./base.js";

export const SENTINEL = "__RD_RC=";

export interface SshTransportOptions {
  runId: string;
  /** Directory for per-run known_hosts files (accept-new policy). */
  knownHostsDir?: string;
  defaultTimeoutMs?: number;
  /** ssh/scp/rsync binaries (tests). */
  bin?: { ssh?: string; scp?: string; rsync?: string };
}

export type SshFailureClass =
  | { type: "hostKeyChanged"; file?: string; line?: number }
  | { type: "hostKeyUnknown" }
  | { type: "auth" }
  | { type: "transport"; phase: TransportPhase }
  | { type: "none" };

const CONNECT_PATTERNS = [
  /^ssh: connect to host/m,
  /Connection refused/,
  /Could not resolve hostname/,
  /No route to host/,
  /Network is unreachable/,
  /kex_exchange_identification/,
  /Connection timed out/,
  /Operation timed out/,
  /banner exchange/,
];

const SESSION_PATTERNS = [
  /client_loop: send disconnect/,
  /Connection (closed|reset) by/,
  /Timeout, server .* not responding/,
  /packet_write_wait/,
  /Broken pipe/,
  /Connection to .* closed by remote host/,
];

const AUTH_PATTERNS = [
  /Permission denied \(/,
  /Permission denied, please try again/,
  /Too many authentication failures/,
  /No more authentication methods/,
  /Host key verification failed/, // handled before, kept for completeness
];

/** Classify an ssh client failure from its stderr. `code` is the ssh exit code. */
export function classifySshFailure(code: number | null, stderr: string, hadStdout: boolean): SshFailureClass {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr)) {
    const m = /Offending \S+ key in (\S+):(\d+)/.exec(stderr);
    const r: SshFailureClass = { type: "hostKeyChanged" };
    if (m) {
      r.file = m[1] as string;
      r.line = Number(m[2]);
    }
    return r;
  }
  if (/Host key verification failed/.test(stderr)) return { type: "hostKeyUnknown" };
  if (AUTH_PATTERNS.slice(0, 4).some((p) => p.test(stderr))) return { type: "auth" };
  if (CONNECT_PATTERNS.some((p) => p.test(stderr))) return { type: "transport", phase: "connect" };
  if (SESSION_PATTERNS.some((p) => p.test(stderr))) return { type: "transport", phase: "session" };
  if (code === 255) return { type: "transport", phase: hadStdout ? "session" : "connect" };
  return { type: "none" };
}

/** Split `<body>\n__RD_RC=<n>\n` off the end of the remote stdout. */
export function parseSentinel(stdout: Buffer): { found: boolean; code: number; body: Buffer } {
  const tailLen = Math.min(stdout.length, 32);
  const tail = stdout.subarray(stdout.length - tailLen).toString("latin1");
  const m = /\n__RD_RC=(\d+)\n?$/.exec(tail);
  if (!m) return { found: false, code: -1, body: stdout };
  const cut = stdout.length - m[0].length;
  return { found: true, code: Number(m[1]), body: Buffer.from(stdout.subarray(0, cut)) };
}

export function sshDestination(t: SshTarget): string {
  return t.user ? `${t.user}@${t.host}` : t.host;
}

export function knownHostsFileFor(t: SshTarget, runId: string, dir: string): string {
  const safe = t.host.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(dir, `${safe}_${t.port ?? 22}_${runId}`);
}

export function hostKeyFixCommand(t: SshTarget, file?: string): string {
  const port = t.port ?? 22;
  const entry = port === 22 ? t.host : `[${t.host}]:${port}`;
  return `ssh-keygen -R ${shq(entry)}${file ? ` -f ${shq(file)}` : ""}`;
}

/**
 * Common `-o` options for ssh, scp and rsync's -e. `accept-new` pins into a per-run file so a
 * reused ip:port never meets a stale pin; `insecure` is what orchestrate.py does today.
 */
export function sshCommonOptions(t: SshTarget, knownHostsFile: string): string[] {
  const policy = t.hostKey ?? "accept-new";
  const o = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "LogLevel=ERROR",
  ];
  if (policy === "accept-new") o.push("-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${knownHostsFile}`);
  else if (policy === "insecure") o.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  else o.push("-o", "StrictHostKeyChecking=yes");
  if (t.identity) o.push("-i", t.identity, "-o", "IdentitiesOnly=yes");
  return o;
}

export class SshTransport extends ShellTransport {
  readonly kind = "ssh" as const;
  readonly label: string;
  readonly knownHostsFile: string;
  private readonly dest: string;
  private readonly bin: { ssh: string; scp: string; rsync: string };

  constructor(
    readonly target: SshTarget,
    opts: SshTransportOptions,
  ) {
    super();
    if (opts.defaultTimeoutMs !== undefined) this.defaultTimeoutMs = opts.defaultTimeoutMs;
    this.dest = sshDestination(target);
    this.label = `${this.dest}:${target.port ?? 22}`;
    const dir = opts.knownHostsDir ?? knownHostsDir();
    this.knownHostsFile = knownHostsFileFor(target, opts.runId, dir);
    if ((target.hostKey ?? "accept-new") === "accept-new") mkdirSync(dir, { recursive: true });
    this.bin = { ssh: opts.bin?.ssh ?? "ssh", scp: opts.bin?.scp ?? "scp", rsync: opts.bin?.rsync ?? "rsync" };
  }

  /** Full ssh argv up to (and including) the destination. */
  sshArgv(): string[] {
    const a = ["-n", ...sshCommonOptions(this.target, this.knownHostsFile)];
    if (this.target.port !== undefined) a.push("-p", String(this.target.port));
    if (this.target.sshArgs) a.push(...this.target.sshArgs);
    a.push("--", this.dest);
    return a;
  }

  private scpArgv(): string[] {
    const a = ["-q", "-r", ...sshCommonOptions(this.target, this.knownHostsFile)];
    if (this.target.port !== undefined) a.push("-P", String(this.target.port));
    if (this.target.sshArgs) a.push(...this.target.sshArgs);
    return a;
  }

  private rsyncRsh(): string {
    const a = [this.bin.ssh, ...sshCommonOptions(this.target, this.knownHostsFile)];
    if (this.target.port !== undefined) a.push("-p", String(this.target.port));
    if (this.target.sshArgs) a.push(...this.target.sshArgs);
    return a.map(shq).join(" ");
  }

  /** `sh -c '<script>'; printf '\n__RD_RC=%s\n' $?` so a lost connection is never mistaken for a remote exit code. */
  static wrap(script: string): string {
    return `sh -c ${shq(script)}; printf '\\n${SENTINEL}%s\\n' $?`;
  }

  protected async runScript(script: string, opts: Required<ExecOptions>): Promise<RawExecResult> {
    const r = await spawnCapture(this.bin.ssh, [...this.sshArgv(), SshTransport.wrap(script)], {
      timeoutMs: opts.timeoutMs,
    });
    if (r.spawnError) throw new Error(`cannot spawn ${this.bin.ssh}: ${r.spawnError.message}`);
    if (r.timedOut) {
      throw new TransportError(`ssh to ${this.label} timed out after ${Math.round(opts.timeoutMs / 1000)} s`, "timeout");
    }
    const s = parseSentinel(r.stdout);
    if (s.found) return { code: s.code, stdout: s.body, stderr: r.stderr, sentinel: true };
    this.throwIfTransportFailure(r.code, r.stderr, r.stdout.length > 0);
    return { code: r.code ?? 255, stdout: r.stdout, stderr: r.stderr, sentinel: false };
  }

  private throwIfTransportFailure(code: number | null, stderr: string, hadStdout: boolean): void {
    const c = classifySshFailure(code, stderr, hadStdout);
    const brief = stderr.trim().split("\n").slice(-3).join(" | ") || `ssh exit ${code}`;
    switch (c.type) {
      case "hostKeyChanged": {
        const where = c.file ? `${c.file}:${c.line ?? "?"}` : "known_hosts";
        const fix = hostKeyFixCommand(this.target, c.file);
        throw new HostKeyError(
          `host key for ${this.label} CHANGED (offending entry ${where}). If the host was legitimately reinstalled run: ${fix}`,
          { ...(c.file !== undefined ? { file: c.file } : {}), ...(c.line !== undefined ? { line: c.line } : {}), fix },
        );
      }
      case "hostKeyUnknown":
        throw new HostKeyError(
          `host key verification failed for ${this.label} under --host-key strict; add it to your known_hosts or use --host-key accept-new`,
        );
      case "auth":
        throw new AuthError(`authentication refused by ${this.label}: ${brief}`);
      case "transport":
        throw new TransportError(`ssh ${this.label}: ${brief}`, c.phase);
      case "none":
        return;
    }
  }

  async fetch(from: string, toDir: string, via: "scp" | "rsync" = "scp"): Promise<string[]> {
    const files = await this.listGlob(from);
    if (files.length === 0) throw new FetchFailure(`no file matches ${from} on ${this.label}`);
    const dir = resolve(toDir);
    mkdirSync(dir, { recursive: true });
    const sources = files.map((f) => `${this.dest}:${f}`);
    const r =
      via === "rsync"
        ? await spawnCapture(this.bin.rsync, ["-az", "-e", this.rsyncRsh(), ...sources, dir + "/"], { timeoutMs: 0 })
        : await spawnCapture(this.bin.scp, [...this.scpArgv(), ...sources, dir + "/"], { timeoutMs: 0 });
    if (r.spawnError) throw new Error(`cannot spawn ${via}: ${r.spawnError.message}`);
    if (r.code !== 0) {
      this.throwIfTransportFailure(r.code, r.stderr, false);
      throw new FetchFailure(`${via} exit ${r.code}: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
    }
    return files.map((f) => join(dir, basename(f)));
  }
}
