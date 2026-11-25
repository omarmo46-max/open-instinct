import { statSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UserStore, maskPhone, publicUser } from "../src/store.js";
import { readyUser, tempDir } from "./helpers.js";

describe("UserStore", () => {
  it("round-trips records through a 0600 file", () => {
    const dir = tempDir();
    const store = new UserStore(dir);
    const saved = store.save(readyUser());
    expect(saved.updatedAt).toBeTruthy();
    const mode = statSync(store.file).mode & 0o777;
    expect(mode).toBe(0o600);

    const again = new UserStore(dir);
    expect(again.get("usr_test")?.handle).toBe("maria");
    expect(again.byHandle("MARIA")?.id).toBe("usr_test");
    expect(again.byIdentityId("idn_1")?.id).toBe("usr_test");
    expect(again.byPhone("+14155550123")?.id).toBe("usr_test");
    expect(again.all()).toHaveLength(1);
  });

  it("returns copies so callers cannot mutate the cache", () => {
    const store = new UserStore(tempDir());
    store.save(readyUser());
    const u = store.get("usr_test")!;
    u.handle = "hacked";
    expect(store.get("usr_test")?.handle).toBe("maria");
  });

  it("removes records and keeps the file valid json", () => {
    const store = new UserStore(tempDir());
    store.save(readyUser({ id: "a", handle: "a-handle" }));
    store.save(readyUser({ id: "b", handle: "b-handle", phone: "+14155550124" }));
    expect(store.remove("a")).toBe(true);
    expect(store.remove("a")).toBe(false);
    const parsed = JSON.parse(readFileSync(store.file, "utf8"));
    expect(parsed.users.map((u: { id: string }) => u.id)).toEqual(["b"]);
  });

  it("publicUser strips secrets, the name and the error text", () => {
    const pub = publicUser(readyUser({ status: "error", error: "Maritime 402: wallet empty for Maria" }));
    const text = JSON.stringify(pub);
    expect(text).not.toContain("ik_secret");
    expect(text).not.toContain("whsec_");
    expect(text).not.toContain("+14155550123");
    expect(text).not.toContain("Maria");
    expect(text).not.toContain("402");
    expect(pub["status"]).toBe("error");
    expect(pub["hasError"]).toBe(true);
    expect(publicUser(readyUser())["status"]).toBe("ready");
    expect(maskPhone("+14155550123")).toBe("+1••••••0123");
  });
});

describe("Telegram lookups", () => {
  const user = (over: Record<string, unknown> = {}) => ({
    id: "usr_t1", name: "T", phone: "+15555550100", handle: "t1", identityId: "i", identityApiKey: "k", signingKey: "s",
    createdAt: new Date().toISOString(), status: "ready" as const, ...over,
  });

  it("finds a person by Telegram id, agent token and unexpired link code, and nothing else", () => {
    const dir = tempDir();
    const store = new UserStore(dir);
    store.save(user({ telegramId: "555", agentToken: "tok-1", telegramLink: { code: "CODE-ABCDEFGHIJKLM", expiresAt: new Date(Date.now() + 60_000).toISOString() } }));
    expect(store.byTelegramId("555")?.id).toBe("usr_t1");
    expect(store.byTelegramId("556")).toBeUndefined();
    expect(store.byTelegramId("")).toBeUndefined();
    expect(store.byAgentToken("tok-1")?.id).toBe("usr_t1");
    expect(store.byAgentToken("tok-2")).toBeUndefined();
    expect(store.byAgentToken("")).toBeUndefined();
    expect(store.byTelegramLinkCode("CODE-ABCDEFGHIJKLM")?.id).toBe("usr_t1");
    expect(store.byTelegramLinkCode("CODE-ABCDEFGHIJKLX")).toBeUndefined();
    expect(store.byTelegramLinkCode("CODE-ABCDEFGHIJKLM", Date.now() + 120_000)).toBeUndefined();
  });

  it("never shows the agent token, link code or Telegram id in the public record", () => {
    const pub = JSON.stringify(publicUser(user({ telegramId: "555", agentToken: "tok-1", telegramLink: { code: "X", expiresAt: "2030-01-01T00:00:00Z" } }) as never));
    expect(pub).not.toContain("tok-1");
    expect(pub).not.toContain("555");
    expect(pub).not.toContain("telegramLink");
  });
});
