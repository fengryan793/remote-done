import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PRUNE_AFTER_MS = 7 * 86_400_000;

export function cacheDir(): string {
  return (
    process.env.REMOTE_DONE_CACHE_DIR ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "remote-done")
  );
}

export function knownHostsDir(): string {
  return (
    process.env.REMOTE_DONE_KNOWN_HOSTS_DIR ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "remote-done", "known_hosts.d")
  );
}

export interface StateFile {
  id: string;
  pid: number;
  startedAt: string;
  deadline?: string;
  target: string;
  until: unknown;
  teardown: string[];
  fetch: unknown;
  finished?: { status: string; exitCode: number; at: string };
}

export function statePath(id: string): string {
  return join(cacheDir(), `${id}.json`);
}

export function writeState(s: StateFile): string {
  const dir = cacheDir();
  try {
    mkdirSync(dir, { recursive: true });
    const p = statePath(s.id);
    writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
    return p;
  } catch {
    return "";
  }
}

export function finishState(id: string, finished: NonNullable<StateFile["finished"]>): void {
  try {
    const p = statePath(id);
    const s = JSON.parse(readFileSync(p, "utf8")) as StateFile;
    s.finished = finished;
    writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
  } catch {
    /* best effort */
  }
}

/** Delete state and known_hosts files older than a week. */
export function pruneOld(now = Date.now()): void {
  for (const dir of [cacheDir(), knownHostsDir()]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(dir, n);
      try {
        if (now - statSync(p).mtimeMs > PRUNE_AFTER_MS) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

export function newRunId(): string {
  const t = new Date();
  const stamp = t.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}
