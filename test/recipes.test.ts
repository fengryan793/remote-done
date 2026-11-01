import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseStatOutput, parseTailOutput, runStartScript, statScript, tailScript } from "../src/recipes.js";
import { classifySshFailure, hostKeyFixCommand, knownHostsFileFor, parseSentinel, sshCommonOptions, SshTransport } from "../src/transport/ssh.js";
import { LocalTransport } from "../src/transport/local.js";
import { tmp } from "./helpers.js";

let t: ReturnType<typeof tmp>;
const local = new LocalTransport();
beforeEach(() => (t = tmp()));
afterEach(() => t.cleanup());

describe("tail/stat recipes on this userland", () => {
  it("tail recipe prints the header and the bounded window", async () => {
    const f = t.path("x");
    writeFileSync(f, "0123456789");
    const r = await local.execRaw(tailScript(f, 3, 4));
    expect(r.code).toBe(0);
    const p = parseTailOutput(r.stdout);
    expect(p.exists).toBe(true);
    expect(p.size).toBe(10);
    expect(p.ino).toMatch(/^\d+:\d+$/);
    expect(p.bytes.toString()).toBe("3456");
    const rest = parseTailOutput((await local.execRaw(tailScript(f, 7, 1000))).stdout);
    expect(rest.bytes.toString()).toBe("789");
    const none = parseTailOutput((await local.execRaw(tailScript(f, 10, 1000))).stdout);
    expect(none.bytes.length).toBe(0);
    const shrunk = parseTailOutput((await local.execRaw(tailScript(f, 20, 1000))).stdout);
    expect(shrunk.size).toBe(10);
    expect(shrunk.bytes.length).toBe(0);
    const missing = parseTailOutput((await local.execRaw(tailScript(t.path("nope"), 0, 10))).stdout);
    expect(missing.exists).toBe(false);
  });

  it("stat recipe parses size and mtime", async () => {
    const f = t.path("s");
    writeFileSync(f, "abc");
    const st = parseStatOutput((await local.exec(statScript(f))).stdout);
    expect(st.exists).toBe(true);
    expect(st.size).toBe(3);
    expect(Math.abs(st.mtimeMs - Date.now())).toBeLessThan(60_000);
    expect(parseStatOutput((await local.exec(statScript(t.path("nope")))).stdout).exists).toBe(false);
  });

  it("paths with spaces and quotes survive quoting", async () => {
    const f = t.path("we ird 'name");
    writeFileSync(f, "DONE\n");
    const p = parseTailOutput((await local.execRaw(tailScript(f, 0, 100))).stdout);
    expect(p.bytes.toString()).toBe("DONE\n");
  });

  it("run recipe starts detached, writes pid/rc and survives the parent shell", async () => {
    const log = t.path("job.log");
    const r = await local.exec(runStartScript("echo hi; exit 3", log));
    expect(r.code).toBe(0);
    const pid = Number(r.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) {
      const rc = await local.exec(`cat ${log}.rc 2>/dev/null`);
      if (rc.stdout.trim() === "3") break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect((await local.exec(`cat ${log}`)).stdout).toBe("hi\n");
    expect((await local.exec(`cat ${log}.rc`)).stdout.trim()).toBe("3");
    expect(Number((await local.exec(`cat ${log}.pid`)).stdout.trim())).toBe(pid);
  });
});

describe("ssh sentinel and classification", () => {
  it("parseSentinel strips the trailer, keeps binary body", () => {
    const body = Buffer.from([0xff, 0x0a, 0x00, 0x41]);
    const out = Buffer.concat([body, Buffer.from("\n__RD_RC=7\n")]);
    const s = parseSentinel(out);
    expect(s.found).toBe(true);
    expect(s.code).toBe(7);
    expect(s.body.equals(body)).toBe(true);
    expect(parseSentinel(Buffer.from("\n__RD_RC=0\n"))).toMatchObject({ found: true, code: 0 });
    expect(parseSentinel(Buffer.from("__RD_ABSENT\n__RD_RC=0\n")).body.toString()).toBe("__RD_ABSENT");
    expect(parseSentinel(Buffer.from("partial output")).found).toBe(false);
  });

  it("classifies host key, auth, connect and session failures", () => {
    const changed = `@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@\nOffending ECDSA key in /Users/a/.ssh/known_hosts:12\nHost key verification failed.`;
    expect(classifySshFailure(255, changed, false)).toEqual({ type: "hostKeyChanged", file: "/Users/a/.ssh/known_hosts", line: 12 });
    expect(classifySshFailure(255, "Host key verification failed.", false)).toEqual({ type: "hostKeyUnknown" });
    expect(classifySshFailure(255, "root@1.2.3.4: Permission denied (publickey).", false)).toEqual({ type: "auth" });
    expect(classifySshFailure(255, "ssh: connect to host 1.2.3.4 port 22: Connection refused", false)).toEqual({ type: "transport", phase: "connect" });
    expect(classifySshFailure(255, "kex_exchange_identification: read: Connection reset by peer", false)).toEqual({ type: "transport", phase: "connect" });
    expect(classifySshFailure(255, "client_loop: send disconnect: Broken pipe", true)).toEqual({ type: "transport", phase: "session" });
    expect(classifySshFailure(255, "Timeout, server 1.2.3.4 not responding.", true)).toEqual({ type: "transport", phase: "session" });
    expect(classifySshFailure(255, "", true)).toEqual({ type: "transport", phase: "session" });
    expect(classifySshFailure(255, "", false)).toEqual({ type: "transport", phase: "connect" });
    expect(classifySshFailure(1, "some remote stderr", true)).toEqual({ type: "none" });
  });

  it("builds argv for each host-key policy", () => {
    const base = { kind: "ssh" as const, host: "1.2.3.4", user: "root", port: 22011, identity: "~/.ssh/id_ed25519" };
    const acceptNew = sshCommonOptions(base, "/kh/file").join(" ");
    expect(acceptNew).toContain("BatchMode=yes");
    expect(acceptNew).toContain("StrictHostKeyChecking=accept-new");
    expect(acceptNew).toContain("UserKnownHostsFile=/kh/file");
    expect(acceptNew).toContain("-i ~/.ssh/id_ed25519");
    const insecure = sshCommonOptions({ ...base, hostKey: "insecure" }, "/kh/file").join(" ");
    expect(insecure).toContain("StrictHostKeyChecking=no");
    expect(insecure).toContain("UserKnownHostsFile=/dev/null");
    const strict = sshCommonOptions({ ...base, hostKey: "strict" }, "/kh/file").join(" ");
    expect(strict).toContain("StrictHostKeyChecking=yes");
    expect(strict).not.toContain("UserKnownHostsFile");
    expect(knownHostsFileFor(base, "run1", "/d")).toBe("/d/1.2.3.4_22011_run1");
    expect(hostKeyFixCommand(base, "/d/f")).toBe(`ssh-keygen -R '[1.2.3.4]:22011' -f /d/f`);
    expect(hostKeyFixCommand({ kind: "ssh", host: "h" })).toBe(`ssh-keygen -R h`);
    const tr = new SshTransport(base, { runId: "r", knownHostsDir: t.dir });
    const argv = tr.sshArgv();
    expect(argv[0]).toBe("-n");
    expect(argv.slice(-2)).toEqual(["--", "root@1.2.3.4"]);
    expect(argv).toContain("-p");
    expect(SshTransport.wrap("echo hi")).toBe(`sh -c 'echo hi'; printf '\\n__RD_RC=%s\\n' $?`);
  });
});
