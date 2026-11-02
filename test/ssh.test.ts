/**
 * Integration tests against a real sshd. Opt in with RD_TEST_SSH=1; the host defaults to
 * localhost (CI enables key auth to it) and can be changed with RD_TEST_SSH_HOST=user@host[:port].
 * Every remote recipe (sentinel, stat/tail dialect, pgrep, run, scp) is exercised here.
 */
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { remoteDone } from "../src/engine.js";
import { conditions as c, parseSshDestination } from "../src/index.js";
import { runCondition, startDetached } from "../src/run.js";
import { SshTransport } from "../src/transport/ssh.js";
import { tmp } from "./helpers.js";

const enabled = process.env.RD_TEST_SSH === "1";
const dest = parseSshDestination(process.env.RD_TEST_SSH_HOST ?? "localhost");
const d = describe.skipIf(!enabled);

const local = tmp("rd-ssh-local-");
const remoteDir = `/tmp/rd-ssh-test-${process.pid}-${Date.now()}`;
const target = { kind: "ssh" as const, ...dest, hostKey: "accept-new" as const };
const transport = new SshTransport(target, { runId: `t${process.pid}`, knownHostsDir: local.path("kh"), defaultTimeoutMs: 60_000 });

afterAll(async () => {
  if (enabled) await transport.exec(`rm -rf ${remoteDir}`);
  local.cleanup();
});

d("SshTransport against a real sshd", () => {
  it("exec carries the remote exit code through the sentinel", async () => {
    const r = await transport.exec(`mkdir -p ${remoteDir} && echo hi && exit 7`);
    expect(r.sentinel).toBe(true);
    expect(r.code).toBe(7);
    expect(r.stdout).toBe("hi\n");
    const uname = await transport.exec("uname -s");
    expect(uname.code).toBe(0);
  });

  it("stat + tail recipes work on the remote dialect", async () => {
    const f = `${remoteDir}/a.log`;
    await transport.exec(`printf 'one\\ntwo\\n' > ${f}`);
    const st = await transport.stat(f);
    expect(st.exists).toBe(true);
    expect(st.size).toBe(8);
    const tail = await transport.readTail(f, 4, 1000);
    expect(tail.bytes.toString()).toBe("two\n");
    expect(tail.size).toBe(8);
    expect((await transport.stat(`${remoteDir}/nope`)).exists).toBe(false);
  });

  it("processAlive with pid and pattern; listGlob; totalBytes", async () => {
    const start = await transport.exec(`nohup sleep 20 </dev/null >/dev/null 2>&1 & echo $!`);
    const pid = Number(start.stdout.trim());
    expect(await transport.processAlive({ pid })).toBe(true);
    expect(await transport.processAlive({ pattern: "sleep 20" })).toBe(true);
    await transport.exec(`kill ${pid}`);
    await new Promise((r) => setTimeout(r, 500));
    expect(await transport.processAlive({ pid })).toBe(false);
    await transport.exec(`printf abc > ${remoteDir}/x.mp4; printf de > ${remoteDir}/y.mp4`);
    expect((await transport.listGlob(`${remoteDir}/*.mp4`)).sort()).toEqual([`${remoteDir}/x.mp4`, `${remoteDir}/y.mp4`]);
    expect(await transport.listGlob(`${remoteDir}/*.none`)).toEqual([]);
    expect(await transport.totalBytes(`${remoteDir}/*.mp4`)).toBe(5);
    expect(await transport.totalBytes(`${remoteDir}/*.none`)).toBeUndefined();
  });

  it("fetch via scp copies the matches; an empty glob is a FetchFailure", async () => {
    const files = await transport.fetch(`${remoteDir}/*.mp4`, local.path("dl"));
    expect(files.map((f) => f.split("/").pop()).sort()).toEqual(["x.mp4", "y.mp4"]);
    expect(readFileSync(local.path("dl/x.mp4"), "utf8")).toBe("abc");
    await expect(transport.fetch(`${remoteDir}/*.none`, local.path("dl"))).rejects.toThrow(/no file matches/);
  });

  it("run + wait end-to-end over ssh, with fetch and teardown", async () => {
    const log = `${remoteDir}/job.log`;
    const started = await startDetached(transport, `echo working; sleep 1; echo DONE > ${remoteDir}/result.txt; exit 0`, log);
    expect(started.pid).toBeGreaterThan(0);
    const result = await remoteDone(
      {
        target,
        until: runCondition(started, { fail: /Traceback/ }),
        interval: "500ms",
        timeout: "60s",
        fetch: [{ from: `${remoteDir}/result.txt`, to: local.path("dl2") }],
        teardown: ["true"],
      },
      { transport, stateFile: false },
    );
    expect(result.status).toBe("done");
    expect(result.exitCode).toBe(0);
    expect(result.teardownRan).toBe(true);
    expect(readFileSync(local.path("dl2/result.txt"), "utf8")).toBe("DONE\n");
  });

  it("every: copies partial outputs while the job runs", async () => {
    const log = `${remoteDir}/every.log`;
    const started = await startDetached(transport, `echo one > ${remoteDir}/ckpt-1.txt; sleep 4; echo two > ${remoteDir}/ckpt-2.txt`, log);
    let partial = false;
    const result = await remoteDone(
      {
        target,
        until: runCondition(started),
        interval: "300ms",
        timeout: "60s",
        every: { interval: "1s" },
        fetch: [{ from: `${remoteDir}/ckpt-*.txt`, to: local.path("dl3") }],
      },
      {
        transport,
        stateFile: false,
        onEvent: (e) => {
          if (e.type === "tick" && e.files === 1) partial = true;
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(partial).toBe(true);
    expect(readFileSync(local.path("dl3/ckpt-2.txt"), "utf8")).toBe("two\n");
  });

  it("a failing remote job is fail (exit 1), not exited", async () => {
    const log = `${remoteDir}/bad.log`;
    const started = await startDetached(transport, `echo nope; exit 9`, log);
    const result = await remoteDone({ target, until: runCondition(started), interval: "300ms", timeout: "30s" }, { transport, stateFile: false });
    expect(result.status).toBe("fail");
    expect(result.matched).toBe("rc=9");
  });

  it("log condition over ssh sees appended lines", async () => {
    const log = `${remoteDir}/tail.log`;
    await transport.exec(`: > ${log}; (sleep 1; echo step; echo 完成 DONE >> ${log}) </dev/null >/dev/null 2>&1 &`);
    const result = await remoteDone({ target, until: c.log(log, { done: /DONE/ }), interval: "300ms", timeout: "30s" }, { transport, stateFile: false });
    expect(result.status).toBe("done");
    expect(result.matched).toBe("完成 DONE");
  });
});
