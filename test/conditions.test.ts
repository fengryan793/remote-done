import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createTcp, type Server as TcpServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compile, hasStallSource } from "../src/conditions.js";
import { conditions as c } from "../src/index.js";
import { LocalTransport } from "../src/transport/local.js";
import { tmp, virtualClock, wait } from "./helpers.js";

let t: ReturnType<typeof tmp>;
const local = new LocalTransport();
const children: ChildProcess[] = [];
const servers: Array<Server | TcpServer> = [];
beforeEach(() => (t = tmp()));
afterEach(async () => {
  t.cleanup();
  for (const ch of children.splice(0)) ch.kill("SIGKILL");
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
});

async function untilGone(pid: number): Promise<void> {
  for (let i = 0; i < 50 && (await local.processAlive({ pid })); i++) await wait(50);
}

describe("conditions", () => {
  it("exitFile: absent -> pending, 0 -> done, 2 -> fail, junk -> fail", async () => {
    const f = t.path("rc");
    const ev = compile(c.exitFile(f), local);
    expect((await ev.evaluate()).state).toBe("pending");
    writeFileSync(f, "");
    expect((await ev.evaluate()).state).toBe("pending");
    writeFileSync(f, "0\n");
    expect(await ev.evaluate()).toMatchObject({ state: "done", matched: "rc=0" });
    writeFileSync(f, "2\n");
    expect(await ev.evaluate()).toMatchObject({ state: "fail", matched: "rc=2" });
    writeFileSync(f, "boom");
    expect((await ev.evaluate()).state).toBe("fail");
  });

  it("process by pid: alive -> pending, gone without exitFile -> exited, with exitFile -> resolved", async () => {
    const ch = spawn("sleep", ["30"]);
    children.push(ch);
    const pid = ch.pid as number;
    const plain = compile(c.process({ pid }), local);
    expect((await plain.evaluate()).state).toBe("pending");
    const rc = t.path("rc");
    const resolved = compile(c.process({ pid, exitFile: rc }), local, { sleep: async () => {} });
    ch.kill("SIGKILL");
    await untilGone(pid);
    expect((await plain.evaluate()).state).toBe("exited");
    expect((await resolved.evaluate()).state).toBe("fail"); // rc absent = crashed before writing
    writeFileSync(rc, "0");
    expect((await resolved.evaluate()).state).toBe("done");
  });

  it("process by pattern does not match the probe itself", async () => {
    const marker = `sleep 31.${process.pid}`;
    const ev = compile(c.process({ pattern: marker }), local);
    expect((await ev.evaluate()).state).toBe("exited"); // nothing running with that cmdline
    const ch = spawn("sh", ["-c", `exec ${marker}`]);
    children.push(ch);
    await wait(200);
    expect((await ev.evaluate()).state).toBe("pending");
    ch.kill("SIGKILL");
    await untilGone(ch.pid as number);
    expect((await ev.evaluate()).state).toBe("exited");
  });

  it("port: open/closed", async () => {
    const srv = createTcp(() => {});
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    expect((await compile(c.port(port), local).evaluate()).state).toBe("done");
    expect((await compile(c.port(port, { closed: true }), local).evaluate()).state).toBe("pending");
    await new Promise((r) => srv.close(() => r(undefined)));
    servers.pop();
    expect((await compile(c.port(port), local).evaluate()).state).toBe("pending");
    expect((await compile(c.port(port, { closed: true }), local).evaluate()).state).toBe("done");
  });

  it("http: status, bodyMatch, failMatch, unreachable -> pending", async () => {
    let body = "starting";
    let status = 503;
    const srv = createHttp((_req, res) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(body);
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
    const ev = compile(c.http(url, { bodyMatch: /ready/, failMatch: /FATAL/ }), local);
    expect((await ev.evaluate()).state).toBe("pending");
    status = 200;
    const pend = await ev.evaluate();
    expect(pend.state).toBe("pending");
    body = "ready now";
    const done = await ev.evaluate();
    expect(done.state).toBe("done");
    expect(done.changeKey).not.toBe(pend.changeKey);
    body = "FATAL error";
    expect((await ev.evaluate()).state).toBe("fail");
    expect((await compile(c.http("http://127.0.0.1:1/"), local).evaluate()).state).toBe("pending");
  });

  it("file: exists, minBytes, stableFor with a virtual clock, exists:false", async () => {
    const f = t.path("out.mp4");
    const clock = virtualClock();
    expect((await compile(c.file(f), local).evaluate()).state).toBe("pending");
    writeFileSync(f, "12");
    expect((await compile(c.file(f), local).evaluate()).state).toBe("done");
    expect((await compile(c.file(f, { minBytes: 10 }), local).evaluate()).state).toBe("pending");
    const stable = compile(c.file(f, { stableFor: 1000 }), local, { now: clock.now });
    expect((await stable.evaluate()).state).toBe("pending");
    clock.advance(500);
    expect((await stable.evaluate()).state).toBe("pending");
    clock.advance(600);
    expect((await stable.evaluate()).state).toBe("done");
    const gone = compile(c.file(f, { exists: false }), local);
    expect((await gone.evaluate()).state).toBe("pending");
  });

  it("command: exit 0 done, >= failFrom fail, else pending; stdout hash is the change key", async () => {
    const ev = compile(c.command(`test -f ${t.path("ok")}`), local);
    expect((await ev.evaluate()).state).toBe("pending");
    writeFileSync(t.path("ok"), "");
    expect((await ev.evaluate()).state).toBe("done");
    expect((await compile(c.command("exit 100"), local).evaluate()).state).toBe("fail");
    expect((await compile(c.command("exit 3", { failFrom: 3 }), local).evaluate()).state).toBe("fail");
    const a = await compile(c.command("echo a; exit 1"), local).evaluate();
    const b = await compile(c.command("echo b; exit 1"), local).evaluate();
    expect(a.changeKey).not.toBe(b.changeKey);
  });

  it("all/any combine; fail wins; exited gets a grace re-read of pending children", async () => {
    const log = t.path("x.log");
    writeFileSync(log, "");
    const rc = t.path("rc");
    const all = compile(c.all(c.exitFile(rc), c.log(log, { done: /DONE/, fail: /ERR/ })), local);
    expect((await all.evaluate()).state).toBe("pending");
    writeFileSync(rc, "0");
    expect((await all.evaluate()).state).toBe("pending");
    writeFileSync(log, "DONE\n");
    expect((await all.evaluate()).state).toBe("done");
    const anyc = compile(c.any(c.exitFile(t.path("none")), c.log(log, { done: /NEVER/, fail: /ERR/, fromStart: true })), local);
    writeFileSync(log, "DONE\nERR\n");
    expect((await anyc.evaluate()).state).toBe("fail");

    // exited race: the process dies after the log child was read but the final line is there on re-read
    const ch = spawn("sleep", ["30"]);
    children.push(ch);
    const log2 = t.path("y.log");
    writeFileSync(log2, "");
    const combo = compile(c.all(c.log(log2, { done: /DONE/ }), c.process({ pid: ch.pid as number })), local);
    expect((await combo.evaluate()).state).toBe("pending");
    writeFileSync(log2, "DONE\n");
    ch.kill("SIGKILL");
    await untilGone(ch.pid as number);
    // log child already consumed "DONE"? No: it was empty on the last read, so this read sees DONE.
    expect((await combo.evaluate()).state).toBe("done");
  });

  it("hasStallSource", () => {
    expect(hasStallSource(c.exitFile("/x"))).toBe(false);
    expect(hasStallSource(c.process({ pid: 1 }))).toBe(false);
    expect(hasStallSource(c.log("/x", { done: "D" }))).toBe(true);
    expect(hasStallSource(c.all(c.process({ pid: 1 }), c.file("/x")))).toBe(true);
  });
});
