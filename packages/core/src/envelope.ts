/**
 * The gateway relays Inkbox events through Maritime's plain `/chat` endpoint. To
 * tell an event apart from a human typing in the dashboard, the JSON is prefixed
 * with a marker no person would type.
 */
import { EVENT_ENVELOPE_PREFIX, type InboundMessage } from "./types.js";

export function encodeEvent(event: unknown): string {
  return EVENT_ENVELOPE_PREFIX + JSON.stringify(event);
}

/**
 * A task the operator's front door asks the agent to run as its owner, without
 * anyone having texted: research before the first contact, a one-off reminder.
 * `quiet` keeps the result out of the owner's messages (memory and schedules only).
 */
export const SYSTEM_TASK_EVENT = "system.task";

export interface SystemTaskEvent {
  type: typeof SYSTEM_TASK_EVENT;
  /** Stable id; the conversation key is `system:<id>` so a repeat continues the same thread. */
  id: string;
  name?: string;
  prompt: string;
  quiet?: boolean;
}

export function systemTaskOf(event: unknown): SystemTaskEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as Record<string, unknown>;
  if (e.type !== SYSTEM_TASK_EVENT) return undefined;
  if (typeof e.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(e.id)) return undefined;
  if (typeof e.prompt !== "string" || !e.prompt.trim()) return undefined;
  const task: SystemTaskEvent = { type: SYSTEM_TASK_EVENT, id: e.id, prompt: e.prompt };
  if (typeof e.name === "string" && e.name) task.name = e.name;
  if (e.quiet === true) task.quiet = true;
  return task;
}

/** Returns the event, or undefined when the message is ordinary text or malformed. */
export function decodeEvent(message: string): unknown | undefined {
  if (typeof message !== "string") return undefined;
  const trimmed = message.trimStart();
  if (!trimmed.startsWith(EVENT_ENVELOPE_PREFIX)) return undefined;
  const body = trimmed.slice(EVENT_ENVELOPE_PREFIX.length).trim();
  if (!body) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

export function isEnvelope(message: string): boolean {
  return typeof message === "string" && message.trimStart().startsWith(EVENT_ENVELOPE_PREFIX);
}

/**
 * Telegram through a shared front door. One bot serves many agents, so the gateway holds the
 * bot token, finds the agent each Telegram user belongs to, and relays what they wrote as one
 * of these events. The agent's replies go back through the gateway (it never sees the token).
 */
export const TELEGRAM_MESSAGE_EVENT = "telegram.message";
export const TELEGRAM_LINK_EVENT = "telegram.link";

/** Where a file a person sent can be fetched from the gateway: nothing is downloaded until the agent asks. */
export interface TelegramFileRef {
  fileId: string;
  kind: string;
  mimeType?: string;
  name?: string;
  size?: number;
  voiceNote?: boolean;
}

const TELEGRAM_ID = /^\d{1,15}$/;

function str(v: unknown, max = 4000): string | undefined {
  return typeof v === "string" && v.length <= max ? v : undefined;
}

/**
 * The message inside a `telegram.message` event, rebuilt field by field so nothing the sender
 * controls (extra meta, attachments, a different channel) rides along. Undefined when malformed.
 */
export function telegramMessageOf(event: unknown): InboundMessage | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as Record<string, unknown>;
  if (e.type !== TELEGRAM_MESSAGE_EVENT || !e.message || typeof e.message !== "object") return undefined;
  const m = e.message as Record<string, unknown>;
  const id = str(m.id, 200);
  const text = str(m.text, 20_000);
  const from = str(m.from, 40);
  const key = str(m.conversationKey, 40);
  const userId = from?.startsWith("telegram:") ? from.slice(9) : undefined;
  if (!id || text === undefined || !from || !key || !userId || !TELEGRAM_ID.test(userId)) return undefined;
  // A private chat has the user's id as its chat id; groups would be negative and are not relayed.
  if (key !== `telegram:${userId}`) return undefined;
  const ref = m.replyRef && typeof m.replyRef === "object" ? (m.replyRef as Record<string, unknown>) : {};
  const replyRef: Record<string, string> = {};
  for (const k of ["chatId", "messageId"]) {
    const v = str(ref[k], 40);
    if (v && /^-?\d+$/.test(v)) replyRef[k] = v;
  }
  const meta = m.meta && typeof m.meta === "object" ? (m.meta as Record<string, unknown>) : {};
  const file = meta.telegramFile && typeof meta.telegramFile === "object" ? (meta.telegramFile as Record<string, unknown>) : undefined;
  const fileId = str(file?.fileId, 300);
  const telegramFile: TelegramFileRef | undefined = file && fileId
    ? {
        fileId,
        kind: str(file.kind, 20) ?? "document",
        ...(str(file.mimeType, 100) ? { mimeType: str(file.mimeType, 100)! } : {}),
        ...(str(file.name, 200) ? { name: str(file.name, 200)! } : {}),
        ...(typeof file.size === "number" && Number.isFinite(file.size) ? { size: file.size } : {}),
        ...(file.voiceNote === true ? { voiceNote: true } : {}),
      }
    : undefined;
  const receivedAt = str(m.receivedAt, 40);
  return {
    id,
    channel: "telegram",
    conversationKey: key,
    from,
    text,
    replyRef,
    receivedAt: receivedAt && !Number.isNaN(Date.parse(receivedAt)) ? receivedAt : new Date().toISOString(),
    source: "telegram",
    meta: {
      isGroup: false,
      participants: [from],
      conversationScopeKnown: true,
      ...(str(meta.pushName, 120) ? { pushName: str(meta.pushName, 120)! } : {}),
      ...(str(meta.username, 64) ? { username: str(meta.username, 64)! } : {}),
      ...(telegramFile ? { telegramFile } : {}),
    },
  };
}

/** The Telegram id the gateway just linked to this agent's owner, from a `telegram.link` event. */
export function telegramLinkOf(event: unknown): { telegramId: string } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as Record<string, unknown>;
  if (e.type !== TELEGRAM_LINK_EVENT || typeof e.telegramId !== "string" || !TELEGRAM_ID.test(e.telegramId)) return undefined;
  return { telegramId: String(Number(e.telegramId)) };
}
