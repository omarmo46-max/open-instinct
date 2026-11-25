import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InboundMessage } from "@open-instinct/core";
import { telegramMessageOf } from "@open-instinct/core";
import { GatewayTelegramChannel } from "@open-instinct/telegram";
import { HUB_TEXT, TelegramHub } from "../src/telegram-hub.js";
import { UserStore, type UserRecord } from "../src/store.js";
import type { RelayResult } from "../src/relay.js";

const TOKEN = "123456:BOT-SECRET";

interface Sent { method: string; body: Record<string, unknown> }

/** A fake Bot API with a queue of updates, a log of everything the bot sent, and downloadable files. */
function fakeTelegram() {
  const queue: unknown[] = [];
  const sent: Sent[] = [];
  const files: Record<string, Uint8Array> = {};
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/file/bot")) {
      const f = files[url.split("/file/bot")[1]!.split("/").slice(1).join("/")];
      return new Response(f ? Buffer.from(f) : "nope", { status: f ? 200 : 404 });
    }
    const method = url.split(`/bot${TOKEN}/`)[1]!;
    const body = init?.body instanceof FormData
      ? ({ ...Object.fromEntries([...init.body.entries()].filter(([, v]) => typeof v === "string")), file: [...init.body.entries()].find(([, v]) => typeof v !== "string")?.[1] } as Record<string, unknown>)
      : (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, username: "hub_bot" } });
    if (method === "getFile") return Response.json({ ok: true, result: { file_path: `files/${body.file_id}`, file_size: 4 } });
    if (method === "getUpdates") {
      const out = queue.splice(0);
      if (out.length === 0) await new Promise((r) => setTimeout(r, 25));
      return Response.json({ ok: true, result: out });
    }
    if (method !== "deleteWebhook") sent.push({ method, body });
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
  let n = 1000;
  const text = (from: number, text: string) => queue.push({ update_id: ++n, message: { message_id: n, date: 1_760_000_000, from: { id: from, first_name: "P" }, chat: { id: from, type: "private" }, text } });
  const photo = (from: number, fileId: string) => queue.push({ update_id: ++n, message: { message_id: n, date: 1_760_000_000, from: { id: from }, chat: { id: from, type: "private" }, photo: [{ file_id: fileId, width: 10, height: 10, file_size: 4 }] } });
  return { fetchImpl, sent, files, text, photo };
}

const dirs: string[] = [];
const stoppers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stoppers.splice(0)) await s().catch(() => undefined);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const user = (over: Partial<UserRecord> = {}): UserRecord => ({
  id: "usr_a1", name: "Maria", phone: "+15555550100", handle: "maria", identityId: "i1", identityApiKey: "k", signingKey: "s",
  agentToken: "agent-token-maria", maritimeAgentId: "ag1", createdAt: new Date().toISOString(), status: "ready", ...over,
});

async function setup(opts: { users?: UserRecord[]; relay?: (u: UserRecord, e: Record<string, unknown>, c: string) => Promise<RelayResult>; rate?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-"));
  dirs.push(dir);
  const store = new UserStore(dir);
  for (const u of opts.users ?? [user()]) store.save(u);
  const tg = fakeTelegram();
  const relayed: Array<{ user: string; event: Record<string, unknown>; conversationId: string }> = [];
  const hub = new TelegramHub({
    store, token: TOKEN, dataDir: dir, pollSeconds: 1, fetchImpl: tg.fetchImpl,
    ...(opts.rate ? { agentRatePerMinute: opts.rate } : {}),
    relay: opts.relay ?? (async (u, event, conversationId) => { relayed.push({ user: u.id, event, conversationId }); return { status: "forwarded" }; }),
  });
  await hub.start();
  stoppers.push(() => hub.stop());
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://hub.local");
    hub.handleHttp(req, res, url.pathname.split("/").filter(Boolean), url).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stoppers.push(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { dir, store, tg, hub, relayed, base };
}

describe("TelegramHub: Telegram to agents", () => {
  it("tells an unlinked person how to connect, once a minute, in both languages", async () => {
    const h = await setup();
    h.tg.text(555, "hello");
    await waitFor(() => h.tg.sent.length >= 1);
    expect(h.tg.sent[0]!.body).toMatchObject({ chat_id: "555", text: HUB_TEXT.welcome });
    expect(HUB_TEXT.welcome).toMatch(/[\u0600-\u06FF]/);
    h.tg.text(555, "hello again");
    await new Promise((r) => setTimeout(r, 150));
    expect(h.tg.sent).toHaveLength(1);
    expect(h.relayed).toHaveLength(0);
  });

  it("links a Telegram account with the one-time code, tells the agent, and spends the code", async () => {
    const h = await setup();
    const url = h.hub.linkUrlFor(user())!;
    expect(url).toMatch(/^https:\/\/t\.me\/hub_bot\?start=[A-Za-z0-9_-]{16}$/);
    expect(h.hub.linkUrlFor(user())).toBe(url);
    const code = url.split("start=")[1]!;
    h.tg.text(555, `/start ${code}`);
    await waitFor(() => h.relayed.length >= 1);
    expect(h.store.get("usr_a1")?.telegramId).toBe("555");
    expect(h.store.get("usr_a1")?.telegramLink).toBeUndefined();
    expect(h.relayed[0]).toMatchObject({ user: "usr_a1", event: { type: "telegram.link", telegramId: "555" } });
    expect(h.tg.sent.at(-1)!.body).toMatchObject({ chat_id: "555", text: HUB_TEXT.linked });
    // The same code from another account is refused.
    h.tg.text(777, `/start ${code}`);
    await waitFor(() => h.tg.sent.some((s) => s.body.chat_id === "777"));
    expect(h.tg.sent.find((s) => s.body.chat_id === "777")!.body.text).toBe(HUB_TEXT.badCode);
    expect(h.store.byTelegramId("777")).toBeUndefined();
  });

  it("refuses an expired code and never accepts a guess", async () => {
    let now = Date.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-"));
    dirs.push(dir);
    const store = new UserStore(dir);
    store.save(user());
    const tg = fakeTelegram();
    const hub = new TelegramHub({ store, token: TOKEN, dataDir: dir, pollSeconds: 1, fetchImpl: tg.fetchImpl, now: () => now, relay: async () => ({ status: "forwarded" }) });
    await hub.start();
    stoppers.push(() => hub.stop());
    const code = hub.linkUrlFor(user())!.split("start=")[1]!;
    now += 31 * 60_000;
    tg.text(555, `/start ${code}`);
    tg.text(556, "/start AAAAAAAAAAAAAAAAAAAA");
    await waitFor(() => tg.sent.length >= 2);
    expect(tg.sent.map((s) => s.body.text)).toEqual([HUB_TEXT.badCode, HUB_TEXT.badCode]);
    expect(store.get("usr_a1")?.telegramId).toBeUndefined();
  });

  it("relays a linked person's message to their own agent as a telegram.message event", async () => {
    const h = await setup({ users: [user({ telegramId: "555" }), user({ id: "usr_b2", handle: "omar", agentToken: "tok-omar", telegramId: "666", phone: "+15555550101", identityId: "i2" })] });
    h.tg.text(555, "book me a table");
    h.tg.text(666, "what's on today?");
    await waitFor(() => h.relayed.length >= 2);
    const maria = h.relayed.find((r) => r.user === "usr_a1")!;
    expect(maria.conversationId).toBe("telegram:555");
    const msg = telegramMessageOf(maria.event)!;
    expect(msg).toMatchObject({ channel: "telegram", from: "telegram:555", text: "book me a table", conversationKey: "telegram:555" });
    expect(h.relayed.find((r) => r.user === "usr_b2")!.conversationId).toBe("telegram:666");
    expect(h.tg.sent).toHaveLength(0);
  });
});

describe("TelegramHub: agents to Telegram, through the agent's own channel", () => {
  const remote = (base: string, token: string, dir: string, fetchImpl?: typeof fetch) =>
    new GatewayTelegramChannel({ gatewayUrl: base, token, mediaDir: path.join(dir, "inbound"), ...(fetchImpl ? { fetchImpl } : {}) });

  it("lets an agent write, show typing and send files, only to its owner's chat", async () => {
    const h = await setup({ users: [user({ telegramId: "555" })] });
    const agent = remote(h.base, "agent-token-maria", h.dir);
    await agent.send({ channel: "telegram", conversationKey: "telegram:555", text: "done ✅", replyToMessageId: "9" });
    expect(h.tg.sent.at(-1)).toMatchObject({ method: "sendMessage", body: { chat_id: "555", text: "done ✅", reply_parameters: { message_id: 9 } } });
    await agent.typing("telegram:555");
    expect(h.tg.sent.at(-1)).toMatchObject({ method: "sendChatAction", body: { chat_id: "555", action: "typing" } });
    await agent.sendFile({ conversationKey: "telegram:555", filename: "brief.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4"), caption: "here" });
    const doc = h.tg.sent.at(-1)!;
    expect(doc.method).toBe("sendDocument");
    expect(doc.body).toMatchObject({ chat_id: "555", caption: "here" });
    expect((doc.body.file as File).name).toBe("brief.pdf");
  });

  it("refuses another chat, no token, a wrong token and an unlinked agent", async () => {
    const h = await setup({ users: [user({ telegramId: "555" }), user({ id: "usr_c3", handle: "sam", agentToken: "tok-sam", identityId: "i3", phone: "+15555550102" })] });
    const maria = remote(h.base, "agent-token-maria", h.dir);
    await expect(maria.send({ channel: "telegram", conversationKey: "telegram:999", text: "hi stranger" })).rejects.toThrow(/403/);
    await expect(remote(h.base, "wrong-token", h.dir).send({ channel: "telegram", conversationKey: "telegram:555", text: "x" })).rejects.toThrow(/401/);
    const bare = await fetch(`${h.base}/api/agent/telegram/send`, { method: "POST", body: "{}" });
    expect(bare.status).toBe(401);
    await expect(remote(h.base, "tok-sam", h.dir).send({ channel: "telegram", conversationKey: "telegram:555", text: "x" })).rejects.toThrow(/409/);
    expect(h.tg.sent).toHaveLength(0);
  });

  it("rate limits one agent without affecting another", async () => {
    const h = await setup({ rate: 3, users: [user({ telegramId: "555" }), user({ id: "usr_b2", handle: "omar", agentToken: "tok-omar", telegramId: "666", identityId: "i2", phone: "+15555550101" })] });
    const a = remote(h.base, "agent-token-maria", h.dir);
    for (let i = 0; i < 3; i++) await a.send({ channel: "telegram", conversationKey: "telegram:555", text: `m${i}` });
    await expect(a.send({ channel: "telegram", conversationKey: "telegram:555", text: "too many" })).rejects.toThrow(/429/);
    await remote(h.base, "tok-omar", h.dir).send({ channel: "telegram", conversationKey: "telegram:666", text: "fine" });
  });

  it("hands over a file sent to the agent, and only to the agent whose chat it came from", async () => {
    const h = await setup({ users: [user({ telegramId: "555" }), user({ id: "usr_b2", handle: "omar", agentToken: "tok-omar", telegramId: "666", identityId: "i2", phone: "+15555550101" })] });
    h.tg.files["files/photo1"] = new Uint8Array([9, 8, 7, 6]);
    h.tg.photo(555, "photo1");
    await waitFor(() => h.relayed.length >= 1);
    const event = h.relayed[0]!.event;
    const message = telegramMessageOf(event) as InboundMessage;
    expect(message.meta?.telegramFile).toMatchObject({ fileId: "photo1", kind: "image" });
    expect(message.attachments).toBeUndefined();
    const hydrated = await remote(h.base, "agent-token-maria", h.dir).hydrate(message);
    const att = hydrated.attachments?.[0];
    expect(att?.path).toMatch(/inbound[\\/][0-9a-f]{64}\.jpg$/);
    expect([...fs.readFileSync(att!.path!)]).toEqual([9, 8, 7, 6]);
    expect(hydrated.meta?.telegramFile).toBeUndefined();
    // Another person's agent cannot fetch it, and the failure is a line of text, not a crash.
    const stolen = await remote(h.base, "tok-omar", h.dir).hydrate(message);
    expect(stolen.attachments).toBeUndefined();
    expect(stolen.text).toContain("could not be downloaded");
  });
});
