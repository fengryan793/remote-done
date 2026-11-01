import { describe, expect, it } from "vitest";
import { formatBytes, formatMs, parseDuration } from "../src/duration.js";
import { shq } from "../src/shell.js";
import { parseSshDestination } from "../src/index.js";

describe("parseDuration", () => {
  it("numbers are ms, bare strings are seconds, units compose", () => {
    expect(parseDuration(1500)).toBe(1500);
    expect(parseDuration("90")).toBe(90_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("1500ms")).toBe(1500);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration(undefined)).toBeUndefined();
  });
  it("rejects garbage", () => {
    expect(() => parseDuration("soon")).toThrow(/cannot parse/);
    expect(() => parseDuration("5x")).toThrow();
    expect(() => parseDuration(-1)).toThrow();
  });
  it("formats", () => {
    expect(formatMs(500)).toBe("500ms");
    expect(formatMs(754_321)).toBe("12m34s");
    expect(formatMs(3_661_000)).toBe("1h01m01s");
    expect(formatBytes(10)).toBe("10 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
  });
});

describe("shq", () => {
  it("quotes only when needed and escapes single quotes", () => {
    expect(shq("abc")).toBe("abc");
    expect(shq("/tmp/x.log")).toBe("/tmp/x.log");
    expect(shq("a b")).toBe("'a b'");
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(shq("")).toBe("''");
  });
});

describe("parseSshDestination", () => {
  it("handles user, port and ipv6", () => {
    expect(parseSshDestination("root@1.2.3.4")).toEqual({ host: "1.2.3.4", user: "root" });
    expect(parseSshDestination("root@1.2.3.4:22011")).toEqual({ host: "1.2.3.4", user: "root", port: 22011 });
    expect(parseSshDestination("ssh://u@h:2222")).toEqual({ host: "h", user: "u", port: 2222 });
    expect(parseSshDestination("ubuntugpu")).toEqual({ host: "ubuntugpu" });
    expect(parseSshDestination("[::1]:2200")).toEqual({ host: "::1", port: 2200 });
    expect(parseSshDestination("fe80::1")).toEqual({ host: "fe80::1" });
  });
});
