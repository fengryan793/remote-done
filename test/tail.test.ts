import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogTailer, scanLines } from "../src/tail.js";
import { LocalTransport } from "../src/transport/local.js";
import { tmp } from "./helpers.js";

let t: ReturnType<typeof tmp>;
const transport = new LocalTransport();
beforeEach(() => (t = tmp()));
afterEach(() => t.cleanup());

describe("LogTailer", () => {
  it("starts at the current end by default and only sees appended complete lines", async () => {
    const log = t.path("a.log");
    writeFileSync(log, "old line\nDONE already here\n");
    const tailer = new LogTailer(transport, log);
    const first = await tailer.poll();
    expect(first.lines).toEqual([]);
    appendFileSync(log, "step 1\nstep 2\npartial");
    const second = await tailer.poll();
    expect(second.lines).toEqual(["step 1", "step 2"]);
    expect(second.stablePartial).toBeUndefined();
    appendFileSync(log, " line\n");
    const third = await tailer.poll();
    expect(third.lines).toEqual(["partial line"]);
    expect(third.lastLine).toBe("partial line");
  });

  it("fromStart reads the existing content", async () => {
    const log = t.path("a.log");
    writeFileSync(log, "DONE\n");
    const tailer = new LogTailer(transport, log, { fromStart: true });
    expect((await tailer.poll()).lines).toEqual(["DONE"]);
  });

  it("a marker straddling two reads is matched once the line completes", async () => {
    const log = t.path("a.log");
    writeFileSync(log, "");
    const tailer = new LogTailer(transport, log, { windowBytes: 4 });
    await tailer.poll();
    appendFileSync(log, "xxDONEyy\n"); // 9 bytes: read in 4-byte windows within one poll
    const p = await tailer.poll();
    expect(p.lines).toEqual(["xxDONEyy"]);
    expect(tailer.position).toBe(9);
  });

  it("UTF-8 split across polls is reassembled", async () => {
    const log = t.path("u.log");
    writeFileSync(log, "");
    const tailer = new LogTailer(transport, log);
    await tailer.poll();
    const bytes = Buffer.from("完成 DONE\n");
    appendFileSync(log, bytes.subarray(0, 2)); // half of 完
    expect((await tailer.poll()).lines).toEqual([]);
    appendFileSync(log, bytes.subarray(2));
    expect((await tailer.poll()).lines).toEqual(["完成 DONE"]);
  });

  it("an unterminated last line is judged once the file stops growing (echo -n DONE)", async () => {
    const log = t.path("n.log");
    writeFileSync(log, "");
    const tailer = new LogTailer(transport, log);
    await tailer.poll();
    appendFileSync(log, "DONE");
    const p1 = await tailer.poll();
    expect(p1.lines).toEqual([]);
    expect(p1.stablePartial).toBeUndefined(); // it just grew
    const p2 = await tailer.poll();
    expect(p2.stablePartial).toBe("DONE");
    expect(scanLines([p2.stablePartial as string], "DONE", undefined)?.state).toBe("done");
  });

  it("rotation (new inode) and truncation restart from byte 0", async () => {
    const log = t.path("r.log");
    writeFileSync(log, "a\n");
    const tailer = new LogTailer(transport, log, { fromStart: true });
    expect((await tailer.poll()).lines).toEqual(["a"]);
    renameSync(log, t.path("r.log.1"));
    writeFileSync(log, "b\n"); // new inode, size 2 == old offset
    const p = await tailer.poll();
    expect(p.rotated).toBe(true);
    expect(p.lines).toEqual(["b"]);
    appendFileSync(log, "c\nd\n"); // same inode, grows
    expect((await tailer.poll()).lines).toEqual(["c", "d"]);
    // documented limit: copytruncate + regrowth PAST the old offset on the same inode is undetectable
    writeFileSync(log, "e\n"); // truncated below offset -> detected
    const q = await tailer.poll();
    expect(q.rotated).toBe(true);
    expect(q.lines).toEqual(["e"]);
  });

  it("missing file is reported and picked up when it appears", async () => {
    const log = t.path("later.log");
    const tailer = new LogTailer(transport, log);
    expect((await tailer.poll()).exists).toBe(false);
    writeFileSync(log, "hello\nDONE\n");
    const p = await tailer.poll();
    expect(p.exists).toBe(true);
    expect(p.lines).toEqual(["hello", "DONE"]);
  });

  it("over-long partial line keeps only its tail but never loses the marker", async () => {
    const log = t.path("big.log");
    writeFileSync(log, "");
    const tailer = new LogTailer(transport, log, { carryFloor: 3 });
    await tailer.poll();
    appendFileSync(log, "x".repeat(70 * 1024));
    await tailer.poll();
    appendFileSync(log, "DONE\n");
    const p = await tailer.poll();
    expect(p.lines).toHaveLength(1);
    expect((p.lines[0] as string).endsWith("DONE")).toBe(true);
    expect((p.lines[0] as string).length).toBeLessThanOrEqual(64 * 1024 + 4);
  });
});

describe("scanLines", () => {
  it("fail wins over done on the same line; regex and substring both work", () => {
    expect(scanLines(["ok", "DONE"], "DONE", /ERROR/)).toEqual({ state: "done", line: "DONE" });
    expect(scanLines(["ERROR then DONE"], "DONE", /ERROR/)).toEqual({ state: "fail", line: "ERROR then DONE" });
    expect(scanLines(["nothing"], /DONE/, /ERROR|Traceback/)).toBeUndefined();
  });
});
