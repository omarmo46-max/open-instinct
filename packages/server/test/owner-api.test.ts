import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOwnerApi } from "../src/owner-api.js";

function api(extra: Partial<Parameters<typeof createOwnerApi>[0]> = {}) {
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
  fs.mkdirSync(path.join(skillsDir, "dining"));
  fs.writeFileSync(path.join(skillsDir, "dining", "SKILL.md"), "---\nname: dining\ndescription: Book tables and\n  make restaurant calls.\n---\n# Dining\n");
  return createOwnerApi({
    config: { agent: { name: "Insty" }, owner: { name: "Omar", timezone: "Africa/Cairo", phones: ["+201001234567"], emails: ["omar@example.com"] } } as never,
    env: {},
    state: { readJson: (_n: string, f: unknown) => f as never, path: (...p: string[]) => path.join(skillsDir, ...p) },
    contacts: { all: () => [{ id: "c1", name: "Sam", tier: "friend", phones: ["+201112223333"], emails: ["sam@example.com"], telegramIds: ["1"], agentHandle: "@sam", notes: "secret note", updatedAt: "2026-11-01" }] } as never,
    approvals: { pending: () => [{ token: "abcdef123456SECRET", toolName: "phone_call", summary: "Call the clinic", createdAt: "x", expiresAt: "y" }] } as never,
    audit: { verify: () => ({ ok: true, entries: 3, unchained: 0, torn: 0 }), read: () => [{ at: "t1", kind: "spend", detail: { a: 1 } }, { at: "t2", kind: "outbound", detail: { b: 2 } }], spentTodayUsd: () => 12.5 } as never,
    scheduler: { list: () => [{ id: "s1", name: "Morning", cron: "0 8 * * *", tz: "Africa/Cairo", prompt: "Brief me", nextRunAt: "n" }] } as never,
    memory: { readDurable: () => "likes tea", preferencesDigest: () => "prefers arabic" } as never,
    keyring: { bundle: () => ({ fingerprint: "ab12" }), peer: (id: string) => (id === "sam" ? {} : undefined) },
    vaultConfigured: true,
    skillsDir,
    channels: { inkboxHandle: "insty", telegram: true, whatsapp: false },
    ...extra,
  });
}

describe("owner API (read-only state for the dashboard)", () => {
  it("masks phones and emails, hides notes tokens, reports pinned keys", async () => {
    const r = await api().handle("people", new URLSearchParams());
    const p = (r.body as any).people[0];
    expect(p.phones).toEqual(["••••3333"]);
    expect(p.emails[0]).toBe("s•••@example.com");
    expect(p.e2eePinned).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("+201112223333");
  });
  it("never exposes a full approval token, and lists activity newest first with the chain check", async () => {
    const a = await api().handle("approvals", new URLSearchParams());
    expect(JSON.stringify(a.body)).not.toContain("SECRET");
    expect((a.body as any).pending[0].id).toBe("abcdef");
    const act = await api().handle("activity", new URLSearchParams("limit=5"));
    expect((act.body as any).entries[0].at).toBe("t2");
    expect((act.body as any).chain.ok).toBe(true);
  });
  it("reads skills, schedules, memory, channels, payments and security", async () => {
    const o = api();
    expect(((await o.handle("skills", new URLSearchParams())).body as any).skills[0]).toEqual({ name: "dining", description: "Book tables and make restaurant calls." });
    expect(((await o.handle("schedules", new URLSearchParams())).body as any).schedules[0].name).toBe("Morning");
    expect(((await o.handle("memory", new URLSearchParams())).body as any).durable).toBe("likes tea");
    const ch = (await o.handle("channels", new URLSearchParams())).body as any;
    expect(ch.telegram).toBe(true);
    expect(ch.ownerPhones).toEqual(["••••4567"]);
    const pay = (await o.handle("payments", new URLSearchParams())).body as any;
    expect(pay.spentTodayUsd).toBe(12.5);
    expect(pay.concierge.enabled).toBe(false);
    const sec = (await o.handle("security", new URLSearchParams())).body as any;
    expect(sec.e2eeFingerprint).toBe("ab12");
    expect(sec.vaultConfigured).toBe(true);
  });
  it("apps: not configured is explicit; connect links validate the toolkit name; unknown resources are 404", async () => {
    expect(((await api().handle("apps", new URLSearchParams())).body as any).configured).toBe(false);
    const withApps = api({ apps: { connectedToolkits: async () => [{ slug: "gmail", connected: true }], connectLink: async (t) => `https://connect.example/${t}`, toolkitSlugs: ["gmail", "github"] } });
    expect(((await withApps.handle("apps", new URLSearchParams())).body as any).toolkits).toHaveLength(1);
    expect((await withApps.handle("apps/connect", new URLSearchParams("toolkit=gmail"))).body).toEqual({ url: "https://connect.example/gmail" });
    expect((await withApps.handle("apps/connect", new URLSearchParams("toolkit=../etc"))).status).toBe(400);
    expect((await api().handle("nope", new URLSearchParams())).status).toBe(404);
  });
});
