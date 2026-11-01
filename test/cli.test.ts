import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";
import { tmp, wait } from "./helpers.js";

let t: ReturnType<typeof tmp>;
beforeEach(() => (t = tmp()));
afterEach(() => t.cleanup());

describe("parseCli", () => {
  it("builds a log condition with ssh target and fetch/hook flags", () => {
    const p = parseCli([
      "--ssh", "root@1.2.3.4:22011", "-i", "~/.ssh/k", "--host-key", "insecure", "--ssh-arg=-oProxyJump=b",
      "--log", "/w/run.log", "--done", "DONE", "--fail", "ERROR|Traceback",
      "--interval", "30s", "--timeout", "2h", "--stall", "20m",
      "--fetch", "/w/out/*.mp4:./dl", "--fetch", "/w/log.txt", "--to", "./other", "--rsync",
      "--teardown", "runpodctl stop pod $POD", "--on-fail", "ntfy", "--notify", "ntfy://ntfy.sh/x",
      "--profile", "pod", "--json",
    ]);
    expect(p.mode).toBe("wait");
    expect(p.spec.target).toEqual({ kind: "ssh", host: "1.2.3.4", user: "root", port: 22011, identity: "~/.ssh/k", hostKey: "insecure", sshArgs: ["-oProxyJump=b"] });
    expect(p.spec.until).toMatchObject({ kind: "log", path: "/w/run.log" });
    expect((p.spec.until as { done: RegExp }).done.source).toBe("DONE");
    expect(p.spec.fetch).toEqual([
      { from: "/w/out/*.mp4", to: "./dl", via: "rsync" },
      { from: "/w/log.txt", to: "./other", via: "rsync" },
    ]);
    expect(p.spec.teardown).toEqual(["runpodctl stop pod $POD"]);
    expect(p.spec.onFail).toEqual(["ntfy"]);
    expect(p.spec.notify).toEqual(["ntfy://ntfy.sh/x"]);
    expect(p.spec.teardownOn).toEqual(["all"]);
    expect(p.spec.fetchOn).toEqual(["all"]);
    expect(p.spec.forceTeardownAfter).toBe(5);
    expect(p.json).toBe(true);
  });

  it("several conditions combine with all (or any)", () => {
    const a = parseCli(["--exit-file", "/r", "--file", "/o.mp4", "--stable", "30s"]);
    expect(a.spec.until).toMatchObject({ kind: "all" });
    const b = parseCli(["--any", "--port", "8188", "--http", "http://x/", "--status", "200,204"]);
    expect(b.spec.until).toMatchObject({ kind: "any", conditions: [{ kind: "port", port: 8188 }, { kind: "http", status: [200, 204] }] });
    const c = parseCli(["--process", "1234", "--exit-file", "/tmp/x.rc"]);
    expect(c.spec.until).toEqual({ kind: "process", pid: 1234, exitFile: "/tmp/x.rc" });
    const d = parseCli(["--process", "[p]ython train.py"]);
    expect(d.spec.until).toEqual({ kind: "process", pattern: "[p]ython train.py" });
  });

  it("run mode takes the command after --", () => {
    const p = parseCli(["run", "--ssh", "gpu", "--log", "/tmp/j.log", "--fail", "Traceback", "--", "python", "train.py", "--lr", "0.1"]);
    expect(p.mode).toBe("run");
    expect(p.command).toBe("python train.py --lr 0.1");
    expect(p.markers.fail?.source).toBe("Traceback");
    const q = parseCli(["run", "--log", "/tmp/j.log", "--stall", "10m", "--", "python", "x.py"]);
    expect(q.spec.progressLog).toBe("/tmp/j.log"); // the job log is the stall source
  });

  it("rejects bad arguments with SpecError", () => {
    expect(() => parseCli([])).toThrow(/no condition/);
    expect(() => parseCli(["--log", "/x"])).toThrow(/--done/);
    expect(() => parseCli(["--done", "D"])).toThrow(/--log/);
    expect(() => parseCli(["--exit-file", "/r", "--stall", "5m"])).toThrow(/stall/);
    expect(() => parseCli(["--exit-file", "/r", "--bogus"])).toThrow();
    expect(() => parseCli(["--exit-file", "/r", "--host-key", "strict"])).toThrow(/need --ssh/);
    expect(() => parseCli(["--ssh", "h", "--host-key", "maybe", "--exit-file", "/r"])).toThrow(/host-key/);
    expect(() => parseCli(["--log", "/x", "--done", "("])).toThrow(/invalid regex/);
    expect(() => parseCli(["--exit-file", "/r", "--profile", "vm"])).toThrow(/profile/);
    expect(() => parseCli(["--exit-file", "/r", "--timeout", "soon"])).toThrow(/timeout/);
    expect(() => parseCli(["run", "--log", "/l"])).toThrow(/after `--`/);
    expect(() => parseCli(["run", "--", "cmd"])).toThrow(/--log/);
    expect(() => parseCli(["--ssh", "abc-123.ssh.runpod.io", "--exit-file", "/r"])).toThrow(/runpod/i);
    expect(() => parseCli(["--exit-file", "/r", "extra"])).toThrow(/unexpected argument/);
  });
});

function cli(args: string[], opts: { signalAfterMs?: number; signal?: NodeJS.Signals } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (opts.signalAfterMs) setTimeout(() => child.kill(opts.signal ?? "SIGTERM"), opts.signalAfterMs);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("built CLI end-to-end (dist/cli.js)", () => {
  it("--help and --version", async () => {
    expect((await cli(["--help"])).stdout).toMatch(/USAGE/);
    expect((await cli(["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("bad args exit 64", async () => {
    const r = await cli(["--nope"]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/remote-done:/);
  });

  it("--dry-run prints the resolved spec", async () => {
    const r = await cli(["--dry-run", "--log", "/x", "--done", "D", "--profile", "pod"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.spec.teardownOn).toEqual(["all"]);
  });

  it("waits for a DONE line, exit 0, human summary on stdout, poll lines on stderr", async () => {
    const log = t.path("j.log");
    writeFileSync(log, "");
    setTimeout(() => appendFileSync(log, "working\nDONE\n"), 700);
    const r = await cli(["--log", log, "--done", "DONE", "--interval", "200ms", "--timeout", "20s"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^done · .* · DONE · exit 0$/);
    expect(r.stderr).toMatch(/\] /);
  });

  it("--json emits NDJSON only on stdout and exit 1 on a fail marker", async () => {
    const log = t.path("j.log");
    writeFileSync(log, "Traceback\n");
    const r = await cli(["--json", "--log", log, "--done", "DONE", "--fail", "Traceback", "--from-start", "--interval", "100ms"]);
    expect(r.code).toBe(1);
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].type).toBe("start");
    expect(lines.at(-1).type).toBe("result");
    expect(lines.at(-1).result.status).toBe("fail");
  });

  it("SIGTERM -> onAbort hook, exit 143", async () => {
    const log = t.path("j.log");
    writeFileSync(log, "");
    const flag = t.path("aborted");
    const r = await cli(["--log", log, "--done", "DONE", "--interval", "100ms", "--on-abort", `touch ${flag}`, "--on-fail", `touch ${flag}.fail`], { signalAfterMs: 800 });
    expect(r.code).toBe(143);
    expect(existsSync(flag)).toBe(true);
    expect(existsSync(`${flag}.fail`)).toBe(false);
  });

  it("run: starts the command detached, waits on <log>.rc, fetches, exit code follows the job", async () => {
    const log = t.path("run.log");
    const out = t.path("out.txt");
    const ok = await cli(["run", "--log", log, "--interval", "100ms", "--fetch", `${out}:${t.path("dl")}`, "--", `echo hello > ${out}; echo finished; exit 0`]);
    expect(ok.code).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("finished\n");
    expect(readFileSync(t.path("dl/out.txt"), "utf8")).toBe("hello\n");
    const bad = await cli(["run", "--log", log, "--interval", "100ms", "--", "echo oops; exit 2"]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/rc=2/);
    const early = await cli(["run", "--log", log, "--interval", "100ms", "--fail", "FATAL", "--", "echo FATAL; sleep 5"]);
    expect(early.code).toBe(1);
    expect(early.stdout).toMatch(/FATAL/);
    await wait(100);
  });

  it("exit 2 on timeout, exit 64 when stall has no source", async () => {
    const log = t.path("j.log");
    writeFileSync(log, "");
    const r = await cli(["--log", log, "--done", "DONE", "--interval", "100ms", "--timeout", "500ms"]);
    expect(r.code).toBe(2);
    expect((await cli(["--exit-file", "/nope", "--stall", "1m"])).code).toBe(64);
  });
});
