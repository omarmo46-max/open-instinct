/**
 * Pure helpers: Telegram updates to Open Instinct messages, conversation keys, and message
 * splitting. No network here, so all of it is unit tested.
 *
 * Identity: the sender is the numeric Telegram user id (`from.id`), which Telegram itself
 * puts on every update. @usernames can be changed or released, so they are only display data.
 */
import type { InboundMessage } from "@open-instinct/core";

export const CONVERSATION_PREFIX = "telegram:";
export const ADDRESS_PREFIX = "telegram:";
/** Telegram refuses a text message longer than this many characters. */
export const TELEGRAM_TEXT_LIMIT = 4096;
/** Bots can download files up to 20 MB through the Bot API. */
export const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

export interface TgUser { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
export interface TgChat { id: number; type: "private" | "group" | "supergroup" | "channel" | string; title?: string }
interface TgFile { file_id: string; file_unique_id?: string; file_size?: number; mime_type?: string; file_name?: string }
export interface TgMessage {
  message_id: number;
  date: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  photo?: Array<TgFile & { width?: number; height?: number }>;
  voice?: TgFile;
  audio?: TgFile;
  video?: TgFile;
  video_note?: TgFile;
  animation?: TgFile;
  document?: TgFile;
  sticker?: TgFile;
  reply_to_message?: { from?: TgUser };
}
export interface TgUpdate { update_id: number; message?: TgMessage }

export type MediaKind = "image" | "audio" | "video" | "document" | "sticker";
export interface MediaInfo { kind: MediaKind; fileId: string; mimeType?: string; name?: string; size?: number; voiceNote?: boolean }

export function conversationKeyFor(chatId: number | string): string {
  return `${CONVERSATION_PREFIX}${chatId}`;
}

export function chatIdFromConversationKey(key: string | undefined): string | undefined {
  const id = key?.startsWith(CONVERSATION_PREFIX) ? key.slice(CONVERSATION_PREFIX.length) : undefined;
  return id && /^-?\d{1,20}$/.test(id) ? id : undefined;
}

/** The `from` address used for identity: `telegram:<user id>`. */
export function addressFor(userId: number | string): string {
  return `${ADDRESS_PREFIX}${userId}`;
}

/** Group, supergroup and channel chats are out of scope: the agent talks one to one. */
export function isPrivateChat(chat: TgChat | undefined): boolean {
  return chat?.type === "private";
}

export function displayName(user: TgUser | undefined): string | undefined {
  if (!user) return undefined;
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return full || (user.username ? `@${user.username}` : undefined);
}

/** The text a person typed, or the caption of the media they sent. */
export function messageText(m: TgMessage): string {
  return (m.text ?? m.caption ?? "").trim();
}

/**
 * `/start` is what Telegram sends when someone opens the bot (or taps a deep link). The
 * payload after it (`/start CODE`) is kept as the text, so a one-time claim code works.
 * A bare `/start` becomes a short marker the agent can greet; `/start@MyBot` is handled too.
 */
export function stripStartCommand(text: string): string {
  const m = /^\/start(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return text;
  return (m[1] ?? "").trim() || "[opened the chat]";
}

export function mediaInfo(m: TgMessage): MediaInfo | undefined {
  const pick = (kind: MediaKind, f: TgFile | undefined, extra: Partial<MediaInfo> = {}): MediaInfo | undefined =>
    f ? clean({ kind, fileId: f.file_id, mimeType: f.mime_type, name: f.file_name, size: f.file_size, ...extra }) : undefined;
  const size = (p: TgFile & { width?: number; height?: number }) => p.file_size ?? (p.width ?? 0) * (p.height ?? 0);
  const photo = m.photo?.length ? [...m.photo].sort((a, b) => size(b) - size(a))[0] : undefined;
  return (
    pick("image", photo, { mimeType: "image/jpeg" }) ??
    pick("audio", m.voice, { voiceNote: true, mimeType: m.voice?.mime_type ?? "audio/ogg" }) ??
    pick("audio", m.audio) ??
    pick("video", m.video) ??
    pick("video", m.video_note, { mimeType: "video/mp4" }) ??
    pick("video", m.animation) ??
    pick("document", m.document) ??
    pick("sticker", m.sticker)
  );
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
  "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/x-m4a": ".m4a",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv", "text/calendar": ".ics", "text/vcard": ".vcf",
};

/** Extension for a saved file: from the MIME type (parameters dropped), else the sender's file name, else .bin. */
export function extensionFor(mimeType: string | undefined, name: string | undefined): string {
  const type = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (type && EXTENSIONS[type]) return EXTENSIONS[type];
  return name?.match(/\.[A-Za-z0-9]{1,8}$/)?.[0]?.toLowerCase() ?? ".bin";
}

/**
 * One Telegram update to an inbound message, before any media is downloaded. Undefined for
 * anything that is not a private message from a person (groups, channels, bots, edits,
 * joins, empty messages). Attachments are added by the channel once the files are saved.
 */
export interface ParseOptions {
  /** Answer in groups too: only messages addressed to the bot (a mention, a reply to it, or a command) are kept. */
  groups?: { botUsername?: string | undefined; botId?: number | undefined };
}

/** True when a group message is for the bot: @mention, a reply to the bot's own message, or a slash command. */
export function isAddressedToBot(m: TgMessage, bot: { botUsername?: string | undefined; botId?: number | undefined }): boolean {
  const text = (m.text ?? m.caption ?? "").trim();
  if (bot.botUsername && new RegExp(`(^|\\s)@${bot.botUsername.replace(/[^\w]/g, "")}\\b`, "i").test(text)) return true;
  if (bot.botId !== undefined && m.reply_to_message?.from?.id === bot.botId) return true;
  return text.startsWith("/");
}

export function parseUpdate(update: TgUpdate, opts: ParseOptions = {}): { message: InboundMessage; media?: MediaInfo } | undefined {
  const m = update.message;
  if (!m || !m.from || m.from.is_bot) return undefined;
  const group = m.chat.type === "group" || m.chat.type === "supergroup";
  if (group) {
    if (!opts.groups || !isAddressedToBot(m, opts.groups)) return undefined;
  } else if (!isPrivateChat(m.chat)) return undefined;
  const media = mediaInfo(m);
  let raw = messageText(m);
  if (group && opts.groups?.botUsername) raw = raw.replace(new RegExp(`@${opts.groups.botUsername.replace(/[^\w]/g, "")}\\b`, "ig"), "").replace(/\s{2,}/g, " ").trim();
  const text = raw ? stripStartCommand(raw) : "";
  if (!text && !media) return undefined;
  const from = addressFor(m.from.id);
  const name = displayName(m.from);
  const message: InboundMessage = {
    id: `telegram:${update.update_id}`,
    channel: "telegram",
    conversationKey: conversationKeyFor(m.chat.id),
    from,
    text: text || (media?.voiceNote ? "[voice note]" : "[attachment]"),
    replyRef: { chatId: String(m.chat.id), messageId: String(m.message_id) },
    receivedAt: new Date((m.date > 0 ? m.date : Date.now() / 1000) * 1000).toISOString(),
    source: "telegram",
    meta: {
      isGroup: group,
      participants: [from],
      conversationScopeKnown: true,
      ...(group && m.chat.title ? { groupTitle: m.chat.title.slice(0, 120) } : {}),
      ...(name ? { pushName: name } : {}),
      ...(m.from.username ? { username: m.from.username } : {}),
    },
  };
  return media ? { message, media } : { message };
}

/**
 * Split a reply into pieces Telegram accepts, preferring paragraph, then line, then word
 * boundaries, and only cutting mid-word when a single word is longer than the limit.
 */
export function splitText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
