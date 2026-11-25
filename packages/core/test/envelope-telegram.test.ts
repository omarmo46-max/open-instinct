import { describe, expect, it } from "vitest";
import { telegramLinkOf, telegramMessageOf } from "../src/envelope.js";

const ok = (over: Record<string, unknown> = {}) => ({
  type: "telegram.message",
  message: { id: "telegram:1", conversationKey: "telegram:42", from: "telegram:42", text: "hi", replyRef: { chatId: "42", messageId: "7" }, receivedAt: "2026-11-24T10:00:00Z", ...over },
});

describe("telegramMessageOf", () => {
  it("rebuilds a private Telegram message from the owner's chat", () => {
    expect(telegramMessageOf(ok())).toMatchObject({ id: "telegram:1", channel: "telegram", from: "telegram:42", conversationKey: "telegram:42", text: "hi", source: "telegram", replyRef: { chatId: "42", messageId: "7" }, meta: { isGroup: false, conversationScopeKnown: true, participants: ["telegram:42"] } });
  });
  it("forces the channel and drops attachments, unknown meta and bad reply refs", () => {
    const m = telegramMessageOf(ok({ channel: "email", attachments: [{ path: "/etc/passwd" }], replyRef: { chatId: "x1", messageId: "7", other: "1" }, meta: { isAdmin: true, pushName: "A" } }))!;
    expect(m.channel).toBe("telegram");
    expect(m.attachments).toBeUndefined();
    expect(m.replyRef).toEqual({ messageId: "7" });
    expect(m.meta).not.toHaveProperty("isAdmin");
    expect(m.meta?.pushName).toBe("A");
  });
  it("keeps a file reference and nothing else about the file", () => {
    const m = telegramMessageOf(ok({ meta: { telegramFile: { fileId: "f1", kind: "audio", voiceNote: true, size: 10, path: "/x" } } }))!;
    expect(m.meta?.telegramFile).toEqual({ fileId: "f1", kind: "audio", voiceNote: true, size: 10 });
  });
  it("rejects groups, mismatched chats, non-Telegram senders and malformed events", () => {
    for (const bad of [
      ok({ conversationKey: "telegram:-100", from: "telegram:42" }),
      ok({ conversationKey: "telegram:43" }),
      ok({ from: "owner" }),
      ok({ from: "telegram:abc", conversationKey: "telegram:abc" }),
      ok({ id: undefined }),
      ok({ text: 5 }),
      { type: "telegram.message" },
      { type: "other", message: {} },
      null,
      "x",
    ]) expect(telegramMessageOf(bad)).toBeUndefined();
  });
  it("falls back to now for a bad timestamp", () => {
    const m = telegramMessageOf(ok({ receivedAt: "nope" }))!;
    expect(Number.isNaN(Date.parse(m.receivedAt))).toBe(false);
  });
});

describe("telegramLinkOf", () => {
  it("accepts numeric ids and normalizes them", () => {
    expect(telegramLinkOf({ type: "telegram.link", telegramId: "00123" })).toEqual({ telegramId: "123" });
  });
  it("rejects anything else", () => {
    for (const bad of [{ type: "telegram.link", telegramId: "@bob" }, { type: "telegram.link", telegramId: 5 }, { type: "telegram.link" }, { type: "x", telegramId: "1" }, null]) expect(telegramLinkOf(bad)).toBeUndefined();
  });
});
