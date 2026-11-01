import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remoteDone, watch } from "../src/engine.js";
import { conditions as c } from "../src/index.js";
import { HostKeyError, TransportError, type Event, type Spec } from "../src/types.js";
import { FakeTransport, tmp, virtualClock } from "./helpers.js";

let t: ReturnType<typeof tmp>;
beforeEach(() => {
  t = tmp();
  process.env.REMOTE_DONE_CACHE_DIR = t.path("cache");
  process.env.REMOTE_DONE_KNOWN_HOSTS_DIR = t.path("kh");
});
afterEach(() => t.cleanup());

function collect(): { events: Event[]; onEvent: (e: Event) => void } {
  const events: Event[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

/** Run with a virtual clock and a fake transport; `script` runs between polls. */
async function run(spec: Spec, opts: { transport?: FakeTransport; onPoll?: (n: number) => void } = {}) {
  const clock = virtualClock();
  const { events, onEvent } = collect();
  let polls = 0;
  const transport = opts.transport ?? new FakeTransport();
  const result = await remoteDone(spec, {
    transport,
    now: clock.now,
    sleep: clock.sleep,
    onEvent: (e) => {
      onEvent(e);
      if (e.type === "poll") opts.onPoll?.(++polls);
    },
  });
  return { result, events, transport, clock };
}

describe("engine terminal pipeline", () => {
  it("done -> fetch -> onDone -> teardown -> notify, exit 0, hooks get the contract", async () => {
    const log = t.path("job.log");
    writeFileSync(log, "");
    writeFileSync(t.path("out1.mp4"), "video");
    const dl = t.path("dl");
    const envDump = t.path("env.txt");
    const { result, events } = await run(
      {
        until: c.log(log, { done: /DONE/, fail: /ERR/ }),
        interval: 10,
        fetch: [{ from: t.path("*.mp4"), to: dl }],
        onDone: [`env | grep ^RD_ > ${envDump}; cat "$RD_CTX_FILE" > ${envDump}.ctx; read x </dev/stdin || echo STDIN_EOF >> ${envDump}`],
        teardown: ["echo torn-down"],
        notify: [`echo notified >> ${envDump}`],
      },
      { onPoll: (n) => n === 2 && appendFileSync(log, "step\nDONE\n") },
    );
    expect(result.status).toBe("done");
    expect(result.exitCode).toBe(0);
    expect(result.matched).toBe("DONE");
    expect(result.fetched).toEqual([`${dl}/out1.mp4`]);
    expect(readFileSync(`${dl}/out1.mp4`, "utf8")).toBe("video");
    expect(result.teardownRan).toBe(true);
    expect(result.hooks.map((h) => h.phase)).toEqual(["onDone", "teardown", "notify"]);
    expect(result.hooks.every((h) => h.exitCode === 0)).toBe(true);
    const env = readFileSync(envDump, "utf8");
    expect(env).toContain("RD_STATUS=done");
    expect(env).toContain("RD_MATCH=DONE");
    expect(env).toContain("RD_FETCH_OK=1");
    expect(env).toContain(`RD_FETCHED=${dl}/out1.mp4`);
    expect(env).toContain("STDIN_EOF"); // stdin is /dev/null
    expect(env).toContain("notified");
    expect(JSON.parse(readFileSync(`${envDump}.ctx`, "utf8")).phase).toBe("onDone");
    expect(events.map((e) => e.type)).toContain("matched");
    const teardownHook = result.hooks.find((h) => h.phase === "teardown");
    expect(teardownHook?.output?.trim()).toBe("torn-down");
    // state file written and finished
    const files = readdirSync(t.path("cache"));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(t.path(`cache/${files[0]}`), "utf8")).finished.status).toBe("done");
  });

  it("empty fetch glob: status done, exit 4, teardown skipped and reported as pending", async () => {
    const log = t.path("job.log");
    writeFileSync(log, "DONE\n");
    const { result, events } = await run({
      until: c.log(log, { done: "DONE", fromStart: true }),
      interval: 10,
      fetch: [{ from: t.path("nothing-*.mp4"), to: t.path("dl") }],
      teardown: ["runpodctl stop pod X"],
      onDone: ["true"],
    });
    expect(result.status).toBe("done");
    expect(result.fetchOk).toBe(false);
    expect(result.exitCode).toBe(4);
    expect(result.teardownRan).toBe(false);
    expect(result.pendingTeardown).toEqual(["runpodctl stop pod X"]);
    expect(result.fetchErrors[0]?.error).toMatch(/no file matches/);
    expect(events.filter((e) => e.type === "fetch")).toHaveLength(5); // retried
    expect(events.some((e) => e.type === "warn" && /teardown NOT run/.test(e.message))).toBe(true);
  });

  it("forceTeardown runs teardown despite a failed fetch (still exit 4)", async () => {
    const log = t.path("job.log");
    writeFileSync(log, "DONE\n");
    const { result } = await run({
      until: c.log(log, { done: "DONE", fromStart: true }),
      interval: 10,
      fetch: [{ from: t.path("nothing-*"), to: t.path("dl") }],
      teardown: ["true"],
      forceTeardown: true,
    });
    expect(result.exitCode).toBe(4);
    expect(result.teardownRan).toBe(true);
  });

  it("fail: onFail runs, teardown only with teardownOn; exit 1", async () => {
    const log = t.path("job.log");
    writeFileSync(log, "");
    const a = await run(
      { until: c.log(log, { done: /DONE/, fail: /Traceback/ }), interval: 10, onFail: ["true"], teardown: ["true"] },
      { onPoll: (n) => n === 1 && appendFileSync(log, "Traceback (most recent call last)\n") },
    );
    expect(a.result.status).toBe("fail");
    expect(a.result.exitCode).toBe(1);
    expect(a.result.teardownRan).toBe(false);
    expect(a.result.hooks.map((h) => h.phase)).toEqual(["onFail"]);
    const b = await run({ until: c.log(log, { done: /DONE/, fail: /Traceback/, fromStart: true }), interval: 10, teardown: ["true"], teardownOn: ["done", "fail"] });
    expect(b.result.teardownRan).toBe(true);
  });

  it("--profile pod semantics: teardownOn all + fetchOn all tears down on timeout after a best-effort fetch", async () => {
    const log = t.path("job.log");
    writeFileSync(log, "");
    writeFileSync(t.path("partial.mp4"), "x");
    const { result } = await run({
      until: c.log(log, { done: /DONE/ }),
      interval: 10,
      timeout: 35,
      fetch: [{ from: t.path("*.mp4"), to: t.path("dl") }],
      fetchOn: ["all"],
      teardown: ["true"],
      teardownOn: ["all"],
      onTimeout: ["true"],
    });
    expect(result.status).toBe("timeout");
    expect(result.exitCode).toBe(2);
    expect(result.fetched).toHaveLength(1);
    expect(result.hooks.map((h) => h.phase)).toEqual(["onTimeout", "teardown"]);
  });

  it("timeout still honours an unterminated DONE in the carry buffer", async () => {
    const log = t.path("job.log");
    writeFileSync(log, "");
    const { result } = await run(
      { until: c.log(log, { done: /DONE/ }), interval: 10, timeout: 25 },
      { onPoll: (n) => n === 2 && appendFileSync(log, "DONE") },
    );
    expect(result.status).toBe("done");
  });

  it("stall: no change key movement for `stall` -> status stalled, exit 5, notify only", async () => {
    const log = t.path("job.log");
    writeFileSync(log, "started\n");
    const { result, events } = await run({
      until: c.log(log, { done: /DONE/ }),
      interval: 10,
      stall: 50,
      onFail: ["echo SHOULD-NOT-RUN"],
      notify: ["true"],
    });
    expect(result.status).toBe("stalled");
    expect(result.exitCode).toBe(5);
    expect(result.hooks.map((h) => h.phase)).toEqual(["notify"]);
    expect(events.filter((e) => e.type === "poll").length).toBeGreaterThanOrEqual(5);
  });

  it("stall is rejected without a change source (SpecError)", async () => {
    await expect(remoteDone({ until: c.exitFile(t.path("rc")), stall: 1000 }, { stateFile: false })).rejects.toThrow(/stall/);
  });

  it("exited: process gone without exit info -> exit 6, onFail does not run", async () => {
    const { result } = await run({ until: c.process({ pid: 2_000_000_000 }), interval: 10, onFail: ["echo no"], notify: ["true"] });
    expect(result.status).toBe("exited");
    expect(result.exitCode).toBe(6);
    expect(result.hooks.map((h) => h.phase)).toEqual(["notify"]);
  });

  it("transport errors: reconnect with backoff, then continue; stall clock frozen while down", async () => {
    const log = t.path("job.log");
    writeFileSync(log, "");
    const transport = new FakeTransport();
    let injected = false;
    const { result, events } = await run(
      { until: c.log(log, { done: /DONE/ }), interval: 10, stall: 100_000 },
      {
        transport,
        onPoll: (n) => {
          if (n === 1 && !injected) {
            injected = true;
            transport.failNext(new TransportError("ssh: connect to host x port 22: Connection refused", "connect"), 3);
          }
          if (n === 2) appendFileSync(log, "DONE\n");
        },
      },
    );
    expect(result.status).toBe("done");
    const rec = events.filter((e) => e.type === "reconnect") as Extract<Event, { type: "reconnect" }>[];
    expect(rec.map((r) => r.delayMs)).toEqual([3000, 6000, 12000]);
    expect(events.some((e) => e.type === "reconnected")).toBe(true);
  });

  it("unreachable after the budget: exit 3, onUnreachable + notify, teardown pending", async () => {
    const transport = new FakeTransport();
    transport.failNext(new TransportError("ssh: connect to host x port 22: Connection timed out", "connect"), 1000);
    const { result, events } = await run(
      { until: c.exitFile(t.path("rc")), interval: 10, unreachableAfter: 20_000, onUnreachable: ["true"], teardown: ["stop-pod"] },
      { transport },
    );
    expect(result.status).toBe("unreachable");
    expect(result.exitCode).toBe(3);
    expect(result.hooks.map((h) => h.phase)).toEqual(["onUnreachable"]);
    expect(result.pendingTeardown).toEqual(["stop-pod"]);
    expect(events.some((e) => e.type === "warn" && /pending: stop-pod/.test(e.message))).toBe(true);
  });

  it("keepGoing=false: first transport error is unreachable", async () => {
    const transport = new FakeTransport();
    transport.failNext(new TransportError("boom", "session"));
    const { result } = await run({ until: c.exitFile(t.path("rc")), interval: 10, keepGoing: false }, { transport });
    expect(result.status).toBe("unreachable");
  });

  it("host key changed: exit 7 at once, no reconnect loop", async () => {
    const transport = new FakeTransport();
    transport.failNext(new HostKeyError("host key CHANGED", { file: "/kh", line: 3, fix: "ssh-keygen -R x" }));
    const { result, events } = await run({ until: c.exitFile(t.path("rc")), interval: 10, teardown: ["true"] }, { transport });
    expect(result.status).toBe("hostKeyChanged");
    expect(result.exitCode).toBe(7);
    expect(result.error).toMatch(/CHANGED/);
    expect(events.filter((e) => e.type === "reconnect")).toHaveLength(0);
    expect(result.teardownRan).toBe(false);
  });

  it("abort via AbortSignal: onAbort runs, exit 128+signo, teardown not run by default", async () => {
    const ac = new AbortController();
    const log = t.path("job.log");
    writeFileSync(log, "");
    const { result } = await run(
      { until: c.log(log, { done: /DONE/ }), interval: 10, signal: ac.signal, onAbort: ["true"], onFail: ["echo no"], teardown: ["true"] },
      { onPoll: (n) => n === 2 && ac.abort({ signal: "SIGINT" }) },
    );
    expect(result.status).toBe("aborted");
    expect(result.signal).toBe("SIGINT");
    expect(result.exitCode).toBe(130);
    expect(result.hooks.map((h) => h.phase)).toEqual(["onAbort"]);
    expect(result.teardownRan).toBe(false);
  });

  it("a failing teardown hook turns exit 0 into 8", async () => {
    const log = t.path("job.log");
    writeFileSync(log, "DONE\n");
    const { result } = await run({ until: c.log(log, { done: "DONE", fromStart: true }), interval: 10, teardown: ["exit 3"] });
    expect(result.status).toBe("done");
    expect(result.exitCode).toBe(8);
  });

  it("hook timeout kills the hook and records timedOut", async () => {
    const log = t.path("job.log");
    writeFileSync(log, "DONE\n");
    const { result } = await run({ until: c.log(log, { done: "DONE", fromStart: true }), interval: 10, onDone: ["sleep 30 | cat"], hookTimeout: 300 });
    expect(result.hooks[0]?.timedOut).toBe(true);
    expect(result.exitCode).toBe(0); // onDone failures do not change the job outcome
  });

  it("function hooks receive the context", async () => {
    const log = t.path("job.log");
    writeFileSync(log, "DONE\n");
    let seen = "";
    const { result } = await run({
      until: c.log(log, { done: "DONE", fromStart: true }),
      interval: 10,
      onDone: [async (ctx) => void (seen = `${ctx.status}:${ctx.matched}`)],
    });
    expect(seen).toBe("done:DONE");
    expect(result.hooks[0]?.exitCode).toBe(0);
  });

  it("watch() yields events and returns the result", async () => {
    const log = t.path("job.log");
    writeFileSync(log, "DONE\n");
    const types: string[] = [];
    const it = watch({ until: c.log(log, { done: "DONE", fromStart: true }), interval: 10 }, { stateFile: false });
    let r = await it.next();
    while (!r.done) {
      types.push(r.value.type);
      r = await it.next();
    }
    expect(types[0]).toBe("start");
    expect(types.at(-1)).toBe("result");
    expect(r.value.status).toBe("done");
  });

  it("dead-man is armed with timeout+grace and disarmed on done", async () => {
    const log = t.path("job.log");
    writeFileSync(log, "");
    const flag = t.path("deadman-fired");
    const { result, events } = await run(
      { until: c.log(log, { done: /DONE/ }), interval: 10, timeout: 60_000, deadman: `touch ${flag}`, deadmanGrace: 1000 },
      { onPoll: (n) => n === 1 && appendFileSync(log, "DONE\n") },
    );
    expect(result.status).toBe("done");
    const dm = events.filter((e) => e.type === "deadman") as Extract<Event, { type: "deadman" }>[];
    expect(dm.map((d) => d.action)).toEqual(["armed", "disarmed"]);
    expect(dm[0]?.detail).toMatch(/fires in 1m01s/);
    expect(existsSync(flag)).toBe(false);
  });
});
