import { describe, expect, it } from "vitest";
import type { Principal, RegisteredTool } from "@orion-ai/core";
import { PartnerRegistry, partnerTools, validateRequest, PARTNER_PROTOCOL_VERSION, type PartnerConnector } from "../src/partners.js";

const OWNER: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Omar" };
const FRIEND: Principal = { kind: "contact", id: "contact:sam", tier: "friend", displayName: "Sam", contactId: "sam" };

function setup(connectors: PartnerConnector[] = []) {
  const store: Record<string, unknown> = {};
  const registry = new PartnerRegistry();
  connectors.forEach((c) => registry.register(c));
  const audit: unknown[] = [];
  const tools = partnerTools({ registry, config: { owner: { name: "Omar" } } as never, audit: { append: (e) => void audit.push(e) }, state: { readJson: (n: string, f: unknown) => (store[n] ?? f) as never, writeJson: (n: string, v: unknown) => void (store[n] = v) } });
  const run = (name: string, args: unknown, who = OWNER) => (tools.find((t: RegisteredTool) => t.spec.name === name)!.spec as any).execute(args, { principal: who, conversationKey: "k", channel: "imessage", now: () => new Date() });
  return { run, registry, audit };
}
const text = (r: any) => r.content[0].text as string;

describe("partner layer", () => {
  it("with no partner connected it says so and gives the fallback", async () => {
    const t = setup();
    expect(text(await t.run("partner_list", {}))).toContain("No business partner");
    const r = await t.run("partner_request", { domain: "health", intent: "book", subject: "clinic visit" });
    expect(text(r)).toContain("No connected partner");
    expect(text(r)).toContain("phone");
  });

  it("book is two steps: proposal first, commit once after confirm", async () => {
    let confirmed = 0;
    const clinic: PartnerConnector = {
      id: "clinic",
      label: "Test Clinic",
      domains: ["health"],
      intents: ["availability", "book"],
      handle: async (req) => ({ requestId: req.id, status: "proposal", message: "slot", proposal: { id: "prop_1", summary: "Dr Ali, Sunday 5pm", amount: 300, currency: "EGP" } }),
      confirm: async () => (confirmed++, { requestId: "x", status: "ok", message: "Booked." }),
    };
    const t = setup([clinic]);
    const prop = await t.run("partner_request", { domain: "health", intent: "book", subject: "check-up", details: { time: "Sunday" } });
    expect(text(prop)).toContain("Nothing is booked");
    expect(confirmed).toBe(0);
    expect((await t.run("partner_confirm", { proposalId: "prop_1" }, FRIEND)).isError).toBe(true);
    expect(text(await t.run("partner_confirm", { proposalId: "prop_1" }))).toBe("Booked.");
    expect((await t.run("partner_confirm", { proposalId: "prop_1" })).isError).toBe(true); // once only
    expect((await t.run("partner_confirm", { proposalId: "nope" })).isError).toBe(true);
    expect(confirmed).toBe(1);
  });

  it("a read-only intent returns the answer and stores no proposal; a failing partner is an error; only the owner asks", async () => {
    const info: PartnerConnector = { id: "p", label: "P", domains: ["utilities"], intents: ["status"], handle: async (r) => ({ requestId: r.id, status: "ok", message: "Bill is 120 EGP" }) };
    const t = setup([info]);
    expect(text(await t.run("partner_request", { domain: "utilities", intent: "status", subject: "bill" }))).toBe("Bill is 120 EGP");
    expect((await t.run("partner_request", { domain: "utilities", intent: "status", subject: "bill" }, FRIEND)).isError).toBe(true);
    const bad: PartnerConnector = { id: "b", label: "B", domains: ["travel"], intents: ["quote"], handle: async () => { throw new Error("down"); } };
    expect((await setup([bad]).run("partner_request", { domain: "travel", intent: "quote", subject: "flight" })).isError).toBe(true);
  });

  it("validates the protocol envelope and rejects duplicate ids", () => {
    const ok = { version: PARTNER_PROTOCOL_VERSION, id: "r", domain: "health", intent: "info", subject: "x", details: {}, onBehalfOf: { name: "o" }, idempotencyKey: "k" } as const;
    expect(validateRequest(ok as never)).toBeUndefined();
    expect(validateRequest({ ...ok, subject: "" } as never)).toBeDefined();
    expect(validateRequest({ ...ok, version: "OPP/9" } as never)).toBeDefined();
    const reg = new PartnerRegistry();
    const c: PartnerConnector = { id: "a", label: "A", domains: ["other"], intents: ["info"], handle: async () => ({ requestId: "", status: "ok", message: "" }) };
    reg.register(c);
    expect(() => reg.register(c)).toThrow();
  });
});
