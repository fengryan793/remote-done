/**
 * Byte-offset log tailer with a carry buffer, rotation detection and a bounded window.
 * See Plan v2.1 "Tailing": `offset += bytes.length` always; `size` is only used for the
 * shrink test, `ino` for rotation; never `offset = size`.
 */
import type { Matcher, Transport } from "./types.js";

export const DEFAULT_WINDOW = 8 * 1024 * 1024; // bytes per transport call
export const CARRY_KEEP = 64 * 1024; // last bytes of an over-long partial line we keep
const MAX_ROUNDS = 16; // catch-up calls per poll

export interface TailPoll {
  exists: boolean;
  size: number;
  /** complete lines appended since the last poll */
  lines: string[];
  /** the unterminated last line, only when the file stopped growing since the previous poll */
  stablePartial?: string;
  /** last complete line seen so far (for summaries) */
  lastLine?: string;
  rotated: boolean;
}

export interface TailerOptions {
  fromStart?: boolean;
  windowBytes?: number;
  /** floor for the carry buffer: longest marker length - 1 */
  carryFloor?: number;
}

export class LogTailer {
  private offset = 0;
  private carry: Buffer = Buffer.alloc(0);
  private ino: string | undefined;
  private initialized = false;
  private lastSize = -1;
  private lastLine: string | undefined;
  private readonly window: number;
  private readonly keep: number;
  private readonly fromStart: boolean;

  constructor(
    private readonly transport: Transport,
    readonly path: string,
    opts: TailerOptions = {},
  ) {
    this.window = opts.windowBytes ?? DEFAULT_WINDOW;
    this.keep = Math.max(CARRY_KEEP, opts.carryFloor ?? 0);
    this.fromStart = opts.fromStart ?? false;
  }

  get position(): number {
    return this.offset;
  }

  async poll(): Promise<TailPoll> {
    if (!this.initialized) {
      this.initialized = true;
      if (!this.fromStart) {
        const st = await this.transport.readTail(this.path, 0, 0);
        if (st.exists) {
          this.offset = st.size;
          this.ino = st.ino;
          this.lastSize = st.size;
          return { exists: true, size: st.size, lines: [], rotated: false };
        }
        return { exists: false, size: 0, lines: [], rotated: false };
      }
    }

    const lines: string[] = [];
    let rotated = false;
    let size = 0;
    let exists = true;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const r = await this.transport.readTail(this.path, this.offset, this.window);
      if (!r.exists) {
        // Gone (rotated away or not yet created): start over when it reappears.
        this.reset();
        exists = false;
        size = 0;
        break;
      }
      size = r.size;
      if ((this.ino !== undefined && r.ino !== this.ino) || r.size < this.offset) {
        // Rotation or truncation: re-read from the beginning right away.
        this.reset();
        this.ino = r.ino;
        rotated = true;
        continue;
      }
      this.ino = r.ino;
      if (r.bytes.length > 0) {
        this.offset += r.bytes.length;
        lines.push(...this.consume(r.bytes));
      }
      if (r.bytes.length < this.window) break;
    }

    const out: TailPoll = { exists, size, lines, rotated };
    if (lines.length > 0) this.lastLine = lines[lines.length - 1];
    if (this.lastLine !== undefined) out.lastLine = this.lastLine;
    if (exists && size === this.lastSize && this.carry.length > 0) {
      // `echo -n DONE`: the file stopped growing, judge the unterminated line as if complete.
      out.stablePartial = this.carry.toString("utf8");
    }
    this.lastSize = size;
    return out;
  }

  /** Evaluate the unterminated remainder (used at timeout). */
  partial(): string | undefined {
    return this.carry.length > 0 ? this.carry.toString("utf8") : undefined;
  }

  private reset(): void {
    this.offset = 0;
    this.carry = Buffer.alloc(0);
    this.ino = undefined;
    this.lastSize = -1;
  }

  private consume(chunk: Buffer): string[] {
    const buf = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) {
      this.carry = Buffer.from(this.trimCarry(buf));
      return [];
    }
    const complete = buf.subarray(0, lastNl).toString("utf8");
    this.carry = Buffer.from(this.trimCarry(buf.subarray(lastNl + 1)));
    return complete.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  }

  private trimCarry(b: Buffer): Buffer {
    return b.length > this.keep ? b.subarray(b.length - this.keep) : b;
  }
}

export function matcherTest(m: Matcher, line: string): boolean {
  if (typeof m === "string") return line.includes(m);
  m.lastIndex = 0;
  return m.test(line);
}

export function matcherLength(m: Matcher | undefined): number {
  if (m === undefined) return 0;
  return typeof m === "string" ? m.length : m.source.length;
}

export function matcherToString(m: Matcher): string {
  return typeof m === "string" ? m : m.toString();
}

/** First line that matches: fail wins over done on the same line. */
export function scanLines(
  lines: string[],
  done: Matcher | undefined,
  fail: Matcher | undefined,
): { state: "done" | "fail"; line: string } | undefined {
  for (const line of lines) {
    if (fail !== undefined && matcherTest(fail, line)) return { state: "fail", line };
    if (done !== undefined && matcherTest(done, line)) return { state: "done", line };
  }
  return undefined;
}
