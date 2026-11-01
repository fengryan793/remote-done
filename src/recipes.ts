/**
 * POSIX sh recipes executed on the target (locally through `sh -c`, remotely through ssh).
 * Every recipe works on both GNU (coreutils) and BSD (macOS) userlands: the stat dialect is
 * picked by an inline fallback, never a hard-coded format.
 *
 * Keep each recipe a single script so one transport call = one poll.
 */
import { shq } from "./shell.js";
import type { StatResult, TailResult } from "./types.js";

export const STAT_MARK = "__RD_STAT";

/**
 * Size-first, bounded tail. Prints one header line then at most `maxBytes` raw bytes:
 *   __RD_STAT missing
 *   __RD_STAT <ino> <dev> <size>\n<bytes>
 * Bytes start at `offset` (0-based). When the file shrank below `offset` no bytes are printed.
 */
export function tailScript(path: string, offset: number, maxBytes: number): string {
  const f = shq(path);
  return [
    `F=${f}; N=${Math.max(0, Math.floor(offset))}; M=${Math.max(0, Math.floor(maxBytes))}`,
    `if [ ! -f "$F" ]; then printf '${STAT_MARK} missing\\n'; exit 0; fi`,
    `S=$(stat -c %s "$F" 2>/dev/null || stat -f %z "$F") || exit 3`,
    `I=$(stat -c '%i %d' "$F" 2>/dev/null || stat -f '%i %d' "$F") || exit 3`,
    `printf '${STAT_MARK} %s %s\\n' "$I" "$S"`,
    `if [ "$M" -gt 0 ] && [ "$S" -gt "$N" ]; then L=$((S-N)); [ "$L" -gt "$M" ] && L=$M; tail -c +$((N+1)) "$F" | head -c "$L"; fi`,
    `exit 0`,
  ].join("\n");
}

export function parseTailOutput(buf: Buffer): TailResult {
  const nl = buf.indexOf(0x0a);
  const header = (nl === -1 ? buf : buf.subarray(0, nl)).toString("utf8").trim();
  if (!header.startsWith(STAT_MARK)) {
    throw new Error(`tail recipe: unexpected output ${JSON.stringify(header.slice(0, 120))}`);
  }
  const parts = header.split(/\s+/);
  if (parts[1] === "missing") return { exists: false, ino: "", size: 0, bytes: Buffer.alloc(0) };
  const ino = `${parts[1]}:${parts[2]}`;
  const size = Number(parts[3]);
  if (!Number.isFinite(size)) throw new Error(`tail recipe: bad size in ${JSON.stringify(header)}`);
  const bytes = nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1);
  return { exists: true, ino, size, bytes: Buffer.from(bytes) };
}

/** Prints `__RD_STAT <ino> <dev> <size> <mtime-epoch>` or `__RD_STAT missing`. */
export function statScript(path: string): string {
  const f = shq(path);
  return [
    `F=${f}`,
    `if [ ! -e "$F" ]; then printf '${STAT_MARK} missing\\n'; exit 0; fi`,
    `stat -c '${STAT_MARK} %i %d %s %Y' "$F" 2>/dev/null || stat -f '${STAT_MARK} %i %d %z %m' "$F"`,
  ].join("\n");
}

export function parseStatOutput(out: string): StatResult {
  const line = out.split("\n").find((l) => l.startsWith(STAT_MARK));
  if (!line) throw new Error(`stat recipe: unexpected output ${JSON.stringify(out.slice(0, 120))}`);
  const parts = line.trim().split(/\s+/);
  if (parts[1] === "missing") return { exists: false, ino: "", size: 0, mtimeMs: 0 };
  return {
    exists: true,
    ino: `${parts[1]}:${parts[2]}`,
    size: Number(parts[3]),
    mtimeMs: Number(parts[4]) * 1000,
  };
}

/**
 * Exit 0 when the process is alive, 1 when gone. `ps -p` (not `kill -0`) so a pid owned by
 * another user is still visible. For patterns the shells that carry the pattern on their own
 * command line ($$ and its parent) are excluded, so `pgrep -f 'python train.py'` does not
 * match the probe itself; the `[p]ython` idiom still works and is still recommended.
 */
export function processAliveScript(sel: { pid?: number; pattern?: string }): string {
  if (sel.pid !== undefined) {
    return `ps -p ${Math.floor(sel.pid)} -o pid= >/dev/null 2>&1`;
  }
  if (sel.pattern !== undefined) {
    // no $(...) subshell here: a forked subshell would carry the pattern on its own cmdline
    return `pgrep -f -- ${shq(sel.pattern)} 2>/dev/null | grep -vqx -e $$ -e $PPID`;
  }
  throw new Error("processAliveScript: pid or pattern required");
}

/** Exit 0 when something answers on host:port (nc, then bash /dev/tcp as a fallback). */
export function portOpenScript(port: number, host = "127.0.0.1"): string {
  const h = shq(host);
  const p = Math.floor(port);
  return [
    `if command -v nc >/dev/null 2>&1; then nc -z -w 3 ${h} ${p} >/dev/null 2>&1; exit $?; fi`,
    `if command -v bash >/dev/null 2>&1; then bash -c 'exec 3<>/dev/tcp/'${h}'/'${p} >/dev/null 2>&1; exit $?; fi`,
    `exit 2`,
  ].join("\n");
}

/** One matched path per line; nothing (exit 0) when the glob matches nothing. */
export function listGlobScript(glob: string): string {
  // `set -- GLOB` expands the pattern; an unmatched pattern stays literal, hence the -e test.
  return `set -- ${glob}; for f in "$@"; do [ -e "$f" ] && printf '%s\\n' "$f"; done; exit 0`;
}

/** Total byte size of every match (regular files only); prints nothing when none match. */
export function totalBytesScript(glob: string): string {
  return [
    `set -- ${glob}; T=0; N=0`,
    `for f in "$@"; do [ -f "$f" ] || continue; S=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f") || continue; T=$((T+S)); N=$((N+1)); done`,
    `[ "$N" -gt 0 ] && printf '%s\\n' "$T"; exit 0`,
  ].join("\n");
}

/** `cat FILE` when it exists; prints `__RD_ABSENT` otherwise. */
export function catOrAbsentScript(path: string): string {
  return `if [ -f ${shq(path)} ]; then cat ${shq(path)}; else printf '__RD_ABSENT'; fi`;
}

export interface RunStartPaths {
  log: string;
  pid: string;
  rc: string;
}

export function runPaths(log: string): RunStartPaths {
  return { log, pid: `${log}.pid`, rc: `${log}.rc` };
}

/**
 * Detached start. The wrapper writes its own pid to <log>.pid as its first action, so a
 * probe after a lost connection can tell whether the job started. Prints the wrapper pid.
 *   nohup sh -c 'echo $$ > LOG.pid; ( CMD ) > LOG 2>&1; echo $? > LOG.rc' </dev/null >/dev/null 2>&1 & echo $!
 */
export function runStartScript(cmd: string, log: string): string {
  const p = runPaths(log);
  const inner = `echo $$ > ${shq(p.pid)}; ( ${cmd}\n) > ${shq(p.log)} 2>&1; echo $? > ${shq(p.rc)}`;
  return [
    `rm -f ${shq(p.rc)} ${shq(p.pid)}`,
    `: > ${shq(p.log)} || exit 3`,
    `nohup sh -c ${shq(inner)} </dev/null >/dev/null 2>&1 &`,
    `echo $!`,
  ].join("\n");
}

/** Arms `sleep N && CMD` detached; prints its pid. */
export function deadmanArmScript(cmd: string, seconds: number): string {
  const inner = `sleep ${Math.max(1, Math.floor(seconds))} && ( ${cmd}\n)`;
  return `nohup sh -c ${shq(inner)} </dev/null >/dev/null 2>&1 & echo $!`;
}

export function killScript(pid: number): string {
  return `kill ${Math.floor(pid)} >/dev/null 2>&1; exit 0`;
}
