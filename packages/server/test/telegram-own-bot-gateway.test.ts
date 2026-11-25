import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { boot, GatewayNotices, type BootResult } from "../src/boot.js";

describe("GatewayNotices", () => {
  it("tells the person where the agent really is, in both languages, once an hour per chat", async () => {
    const sent: Array<{ conversationKey: string; text: string }> = [];
    let now = 1_000_000;
    const notices = new GatewayNotices({ username: () => "maria_bot" }, { send: async (m) => void sent.push(m) }, () => {}, () => now);
    notices.notify("555");
    notices.notify("555");
    notices.notify("777");
    await Promise.resolve();
    expect(sent.map((m) => m.conversationKey)).toEqual(["telegram:555", "telegram:777"]);
    expect(sent[0]!.text).toContain("@maria_bot");
    expect(sent[0]!.text).toMatch(/[\u0600-\u06FF]/);
    now += 61 * 60_000;
    notices.notify("555");
    await Promise.resolve();
    expect(sent).toHaveLength(3);
  });

  it("falls back to a generic line when the bot name is not known yet, and survives a failing gateway", async () => {
    const logs: string[] = [];
    const sent: string[] = [];
    const ok = new GatewayNotices({ username: () => undefined }, { send: async (m) => void sent.push(m.text) }, () => {});
    ok.notify("1");
    await Promise.resolve();
    expect(sent[0]).toContain("its own Telegram bot");
    const bad = new GatewayNotices({ username: () => "b" }, { send: async () => { throw new Error("down"); } }, (m) => logs.push(m));
    expect(() => bad.notify("2")).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(logs.some((l) => l.includes("down"))).toBe(true);
  });
});

describe("boot: own Telegram bot and a gateway at once", () => {
  let dataDir: string;
  let app: BootResult | undefined;
  const logs: string[] = [];
  let gatewaySends: Array<{ url: string; body: { chatId?: string; text?: string } }>;

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://gw.test/")) {
      gatewaySends.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : {} });
      return json({ ok: true });
    }
    if (url.includes("/getMe")) return json({ ok: true, result: { id: 1, is_bot: true, username: "maria_bot" } });
    if (url.includes("/getUpdates")) {
      await new Promise((r) => setTimeout(r, 40));
      return json({ ok: true, result: [] });
    }
    return json({ ok: true, result: true });
  }) as typeof fetch;

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    INSTINCT_DATA_DIR: dataDir,
    INSTINCT_OWNER_NAME: "Maria",
    INSTINCT_OWNER_PHONE: "+14155550000",
    INSTINCT_AGENT_NAME: "Smoke",
    INSTINCT_MODEL: "faux/faux-1",
    INSTINCT_COMPUTER: "none",
    INSTINCT_SKILLS_DIR: join(dataDir, "no-skills"),
    TELEGRAM_OWNER_ID: "555",
    TELEGRAM_GATEWAY_URL: "https://gw.test",
    TELEGRAM_GATEWAY_TOKEN: "agent-token",
    ...extra,
  });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "instinct-own-bot-"));
    logs.length = 0;
    gatewaySends = [];
    vi.stubGlobal("fetch", fakeFetch);
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllGlobals();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function bootWith(extra: NodeJS.ProcessEnv): Promise<BootResult> {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const streamFn = models.streamSimple.bind(models) as unknown as StreamFn;
    app = await boot(env(extra), { model: faux.getModel("faux-1"), streamFn, logger: (m) => logs.push(m), fetchImpl: fakeFetch });
    return app;
  }

  it("the own bot wins, says so in the log, and points a person of the shared bot to it", async () => {
    const result = await bootWith({ TELEGRAM_BOT_TOKEN: "1:abc" });
    expect(result.telegramOwnBot).toBe(true);
    expect(logs.some((l) => l.includes("uses its own bot and ignores the gateway"))).toBe(true);
    expect(logs.some((l) => l.includes("through the gateway"))).toBe(false);
    result.onGatewayTelegram?.("message", "555");
    await new Promise((r) => setTimeout(r, 20));
    expect(gatewaySends).toHaveLength(1);
    expect(gatewaySends[0]!.url).toBe("https://gw.test/api/agent/telegram/send");
    expect(gatewaySends[0]!.body.chatId).toBe("555");
    expect(gatewaySends[0]!.body.text).toContain("@maria_bot");
  });

  it("TELEGRAM_ENABLED=0 hands Telegram to the gateway instead, with no warning", async () => {
    const result = await bootWith({ TELEGRAM_BOT_TOKEN: "1:abc", TELEGRAM_ENABLED: "0" });
    expect(result.telegramOwnBot).toBeUndefined();
    expect(result.onGatewayTelegram).toBeUndefined();
    expect(logs.some((l) => l.includes("through the gateway"))).toBe(true);
    expect(logs.some((l) => l.includes("ignores the gateway"))).toBe(false);
  });

  it("a gateway alone, or an own bot alone, behaves as before", async () => {
    const gw = await bootWith({});
    expect(gw.telegramOwnBot).toBeUndefined();
    expect(logs.some((l) => l.includes("through the gateway"))).toBe(true);
    await app?.close();
    logs.length = 0;
    const own = await bootWith({ TELEGRAM_BOT_TOKEN: "1:abc", TELEGRAM_GATEWAY_URL: "", TELEGRAM_GATEWAY_TOKEN: "" });
    expect(own.telegramOwnBot).toBe(true);
    expect(own.onGatewayTelegram).toBeUndefined();
    expect(logs.some((l) => l.includes("ignores the gateway"))).toBe(false);
  });
});
