import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ContactStore } from "../src/contacts.js";
import { configFromEnv, telegramIdsFromEnv } from "../src/config.js";
import { normalizeTelegramId, resolvePrincipal } from "../src/principal.js";
import { ownerClaimStatus } from "../src/owner-claim.js";
import { inbound, tempState, testConfig } from "./helpers.js";

const tg = (from: string) => inbound({ channel: "telegram", from, conversationKey: "telegram:1" });

describe("Telegram identity", () => {
  it("normalizes ids and rejects anything that is not a plain user id", () => {
    expect(normalizeTelegramId("telegram:00123")).toBe("123");
    expect(normalizeTelegramId("tg:42")).toBe("42");
    expect(normalizeTelegramId(" 42 ")).toBe("42");
    for (const bad of ["@maria", "", "12a", "-100123", "1".repeat(20)]) expect(normalizeTelegramId(bad), bad).toBeUndefined();
  });

  it("recognises the owner by Telegram user id, and nobody else", () => {
    const config = testConfig({ phones: [], telegramIds: ["777"] });
    const c = new ContactStore(tempState());
    const owner = resolvePrincipal(tg("telegram:777"), config, c);
    expect(owner).toMatchObject({ kind: "owner", id: "owner", tier: "owner" });
    const other = resolvePrincipal(tg("telegram:778"), config, c);
    expect(other.kind).toBe("stranger");
    expect(other.id).toBe("stranger:telegram:telegram:778");
    expect(other.displayName).toBe("Telegram user 778");
  });

  it("does not trust a sender that merely looks like the owner on another address type", () => {
    const config = testConfig({ phones: ["+16175550100"], telegramIds: ["777"] });
    const c = new ContactStore(tempState());
    // The literal sender "777", a username, a phone, an email and "owner" are not Telegram identities.
    for (const from of ["777", "@maria", "+16175550100", "maria@example.com", "owner", "telegram:abc"]) {
      expect(resolvePrincipal(tg(from), config, c).kind, from).toBe("stranger");
    }
    // And a Telegram id is not accepted on a carrier channel.
    expect(resolvePrincipal(inbound({ channel: "imessage", from: "telegram:777" }), config, c).kind).toBe("stranger");
  });

  it("gives contacts their tier by Telegram id, capped at partner", () => {
    const state = tempState();
    const c = new ContactStore(state);
    c.upsert({ name: "Sam Lee", tier: "family", phones: ["+15555550123"] });
    const file = state.path("contacts.json");
    const list = JSON.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    list[0]!["telegramIds"] = ["telegram:900", "900", "not-an-id"];
    list[0]!["tier"] = "staff";
    fs.writeFileSync(file, JSON.stringify(list));
    const fresh = new ContactStore(state);
    expect(fresh.findByTelegram("900")?.telegramIds).toEqual(["900"]);
    const p = resolvePrincipal(tg("telegram:900"), testConfig({ telegramIds: ["777"] }), fresh);
    expect(p.kind).toBe("contact");
    expect(p.tier).toBe("partner");
  });

  it("seeds the owner from TELEGRAM_OWNER_ID and ignores junk", () => {
    expect(telegramIdsFromEnv({ TELEGRAM_OWNER_ID: " 123, tg:456 ;@bob;123 " })).toEqual(["123", "456"]);
    expect(configFromEnv({ TELEGRAM_OWNER_ID: "123" }).owner.telegramIds).toEqual(["123"]);
    expect(configFromEnv({}).owner.telegramIds).toBeUndefined();
  });

  it("closes the owner claim once the owner has a Telegram id", () => {
    const now = new Date("2026-10-15T00:00:00Z");
    const open = testConfig({ phones: [], claimOnFirstContact: true, claimCode: "K7P2-QX9M-4HTB-W8ZD" });
    expect(ownerClaimStatus(open, now).enabled).toBe(true);
    expect(ownerClaimStatus({ ...open, owner: { ...open.owner, telegramIds: ["1"] } }, now).enabled).toBe(false);
  });
});
