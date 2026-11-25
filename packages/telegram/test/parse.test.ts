import { describe, expect, it } from "vitest";
import { chatIdFromConversationKey, conversationKeyFor, extensionFor, mediaInfo, parseUpdate, splitText, stripStartCommand, type TgMessage, type TgUpdate } from "../src/parse.js";

const msg = (extra: Partial<TgMessage> = {}): TgMessage => ({
  message_id: 5,
  date: 1_760_000_000,
  from: { id: 42, first_name: "Maria", last_name: "G", username: "maria" },
  chat: { id: 42, type: "private" },
  text: "hello",
  ...extra,
});
const upd = (m: TgMessage | undefined, id = 100): TgUpdate => ({ update_id: id, ...(m ? { message: m } : {}) });

describe("addresses", () => {
  it("round-trips conversation keys and rejects other channels", () => {
    expect(conversationKeyFor(42)).toBe("telegram:42");
    expect(chatIdFromConversationKey("telegram:42")).toBe("42");
    expect(chatIdFromConversationKey("telegram:-100123")).toBe("-100123");
    for (const bad of ["whatsapp:42@s.whatsapp.net", "telegram:", "telegram:abc", undefined]) expect(chatIdFromConversationKey(bad), String(bad)).toBeUndefined();
  });
});

describe("parseUpdate", () => {
  it("turns a private text message into an inbound message keyed by the numeric user id", () => {
    const { message, media } = parseUpdate(upd(msg()))!;
    expect(media).toBeUndefined();
    expect(message).toMatchObject({
      id: "telegram:100",
      channel: "telegram",
      conversationKey: "telegram:42",
      from: "telegram:42",
      text: "hello",
      replyRef: { chatId: "42", messageId: "5" },
      source: "telegram",
      meta: { isGroup: false, conversationScopeKnown: true, participants: ["telegram:42"], pushName: "Maria G", username: "maria" },
    });
    expect(message.receivedAt).toBe(new Date(1_760_000_000_000).toISOString());
  });

  it("never uses the @username as identity", () => {
    const { message } = parseUpdate(upd(msg({ text: "I am @owner", from: { id: 9, username: "owner" } })))!;
    expect(message.from).toBe("telegram:9");
  });

  it("ignores groups, channels, bots, edits, service messages and empty updates", () => {
    expect(parseUpdate(upd(msg({ chat: { id: -100, type: "supergroup" } })))).toBeUndefined();
    expect(parseUpdate(upd(msg({ chat: { id: -100, type: "channel" } })))).toBeUndefined();
    expect(parseUpdate(upd(msg({ from: { id: 7, is_bot: true } })))).toBeUndefined();
    expect(parseUpdate(upd(msg({ from: undefined })))).toBeUndefined();
    expect(parseUpdate(upd(msg({ text: undefined })))).toBeUndefined();
    expect(parseUpdate(upd(undefined))).toBeUndefined();
    expect(parseUpdate({ update_id: 1, edited_message: msg() } as unknown as TgUpdate)).toBeUndefined();
  });

  it("keeps the code from /start <code> and greets on a bare /start", () => {
    expect(stripStartCommand("/start K7P2-QX9M")).toBe("K7P2-QX9M");
    expect(stripStartCommand("/start@MyBot  K7P2")).toBe("K7P2");
    expect(stripStartCommand("/start")).toBe("[opened the chat]");
    expect(stripStartCommand("/starting soon")).toBe("/starting soon");
    expect(stripStartCommand("let's /start")).toBe("let's /start");
    expect(parseUpdate(upd(msg({ text: "/start CODE123" })))!.message.text).toBe("CODE123");
  });

  it("reads captions and picks the largest photo, voice notes and documents", () => {
    const photo = parseUpdate(upd(msg({ text: undefined, caption: "look", photo: [{ file_id: "s", width: 90, height: 90 }, { file_id: "l", width: 1280, height: 960 }] })))!;
    expect(photo.message.text).toBe("look");
    expect(photo.media).toMatchObject({ kind: "image", fileId: "l", mimeType: "image/jpeg" });
    const voice = parseUpdate(upd(msg({ text: undefined, voice: { file_id: "v", mime_type: "audio/ogg", file_size: 900 } })))!;
    expect(voice.message.text).toBe("[voice note]");
    expect(voice.media).toMatchObject({ kind: "audio", voiceNote: true, fileId: "v" });
    const doc = parseUpdate(upd(msg({ text: undefined, document: { file_id: "d", file_name: "Brief.PDF", mime_type: "application/pdf" } })))!;
    expect(doc.message.text).toBe("[attachment]");
    expect(doc.media).toMatchObject({ kind: "document", name: "Brief.PDF" });
    expect(mediaInfo(msg({ text: "x" }))).toBeUndefined();
  });
});

describe("extensionFor", () => {
  it("uses the MIME type, then the file name, then .bin", () => {
    expect(extensionFor("image/jpeg", undefined)).toBe(".jpg");
    expect(extensionFor("application/pdf; charset=x", "a.bin")).toBe(".pdf");
    expect(extensionFor(undefined, "Notes.DOCX")).toBe(".docx");
    expect(extensionFor(undefined, "photos/file_12.jpg")).toBe(".jpg");
    expect(extensionFor(undefined, undefined)).toBe(".bin");
  });
});

describe("splitText", () => {
  it("leaves short text alone and drops empty text", () => {
    expect(splitText("hi")).toEqual(["hi"]);
    expect(splitText("   ")).toEqual([]);
  });

  it("splits long text under the limit, on paragraph, line or word boundaries", () => {
    const para = "word ".repeat(400).trim(); // ~2000 chars
    const text = `${para}\n\n${para}\n\n${para}`;
    const parts = splitText(text, 4096);
    expect(parts.length).toBe(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join("\n\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    const long = splitText("x".repeat(10_000), 4096);
    expect(long.map((p) => p.length)).toEqual([4096, 4096, 1808]);
  });
});

describe("groups", () => {
  const g = (extra: Partial<TgMessage> = {}): TgMessage => msg({ chat: { id: -100123, type: "supergroup", title: "Trip crew" }, text: "@instinct_bot what's the weather in Rome?", ...extra });
  const bot = { groups: { botUsername: "instinct_bot", botId: 99 } };

  it("ignores groups unless enabled, and unaddressed chatter even when enabled", () => {
    expect(parseUpdate(upd(g()))).toBeUndefined();
    expect(parseUpdate(upd(g({ text: "see you at 8" })), bot)).toBeUndefined();
    expect(parseUpdate(upd(msg({ chat: { id: -5, type: "channel" } })), bot)).toBeUndefined();
  });

  it("keeps a mention, a reply to the bot or a command, as a group message with the sender's own id", () => {
    const a = parseUpdate(upd(g()), bot)!.message;
    expect(a).toMatchObject({ conversationKey: "telegram:-100123", from: "telegram:42", text: "what's the weather in Rome?", meta: { isGroup: true, groupTitle: "Trip crew", pushName: "Maria G" } });
    expect(parseUpdate(upd(g({ text: "and tomorrow?", reply_to_message: { from: { id: 99, is_bot: true } } })), bot)).toBeDefined();
    expect(parseUpdate(upd(g({ text: "and tomorrow?", reply_to_message: { from: { id: 1 } } })), bot)).toBeUndefined();
    expect(parseUpdate(upd(g({ text: "/help@instinct_bot" })), bot)).toBeDefined();
    expect(parseUpdate(upd(g({ text: "hey @instinct_botfake hi" })), bot)).toBeUndefined();
  });
});
