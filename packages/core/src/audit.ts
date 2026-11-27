/**
 * Append-only audit log. Every tool call, policy decision, outbound message and
 * spend lands here so the owner can ask "what did you do today" and so the spend
 * policy can compute today's total without a database.
 */
import { createHash } from "node:crypto";
import type { StateDir } from "./state.js";
import type { AuditEntry, AuditKind } from "./types.js";

const FILE = "audit.jsonl";
const GENESIS = "0".repeat(64);

const chain = (prev: string, body: string): string => createHash("sha256").update(prev).update("\n").update(body).digest("hex");

/** Calendar date of `d` in `tz` as YYYY-MM-DD. Falls back to UTC on a bad tz. */
export function localDate(d: Date, tz: string): string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  // en-CA formats as YYYY-MM-DD already.
  return fmt.format(d);
}

export class AuditLog {
  private readonly state: StateDir;

  constructor(state: StateDir) {
    this.state = state;
  }

  private tip: string | undefined;

  /** Hash of the last chained entry. Read once, then kept: the runtime is the only writer. */
  private tipHash(): string {
    if (this.tip === undefined) {
      let h = GENESIS;
      for (const line of this.state.readLines(FILE)) {
        try {
          const e = JSON.parse(line) as AuditEntry;
          if (typeof e.hash === "string") h = e.hash;
        } catch {
          // a torn line
        }
      }
      this.tip = h;
    }
    return this.tip;
  }

  append(entry: Omit<AuditEntry, "at">): void {
    const body: AuditEntry = { at: new Date().toISOString(), ...entry };
    const prev = this.tipHash();
    const hash = chain(prev, JSON.stringify(body));
    this.state.appendLine(FILE, JSON.stringify({ ...body, prev, hash }));
    this.tip = hash;
  }

  /**
   * Check the chain from the first chained entry on. An edited, removed or reordered line is
   * reported at its line number. Entries written before chaining existed are counted, not judged.
   */
  verify(): { ok: boolean; entries: number; unchained: number; torn: number; brokenAt?: number } {
    let expected = GENESIS;
    let entries = 0;
    let unchained = 0;
    let torn = 0;
    let n = 0;
    for (const line of this.state.readLines(FILE)) {
      n++;
      let e: AuditEntry;
      try {
        e = JSON.parse(line) as AuditEntry;
      } catch {
        torn++;
        continue;
      }
      entries++;
      if (typeof e.hash !== "string" || typeof e.prev !== "string") {
        unchained++;
        continue;
      }
      const { prev, hash, ...body } = e;
      if (prev !== expected || chain(prev, JSON.stringify(body)) !== hash) return { ok: false, entries, unchained, torn, brokenAt: n };
      expected = hash;
    }
    return { ok: true, entries, unchained, torn };
  }

  /** Oldest first. `limit` keeps the most recent N after filtering. */
  read(opts: { since?: string; kinds?: AuditKind[]; limit?: number } = {}): AuditEntry[] {
    const kinds = opts.kinds ? new Set<AuditKind>(opts.kinds) : undefined;
    const since = opts.since ? Date.parse(opts.since) : undefined;
    const entries: AuditEntry[] = [];
    for (const line of this.state.readLines(FILE)) {
      let e: AuditEntry;
      try {
        e = JSON.parse(line) as AuditEntry;
      } catch {
        continue; // a torn line from a crash mid-write; skip it rather than fail the read
      }
      if (kinds && !kinds.has(e.kind)) continue;
      if (since !== undefined && !Number.isNaN(since) && Date.parse(e.at) < since) continue;
      entries.push(e);
    }
    if (opts.limit !== undefined && opts.limit >= 0 && entries.length > opts.limit) {
      return entries.slice(entries.length - opts.limit);
    }
    return entries;
  }

  /** Sum of `detail.amountUsd` over "spend" entries that fall on today's local date. */
  spentTodayUsd(tz: string, now: Date = new Date()): number {
    const today = localDate(now, tz);
    let total = 0;
    for (const e of this.read({ kinds: ["spend"] })) {
      const at = new Date(e.at);
      if (Number.isNaN(at.getTime()) || localDate(at, tz) !== today) continue;
      const amount = e.detail.amountUsd;
      if (typeof amount === "number" && Number.isFinite(amount)) total += amount;
    }
    return Math.round(total * 100) / 100;
  }
}
