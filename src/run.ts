/**
 * `run`: start a command detached on the target and return what to wait on.
 * Idempotency rule (Plan v2.1): a start whose sentinel was lost in flight is never re-executed
 * blindly - the engine probes `<log>.pid` (or `idempotencyCheck`) first.
 */
import { DEFAULTS } from "./engine.js";
import { runPaths, runStartScript } from "./recipes.js";
import { shq } from "./shell.js";
import { TransportError, type Condition, type Event, type Transport } from "./types.js";

export interface StartOptions {
  idempotencyCheck?: string;
  unreachableAfterMs?: number;
  onEvent?: (e: Event) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface Started {
  /** wrapper pid when known */
  pid?: number;
  log: string;
  rcFile: string;
  pidFile: string;
  /** true when a probe found the job already running after a lost sentinel */
  adopted: boolean;
}

export async function startDetached(transport: Transport, cmd: string, log: string, opts: StartOptions = {}): Promise<Started> {
  const paths = runPaths(log);
  const emit = opts.onEvent ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.unreachableAfterMs ?? DEFAULTS.unreachableAfterMs);
  let attempt = 0;
  let needProbe = false;

  const backoff = async (err: string): Promise<void> => {
    attempt++;
    const delay = Math.min(DEFAULTS.reconnectMinMs * 2 ** (attempt - 1), DEFAULTS.reconnectMaxMs);
    emit({ type: "reconnect", attempt, delayMs: delay, error: err, downMs: 0 });
    if (now() + delay > deadline) throw new TransportError(`target unreachable while starting the job: ${err}`, "connect");
    await sleep(delay);
  };

  for (;;) {
    if (needProbe) {
      try {
        await sleep(2000);
        const found = await probe(transport, paths.pid, opts.idempotencyCheck);
        if (found.started) {
          emit({ type: "warn", message: `connection dropped after starting the job; adopted the running job${found.pid ? ` (pid ${found.pid})` : ""}` });
          return { ...(found.pid !== undefined ? { pid: found.pid } : {}), log: paths.log, rcFile: paths.rc, pidFile: paths.pid, adopted: true };
        }
        needProbe = false; // nothing started: safe to run the start again
      } catch (e) {
        if (!(e instanceof TransportError)) throw e;
        await backoff(e.message);
        continue;
      }
    }
    try {
      const r = await transport.exec(runStartScript(cmd, log));
      if (!r.sentinel) {
        needProbe = true;
        continue;
      }
      if (r.code !== 0) throw new Error(`could not start the job on ${transport.label} (exit ${r.code}): ${r.stderr.trim()}`);
      const pid = Number(r.stdout.trim());
      if (!Number.isFinite(pid) || pid <= 0) throw new Error(`start returned no pid: ${JSON.stringify(r.stdout)}`);
      return { pid, log: paths.log, rcFile: paths.rc, pidFile: paths.pid, adopted: false };
    } catch (e) {
      if (!(e instanceof TransportError)) throw e;
      // connect-phase failures never ran anything; session/timeout failures might have
      needProbe = e.phase !== "connect";
      await backoff(e.message);
    }
  }
}

async function probe(transport: Transport, pidFile: string, check: string | undefined): Promise<{ started: boolean; pid?: number }> {
  if (check) {
    const r = await transport.exec(check);
    if (r.code === 0) {
      const pid = await readPid(transport, pidFile);
      return { started: true, ...(pid !== undefined ? { pid } : {}) };
    }
    return { started: false };
  }
  const pid = await readPid(transport, pidFile);
  return pid !== undefined ? { started: true, pid } : { started: false };
}

async function readPid(transport: Transport, pidFile: string): Promise<number | undefined> {
  const r = await transport.exec(`if [ -f ${shq(pidFile)} ]; then cat ${shq(pidFile)}; else printf '__RD_ABSENT'; fi`);
  if (r.stdout === "__RD_ABSENT") return undefined;
  const pid = Number(r.stdout.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/** Build the condition to wait on after `startDetached`. */
export function runCondition(st: Started, markers: { done?: RegExp; fail?: RegExp } = {}): Condition {
  const primary: Condition =
    st.pid !== undefined ? { kind: "process", pid: st.pid, exitFile: st.rcFile } : { kind: "exitFile", path: st.rcFile };
  if (!markers.done && !markers.fail) return primary;
  const log: Condition = {
    kind: "log",
    path: st.log,
    fromStart: true,
    ...(markers.done ? { done: markers.done } : {}),
    ...(markers.fail ? { fail: markers.fail } : {}),
  };
  return { kind: "any", conditions: [primary, log] };
}
