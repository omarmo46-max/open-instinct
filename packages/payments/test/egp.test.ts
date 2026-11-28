import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { RegisteredTool } from "@orion-ai/core";
import { createEgpRail, luhn, toPiasters, type AutomaticCardIssuer } from "../src/egp/index.js";
import { NOW, ctxFor, fakeAudit, fakeOutbox, friend, isError, owner, tempState, testConfig, textOf } from "./helpers.js";

const GOOD = "4111111111111111";
const form = (n: string, extra = "") => `number=${n}&month=12&year=2030&cvv=123${extra}`;

function setup(issuers: AutomaticCardIssuer[] = [], issuerId?: string) {
  const state = tempState();
  const { outbox, sent } = fakeOutbox();
  const { audit, entries } = fakeAudit();
  const rail = createEgpRail({ state: state as never, outbox, config: testConfig(), audit, publicUrl: "https://agent.example", now: () => NOW, issuers, ...(issuerId ? { issuerId } : {}) });
  const tool = (name: string): RegisteredTool => rail.tools.find((t) => t.spec.name === name)!;
  const run = (name: string, args: unknown, who = owner) => (tool(name).spec as any).execute(args, ctxFor(who));
  return { state, sent, entries, rail, run };
}
const tokenFrom = (sent: Array<{ msg: { text?: string } }>) => /\/egp\/card\/(egp_[a-f0-9]{12})\/([A-Za-z0-9_-]+)/.exec(sent.at(-1)!.msg.text!)!;

describe("egp budget", () => {
  it("is off by default and refuses requests", async () => {
    const t = setup();
    const r = await t.run("egp_card_request", { amountEgp: 100, merchantName: "Noon", context: "x" });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toContain("budget is off");
  });
  it("only the owner sets or reads it", async () => {
    const t = setup();
    expect(isError(await t.run("egp_budget_set", { enabled: true, budgetEgp: 500 }, friend))).toBe(true);
    expect(isError(await t.run("egp_budget_status", {}, friend))).toBe(true);
  });
  it("enforces pool, per-purchase and daily caps, and releases holds", async () => {
    const t = setup();
    await t.run("egp_budget_set", { enabled: true, budgetEgp: 1000, perPurchaseEgp: 400, dailyEgp: 600 });
    expect(isError(await t.run("egp_card_request", { amountEgp: 500, merchantName: "A", context: "c" }))).toBe(true);
    expect(isError(await t.run("egp_card_request", { amountEgp: 400, merchantName: "A", context: "c" }))).toBe(false);
    expect(isError(await t.run("egp_card_request", { amountEgp: 300, merchantName: "B", context: "c" }))).toBe(true); // daily 600
    const id = tokenFrom(t.sent as never)[1];
    await t.run("egp_card_done", { id, outcome: "cancelled" });
    expect(isError(await t.run("egp_card_request", { amountEgp: 300, merchantName: "B", context: "c" }))).toBe(false);
  });
});

describe("egp manual card flow", () => {
  it("owner enters the card on the private page; agent gets it once; it is wiped", async () => {
    const t = setup();
    await t.run("egp_budget_set", { enabled: true, budgetEgp: 1000 });
    const req = await t.run("egp_card_request", { amountEgp: 250, merchantName: "Noon", context: "headphones" });
    expect(textOf(req)).toContain("waiting");
    expect(t.sent.at(-1)!.msg.text).toContain("250 EGP");
    const [, id, token] = tokenFrom(t.sent as never);
    const path = `/egp/card/${id}/${token}`;

    expect((await t.run("egp_card_pickup", { id })).isError).toBe(true); // not yet
    expect(t.rail.handleHttp("GET", path, "")!.status).toBe(200);
    expect(t.rail.handleHttp("POST", path, form("4111111111111112"))!.status).toBe(400); // bad Luhn
    expect(t.rail.handleHttp("POST", path, form(GOOD))!.status).toBe(200);
    expect(t.rail.handleHttp("POST", path, form(GOOD))!.status).toBe(410); // single use

    const got = textOf(await t.run("egp_card_pickup", { id }));
    expect(got).toContain(GOOD);
    expect(isError(await t.run("egp_card_pickup", { id }))).toBe(true); // once only
    expect(fs.readdirSync(t.state.path("egp")).filter((f) => f.endsWith(".card.json"))).toHaveLength(0);

    // card data never reaches the request file or the audit log
    expect(fs.readFileSync(t.state.path("egp-cards.json"), "utf8")).not.toContain(GOOD);
    expect(JSON.stringify(t.entries)).not.toContain(GOOD);

    await t.run("egp_card_done", { id, outcome: "paid", finalAmountEgp: 240 });
    expect(textOf(await t.run("egp_budget_status", {}))).toContain("Available: 760 EGP");
  });
  it("rejects a wrong token and a charge above the approved amount", async () => {
    const t = setup();
    await t.run("egp_budget_set", { enabled: true, budgetEgp: 1000 });
    await t.run("egp_card_request", { amountEgp: 100, merchantName: "A", context: "c" });
    const [, id] = tokenFrom(t.sent as never);
    expect(t.rail.handleHttp("GET", `/egp/card/${id}/${"x".repeat(32)}`, "")!.status).toBe(404);
    expect(isError(await t.run("egp_card_done", { id, outcome: "paid", finalAmountEgp: 150 }))).toBe(true);
  });
  it("ignores paths that are not its own", () => {
    expect(setup().rail.handleHttp("GET", "/status", "")).toBeUndefined();
  });
});

describe("partner foundation", () => {
  it("an automatic issuer plugs in with no other change", async () => {
    const fake: AutomaticCardIssuer = {
      id: "fawry-test",
      label: "Fake partner",
      mode: "automatic",
      issue: async (r) => ({ card: { number: GOOD, expMonth: 12, expYear: 2030, cvv: "321" }, validUntil: new Date(NOW.getTime() + 3600_000) }),
    };
    const t = setup([fake], "fawry-test");
    await t.run("egp_budget_set", { enabled: true, budgetEgp: 500 });
    const req = await t.run("egp_card_request", { amountEgp: 100, merchantName: "A", context: "c" });
    const id = /egp_[a-f0-9]{12}/.exec(textOf(req))![0];
    expect(t.sent).toHaveLength(0); // no manual step
    expect(textOf(await t.run("egp_card_pickup", { id }))).toContain("CVV 321");
  });
  it("a failing partner releases the hold", async () => {
    const bad: AutomaticCardIssuer = { id: "bad", label: "x", mode: "automatic", issue: async () => { throw new Error("down"); } };
    const t = setup([bad], "bad");
    await t.run("egp_budget_set", { enabled: true, budgetEgp: 500 });
    expect(isError(await t.run("egp_card_request", { amountEgp: 100, merchantName: "A", context: "c" }))).toBe(true);
    expect(textOf(await t.run("egp_budget_status", {}))).toContain("Available: 500 EGP");
  });
});

describe("helpers", () => {
  it("luhn and piasters", () => {
    expect(luhn(GOOD)).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
    expect(toPiasters(0)).toBeUndefined();
    expect(toPiasters(12.34)).toBe(1234);
  });
});
