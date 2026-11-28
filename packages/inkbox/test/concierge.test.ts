import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Principal, RegisteredTool } from "@orion-ai/core";
import { conciergeTools, checkMandate, readMandate, type Mandate } from "../src/concierge.js";

const OWNER: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Omar" };
const FRIEND: Principal = { kind: "contact", id: "contact:sam", tier: "friend", displayName: "Sam", contactId: "sam" };
// 2026-11-27 10:00 Cairo (UTC+2 in winter)
const NOON = new Date("2026-11-27T08:00:00Z");
const LATE = new Date("2026-11-27T21:00:00Z"); // 23:00 Cairo

function setup(now = NOON) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concierge-"));
  const state = {
    readJson: <T>(n: string, f: T): T => (fs.existsSync(path.join(root, n)) ? (JSON.parse(fs.readFileSync(path.join(root, n), "utf8")) as T) : f),
    writeJson: (n: string, v: unknown) => fs.writeFileSync(path.join(root, n), JSON.stringify(v)),
  };
  const placed: Array<{ toNumber: string; reason: string }> = [];
  const audit: unknown[] = [];
  let clock = now;
  const tools = conciergeTools({
    channel: { placeCall: async (i: never) => (placed.push(i), { id: `call_${placed.length}`, status: "queued" }) } as never,
    config: { owner: { name: "Omar", phones: [], emails: [], timezone: "Africa/Cairo" } } as never,
    audit: { append: (e: unknown) => void audit.push(e) },
    state: state as never,
    now: () => clock,
  });
  const run = (name: string, args: unknown, who: Principal = OWNER) => (tools.find((t: RegisteredTool) => t.spec.name === name)!.spec as any).execute(args, { principal: who, conversationKey: "imessage:o", channel: "imessage", now: () => clock });
  return { run, placed, audit, state, setClock: (d: Date) => (clock = d) };
}
const MANDATE = { enabled: true, numbers: [{ number: "+20 100 000 0001", label: "Cafe" }], purposes: ["booking"], maxCallsPerDay: 2, maxCallsPerNumberPerDay: 1, startHour: 9, endHour: 20 };
const text = (r: any) => r.content[0].text as string;

describe("concierge calls", () => {
  it("refuses until a mandate exists", async () => {
    const t = setup();
    const r = await t.run("concierge_call", { toNumber: "+201000000001", purpose: "booking", reason: "Book a table" });
    expect(r.isError).toBe(true);
    expect(t.placed).toHaveLength(0);
  });
  it("places a call on the list, for an allowed purpose, and logs it", async () => {
    const t = setup();
    await t.run("concierge_mandate_set", MANDATE);
    const r = await t.run("concierge_call", { toNumber: "+201000000001", purpose: "Booking", reason: "Book a table for 4 at 7pm" });
    expect(r.isError).toBeUndefined();
    expect(t.placed).toHaveLength(1);
    expect(JSON.stringify(t.audit)).toContain("concierge");
  });
  it("blocks numbers off the list, other purposes, other hours, and caps", async () => {
    const t = setup();
    await t.run("concierge_mandate_set", MANDATE);
    const call = (over: object) => t.run("concierge_call", { toNumber: "+201000000001", purpose: "booking", reason: "x", ...over });
    expect((await call({ toNumber: "+201999999999" })).isError).toBe(true);
    expect((await call({ purpose: "sales" })).isError).toBe(true);
    t.setClock(LATE);
    expect((await call({})).isError).toBe(true);
    t.setClock(NOON);
    expect((await call({})).isError).toBeUndefined();
    expect((await call({})).isError).toBe(true); // per-number cap of 1
    expect(t.placed).toHaveLength(1);
  });
  it("only the owner can use or change it, and rejects bad input", async () => {
    const t = setup();
    expect((await t.run("concierge_mandate_set", MANDATE, FRIEND)).isError).toBe(true);
    expect((await t.run("concierge_mandate_set", { ...MANDATE, numbers: [{ number: "123", label: "x" }] })).isError).toBe(true);
    expect((await t.run("concierge_mandate_set", { ...MANDATE, startHour: 20, endHour: 9 })).isError).toBe(true);
    await t.run("concierge_mandate_set", MANDATE);
    expect((await t.run("concierge_call", { toNumber: "+201000000001", purpose: "booking", reason: "x" }, FRIEND)).isError).toBe(true);
  });
  it("an expired mandate stops calls; the capabilities are gated as designed", () => {
    const m: Mandate = { ...readMandate({ readJson: (_n, f) => f } as never), ...MANDATE, numbers: [{ number: "+201000000001", label: "c" }], version: 1, expiresAt: "2026-01-01T00:00:00Z" };
    expect(checkMandate(m, [], { number: "+201000000001", purpose: "booking" }, NOON, "Africa/Cairo").ok).toBe(false);
    const caps = Object.fromEntries(conciergeTools({ channel: {} as never, config: { owner: { timezone: "UTC" } } as never, audit: { append() {} }, state: {} as never }).map((x) => [x.spec.name, x.spec.meta?.capabilities]));
    expect(caps.concierge_mandate_set).toEqual(["phone.call"]); // always asks
    expect(caps.concierge_call).toEqual(["phone.concierge"]);
  });
});
