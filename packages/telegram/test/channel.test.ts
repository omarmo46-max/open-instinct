import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InboundMessage } from "@orion-ai/core";
import { TelegramChannel } from "../src/channel.js";

const TOKEN = "123456:SECRET-token";

interface Call { method: string; body: Record<string, unknown> }

/** A fake Bot API. `updates` are handed out once by getUpdates; later polls hang until aborted. */
function fakeApi(opts: { updates?: unknown[]; fail?: Record<string, { code: number; description: string }>; files?: Record<string, Uint8Array> } = {}) {
  const calls: Call[] = [];
  let handedOut = false;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/file/bot")) {
      const file = opts.files?.[url.split("/file/bot")[1]!.split("/").slice(1).join("/")];
      return new Response(file ? Buffer.from(file) : "nope", { status: file ? 200 : 404 });
    }
    const method = url.split(`/bot${TOKEN}/`)[1]!;
    // Uploads are multipart: keep the text fields, the file is checked by the tests that send it.
    const body = init?.body instanceof FormData
      ? (Object.fromEntries([...init.body.entries()].filter(([, v]) => typeof v === "string")) as Record<string, unknown>)
      : (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    calls.push({ method, body });
    const failure = opts.fail?.[method];
    if (failure) return Response.json({ ok: false, error_code: failure.code, description: failure.description });
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, username: "instinct_bot" } });
    if (method === "getFile") return Response.json({ ok: true, result: { file_path: `photos/${body.file_id}.jpg`, file_size: 4 } });
    if (method === "getUpdates") {
      if (!handedOut && opts.updates) {
        handedOut = true;
        return Response.json({ ok: true, result: opts.updates });
      }
      // Hang like a long poll until the channel stops.
      await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new DOMException("aborted", "AbortError");
    }
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tg-"));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const textUpdate = (id: number, text: string, from = 42) => ({
  update_id: id,
  message: { message_id: id, date: 1_760_000_000, from: { id: from, first_name: "Maria" }, chat: { id: from, type: "private" }, text },
});

function channel(api: ReturnType<typeof fakeApi>, got: InboundMessage[] = [], extra: Partial<ConstructorParameters<typeof TelegramChannel>[0]> = {}) {
  const dir = tmp();
  const logs: string[] = [];
  const ch = new TelegramChannel({
    token: TOKEN,
    mediaDir: path.join(dir, "inbound"),
    offsetFile: path.join(dir, "secrets", "offset.json"),
    onInbound: (m) => { got.push(m); },
    logger: (m) => logs.push(m),
    fetchImpl: api.fetchImpl,
    ...extra,
  });
  return { ch, dir, logs, got };
}

describe("TelegramChannel", () => {
  it("checks the token, clears any webhook, hands inbound messages over and remembers the offset", async () => {
    const api = fakeApi({ updates: [textUpdate(10, "hi"), { update_id: 11, message: { message_id: 1, date: 1, chat: { id: -5, type: "group" }, from: { id: 1 }, text: "ignored" } }] });
    const { ch, dir, got, logs } = channel(api);
    await ch.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(ch.status()).toBe("open");
    expect(ch.username()).toBe("instinct_bot");
    expect(api.calls.map((c) => c.method).slice(0, 3)).toEqual(["getMe", "deleteWebhook", "getUpdates"]);
    expect(got.map((m) => [m.id, m.from, m.text])).toEqual([["telegram:10", "telegram:42", "hi"]]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "secrets", "offset.json"), "utf8"))).toEqual({ offset: 12 });
    expect(logs.join("\n")).toContain("@instinct_bot");
    expect(logs.join("\n")).not.toContain("SECRET");
    await ch.stop();
    expect(ch.status()).toBe("closed");
  });

  it("resumes from the saved offset after a restart", async () => {
    const api = fakeApi();
    const { ch, dir } = channel(api);
    fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "secrets", "offset.json"), JSON.stringify({ offset: 77 }));
    await ch.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(api.calls.find((c) => c.method === "getUpdates")?.body).toMatchObject({ offset: 77, allowed_updates: ["message"] });
    await ch.stop();
  });

  it("stops for good on a rejected token and never prints it", async () => {
    const api = fakeApi({ fail: { getMe: { code: 401, description: "Unauthorized" } } });
    const { ch, logs } = channel(api);
    await ch.start();
    expect(ch.status()).toBe("unauthorized");
    expect(logs.join("\n")).toContain("token was rejected");
    expect(logs.join("\n")).not.toContain("SECRET");
    expect(api.calls.some((c) => c.method === "getUpdates")).toBe(false);
    await ch.stop();
    expect(ch.status()).toBe("unauthorized");
  });

  it("downloads media into the inbound folder, hashed, and attaches it", async () => {
    const api = fakeApi({
      updates: [{ update_id: 20, message: { message_id: 3, date: 1, from: { id: 42 }, chat: { id: 42, type: "private" }, caption: "receipt", photo: [{ file_id: "big", width: 800, height: 600, file_size: 4 }] } }],
      files: { "photos/big.jpg": new Uint8Array([1, 2, 3, 4]) },
    });
    const { ch, dir, got } = channel(api);
    await ch.start();
    await new Promise((r) => setTimeout(r, 100));
    await ch.stop();
    const att = got[0]?.attachments?.[0];
    expect(att?.path?.startsWith(path.join(dir, "inbound"))).toBe(true);
    expect(att?.path).toMatch(/[0-9a-f]{64}\.jpg$/);
    expect([...fs.readFileSync(att!.path!)]).toEqual([1, 2, 3, 4]);
    expect(got[0]?.text).toBe("receipt");
  });

  it("keeps the message and says so when the file is too large", async () => {
    const api = fakeApi({ updates: [{ update_id: 21, message: { message_id: 4, date: 1, from: { id: 42 }, chat: { id: 42, type: "private" }, document: { file_id: "d", file_name: "huge.zip", file_size: 50_000_000 } } }] });
    const { ch, got } = channel(api);
    await ch.start();
    await new Promise((r) => setTimeout(r, 100));
    await ch.stop();
    expect(got[0]?.attachments).toBeUndefined();
    expect(got[0]?.text).toContain("could not be downloaded: too large");
    expect(api.calls.some((c) => c.method === "getFile")).toBe(false);
  });

  it("does not advance past a message whose hand-over failed", async () => {
    const api = fakeApi({ updates: [textUpdate(30, "boom")] });
    const { ch, dir, logs } = channel(api, [], { onInbound: () => { throw new Error("inbox full"); } });
    await ch.start();
    await new Promise((r) => setTimeout(r, 100));
    await ch.stop();
    expect(fs.existsSync(path.join(dir, "secrets", "offset.json"))).toBe(false);
    expect(logs.join("\n")).toContain("inbox full");
  });

  it("sends replies to the conversation's chat, split in order, with reply threading on the first piece", async () => {
    const api = fakeApi();
    const { ch } = channel(api);
    await ch.send({ channel: "telegram", conversationKey: "telegram:42", text: `${"a".repeat(4000)} ${"b".repeat(4000)}`, replyToMessageId: "9" }, { principal: undefined as never, conversationKey: "telegram:42" });
    const sends = api.calls.filter((c) => c.method === "sendMessage");
    expect(sends).toHaveLength(2);
    expect(sends[0]!.body).toMatchObject({ chat_id: "42", reply_parameters: { message_id: 9 } });
    expect(sends[1]!.body.reply_parameters).toBeUndefined();
    expect((sends[0]!.body.text as string).length).toBeLessThanOrEqual(4096);
    expect(sends.every((s) => s.body.parse_mode === undefined)).toBe(true);
  });

  it("can start a chat with a numeric user id, and refuses addresses that are not one", async () => {
    const api = fakeApi();
    const { ch } = channel(api);
    const ctx = { principal: undefined as never, conversationKey: "x" };
    await ch.send({ channel: "telegram", to: "telegram:777", text: "hello" }, ctx);
    expect(api.calls.at(-1)).toMatchObject({ method: "sendMessage", body: { chat_id: "777", text: "hello" } });
    await expect(ch.send({ channel: "telegram", to: "@someone", text: "x" }, ctx)).rejects.toThrow(/numeric Telegram user id/);
    await expect(ch.send({ channel: "telegram", to: "+15555550100", text: "x" }, ctx)).rejects.toThrow();
  });

  it("falls back to the plain link when Telegram cannot fetch a file URL, and scrubs the token from errors", async () => {
    const api = fakeApi({ fail: { sendDocument: { code: 400, description: "wrong file identifier/HTTP URL specified" } } });
    const { ch, logs } = channel(api);
    await ch.send({ channel: "telegram", conversationKey: "telegram:42", text: "here", mediaUrls: ["https://example.com/a.pdf"] }, { principal: undefined as never, conversationKey: "telegram:42" });
    expect(api.calls.at(-1)).toMatchObject({ method: "sendMessage", body: { chat_id: "42", text: "https://example.com/a.pdf" } });
    expect(logs.join("\n")).not.toContain("SECRET");
  });

  it("only shows typing once connected", async () => {
    const api = fakeApi();
    const { ch } = channel(api);
    await ch.typing("telegram:42");
    expect(api.calls).toHaveLength(0);
    await ch.start();
    await ch.typing("telegram:42");
    expect(api.calls.find((c) => c.method === "sendChatAction")?.body).toEqual({ chat_id: "42", action: "typing" });
    await ch.stop();
  });

  it("refuses an empty token", () => {
    expect(() => new TelegramChannel({ token: " ", mediaDir: "x", offsetFile: "y", onInbound: () => {} })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  describe("sendFile", () => {
    const ctx = { principal: undefined as never, conversationKey: "telegram:42" };
    const fileCalls = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method === "sendPhoto" || c.method === "sendDocument");

    it("uploads pictures as photos and everything else as documents, with the caption", async () => {
      const forms: Array<{ method: string; form: FormData }> = [];
      const base = fakeApi();
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const method = String(url).split(`/bot${TOKEN}/`)[1]!;
        if (init?.body instanceof FormData) {
          forms.push({ method, form: init.body });
          expect((init.headers as Record<string, string> | undefined)?.["content-type"]).toBeUndefined();
          return Response.json({ ok: true, result: true });
        }
        return base.fetchImpl(url, init);
      }) as unknown as typeof fetch;
      const { ch } = channel({ calls: base.calls, fetchImpl });
      await ch.sendFile({ conversationKey: "telegram:42", filename: "a.png", contentType: "image/png", content: Buffer.from([1, 2]), caption: "chart" });
      await ch.sendFile({ to: "telegram:77", filename: "brief.pdf", contentType: "application/pdf", content: Buffer.from("%PDF") });
      expect(forms.map((f) => f.method)).toEqual(["sendPhoto", "sendDocument"]);
      expect(forms[0]!.form.get("chat_id")).toBe("42");
      expect(forms[0]!.form.get("caption")).toBe("chart");
      expect((forms[0]!.form.get("photo") as File).name).toBe("a.png");
      expect(forms[1]!.form.get("chat_id")).toBe("77");
      expect((forms[1]!.form.get("document") as File).name).toBe("brief.pdf");
      expect(forms[1]!.form.get("caption")).toBeNull();
    });

    it("sends a caption that is too long as its own message", async () => {
      const api = fakeApi();
      const { ch } = channel(api);
      await ch.sendFile({ conversationKey: "telegram:42", filename: "a.pdf", contentType: "application/pdf", content: Buffer.from("x"), caption: "c".repeat(1500) });
      expect(fileCalls(api)).toHaveLength(1);
      const msgs = api.calls.filter((c) => c.method === "sendMessage");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.body).toMatchObject({ chat_id: "42" });
      void ctx;
    });

    it("refuses empty, oversized and unaddressed files before any request", async () => {
      const api = fakeApi();
      const { ch } = channel(api);
      await expect(ch.sendFile({ conversationKey: "telegram:42", filename: "a", contentType: "text/plain", content: Buffer.alloc(0) })).rejects.toThrow(/empty/);
      await expect(ch.sendFile({ conversationKey: "telegram:42", filename: "a", contentType: "text/plain", content: Buffer.alloc(50 * 1024 * 1024 + 1) })).rejects.toThrow(/50 MB/);
      await expect(ch.sendFile({ to: "@someone", filename: "a", contentType: "text/plain", content: Buffer.from("x") })).rejects.toThrow(/numeric Telegram user id/);
      expect(api.calls).toHaveLength(0);
    });
  });
});
