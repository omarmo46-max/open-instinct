/**
 * One Telegram bot for many agents. The gateway owns the bot and its token:
 *
 *   person -> bot -> hub -> (their user record) -> relay -> their agent
 *   agent  -> hub's agent API (its own token) -> bot -> person
 *
 * Who is who: a Telegram user is tied to a person by a one-time code. The person opens
 * their connect page, taps "Connect Telegram", and Telegram sends the bot `/start <code>`.
 * The code lives 30 minutes and works once. From then on that Telegram id is the owner of
 * that agent (the agent is told with a `telegram.link` event).
 *
 * What an agent can do: write to the one chat its owner linked, show typing, send files, and
 * fetch files that were sent to it. It never sees the bot token, and it cannot message anyone else.
 * People who are not linked get a short bilingual note and nothing else; they are never relayed.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { TELEGRAM_LINK_EVENT, TELEGRAM_MESSAGE_EVENT, type InboundMessage } from "@open-instinct/core";
import { DurableInbox, RetryAfterError } from "@open-instinct/inkbox";
import { TelegramChannel } from "@open-instinct/telegram";
import { SlidingWindowLimiter } from "./limits.js";
import { type Logger, silentLogger } from "./logger.js";
import type { RelayResult } from "./relay.js";
import type { UserRecord, UserStore } from "./store.js";

export interface TelegramHubOptions {
  store: UserStore;
  /** The bot token from @BotFather. */
  token: string;
  /** Where the hub keeps its update offset and its queue. */
  dataDir: string;
  /** Hand one event to the user's agent (the same /chat path Inkbox events take). */
  relay(user: UserRecord, event: Record<string, unknown>, conversationId: string): Promise<RelayResult>;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  pollSeconds?: number;
  now?: () => number;
  /** How long a link code works. Default 30 minutes. */
  linkTtlMs?: number;
  /** Requests per minute one agent may make to the hub. Default 120. */
  agentRatePerMinute?: number;
}

interface Routed {
  userId: string;
  conversationId: string;
  event: Record<string, unknown>;
}

/** What a bot that is not linked to anyone says. Arabic first reader and English reader both get their line. */
export const HUB_TEXT = {
  welcome:
    "Hi! This bot connects you to your personal agent. To link yours, open your connect page and tap “Connect Telegram”.\n\nأهلاً! البوت ده بيوصّلك بوكيلك الشخصي. عشان تربطه بحسابك افتح صفحة الربط بتاعتك واضغط «ربط تليجرام».",
  linked: "Connected. Your agent is now on Telegram: say hello.\n\nتم الربط. وكيلك دلوقتي على تليجرام، ابعتله أي رسالة.",
  badCode: "That link code is not valid or has expired. Open your connect page for a fresh one.\n\nالكود ده مش صالح أو انتهت صلاحيته. افتح صفحة الربط وخد كود جديد.",
  notReady: "Your agent is not ready yet. Try again in a minute.\n\nوكيلك لسه مش جاهز. جرّب تاني بعد دقيقة.",
} as const;

const CODE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 55 * 1024 * 1024;
const FILE_REGISTRY_MAX = 5000;

class HubHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class TelegramHub {
  readonly channel: TelegramChannel;
  private readonly inbox: DurableInbox<Routed>;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly files = new Map<string, string>();
  private readonly noticeLimiter: SlidingWindowLimiter;
  private readonly agentLimiter: SlidingWindowLimiter;

  constructor(private readonly opts: TelegramHubOptions) {
    this.log = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.noticeLimiter = new SlidingWindowLimiter(1, 60_000, this.now);
    this.agentLimiter = new SlidingWindowLimiter(opts.agentRatePerMinute ?? 120, 60_000, this.now);
    this.channel = new TelegramChannel({
      token: opts.token,
      mediaDir: join(opts.dataDir, "telegram-unused"),
      offsetFile: join(opts.dataDir, "telegram-offset.json"),
      downloadMedia: false,
      onInbound: (m) => this.onInbound(m),
      logger: (m) => this.log.info("telegram.hub", { message: m }),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.pollSeconds !== undefined ? { pollSeconds: opts.pollSeconds } : {}),
    });
    this.inbox = new DurableInbox<Routed>({
      file: join(opts.dataDir, "telegram-inbox.json"),
      handle: async (r) => {
        const user = this.opts.store.get(r.userId);
        if (!user) return;
        const result = await this.opts.relay(user, r.event, r.conversationId);
        if (result.status === "rejected") throw new RetryAfterError(result.reason ?? "rejected", result.retryAfterMs ?? 15_000);
      },
      onError: (id, status) => this.log.warn("telegram.hub.delivery", { id, status }),
    });
  }

  async start(): Promise<void> {
    this.inbox.start();
    await this.channel.start();
  }

  async stop(): Promise<void> {
    await this.channel.stop();
    await this.inbox.close();
  }

  username(): string | undefined {
    return this.channel.username();
  }

  /**
   * The link that opens the bot with this person's code, creating a code if they have none
   * that is still valid. Undefined until the bot's username is known.
   */
  linkUrlFor(user: UserRecord): string | undefined {
    const bot = this.username();
    if (!bot) return undefined;
    const current = this.opts.store.get(user.id);
    if (!current) return undefined;
    let link = current.telegramLink;
    if (!link || Date.parse(link.expiresAt) - this.now() < 60_000) {
      link = { code: randomBytes(12).toString("base64url"), expiresAt: new Date(this.now() + (this.opts.linkTtlMs ?? 30 * 60_000)).toISOString() };
      this.opts.store.save({ ...current, telegramLink: link });
    }
    return `https://t.me/${bot}?start=${link.code}`;
  }

  // ---- inbound: Telegram to agents -------------------------------------------------------

  private async onInbound(m: InboundMessage): Promise<void> {
    const telegramId = m.from.replace(/^telegram:/, "");
    const user = this.opts.store.byTelegramId(telegramId);
    if (user) {
      const file = m.meta?.telegramFile as { fileId?: string } | undefined;
      if (file?.fileId) this.rememberFile(file.fileId, user.id);
      this.inbox.enqueue(m.id, { userId: user.id, conversationId: m.conversationKey, event: { type: TELEGRAM_MESSAGE_EVENT, message: m } });
      return;
    }
    await this.unlinked(m, telegramId);
  }

  private async unlinked(m: InboundMessage, telegramId: string): Promise<void> {
    const text = m.text.trim();
    const code = CODE.test(text) ? text : undefined;
    const target = code ? this.opts.store.byTelegramLinkCode(code, this.now()) : undefined;
    if (target) {
      // The code is spent the moment it links: it is dropped from the record in the same save.
      const linked: UserRecord = { ...target, telegramId };
      delete linked.telegramLink;
      this.opts.store.save(linked);
      this.log.info("telegram.hub.linked", { userId: target.id });
      this.inbox.enqueue(`link:${target.id}:${telegramId}:${this.now()}`, { userId: target.id, conversationId: m.conversationKey, event: { type: TELEGRAM_LINK_EVENT, telegramId } });
      await this.reply(telegramId, HUB_TEXT.linked);
      return;
    }
    // A strict limit: an unlinked chat must not be able to make the bot talk in a loop.
    if (!this.noticeLimiter.allow(telegramId)) return;
    await this.reply(telegramId, code ? HUB_TEXT.badCode : HUB_TEXT.welcome);
  }

  private async reply(telegramId: string, text: string): Promise<void> {
    await this.channel.send({ channel: "telegram", conversationKey: `telegram:${telegramId}`, text }).catch((err: Error) => this.log.warn("telegram.hub.reply_failed", { error: err.message }));
  }

  private rememberFile(fileId: string, userId: string): void {
    this.files.delete(fileId);
    this.files.set(fileId, userId);
    while (this.files.size > FILE_REGISTRY_MAX) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined) break;
      this.files.delete(oldest);
    }
  }

  // ---- outbound: agents to Telegram ------------------------------------------------------

  /** True when the request was for the hub (and has been answered). `parts` is the path split on "/". */
  async handleHttp(req: IncomingMessage, res: ServerResponse, parts: string[], url: URL): Promise<boolean> {
    if (parts[0] !== "api" || parts[1] !== "agent" || parts[2] !== "telegram" || parts.length !== 4) return false;
    try {
      const auth = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? "").trim())?.[1]?.trim();
      const user = auth ? this.opts.store.byAgentToken(auth) : undefined;
      if (!user) throw new HubHttpError(401, "unauthorized");
      if (!this.agentLimiter.allow(user.id)) throw new HubHttpError(429, "too many requests");
      const route = parts[3];
      const method = req.method ?? "GET";
      if (route === "file" && method === "GET") {
        await this.serveFile(res, user, url.searchParams.get("id") ?? "");
        return true;
      }
      if (method !== "POST") throw new HubHttpError(405, "method not allowed");
      if (route === "send") await this.agentSend(req, res, user);
      else if (route === "typing") await this.agentTyping(req, res, user);
      else if (route === "file") await this.agentFile(req, res, user);
      else throw new HubHttpError(404, "not found");
      return true;
    } catch (err) {
      const status = err instanceof HubHttpError ? err.status : 502;
      const message = err instanceof HubHttpError ? err.message : "telegram request failed";
      if (!(err instanceof HubHttpError)) this.log.warn("telegram.hub.agent_request_failed", { error: (err as Error).message });
      sendJson(res, status, { error: message });
      return true;
    }
  }

  /** The chat an agent may write to: its owner's, and only that. */
  private chatFor(user: UserRecord, requested: unknown): string {
    if (!user.telegramId) throw new HubHttpError(409, "Telegram is not linked to this agent");
    if (requested !== undefined && String(requested) !== user.telegramId) throw new HubHttpError(403, "that chat is not linked to this agent");
    return user.telegramId;
  }

  private async agentSend(req: IncomingMessage, res: ServerResponse, user: UserRecord): Promise<void> {
    const body = await readJson(req);
    const chat = this.chatFor(user, body.chatId);
    const text = typeof body.text === "string" ? body.text : "";
    const mediaUrls = Array.isArray(body.mediaUrls) ? body.mediaUrls.filter((u): u is string => typeof u === "string" && u.length < 2048).slice(0, 5) : [];
    if (!text.trim() && mediaUrls.length === 0) throw new HubHttpError(400, "nothing to send");
    if (text.length > 20_000) throw new HubHttpError(413, "text too long");
    const replyTo = typeof body.replyToMessageId === "string" && /^\d{1,15}$/.test(body.replyToMessageId) ? body.replyToMessageId : undefined;
    await this.channel.send({ channel: "telegram", conversationKey: `telegram:${chat}`, text, ...(mediaUrls.length ? { mediaUrls } : {}), ...(replyTo ? { replyToMessageId: replyTo } : {}) });
    sendJson(res, 200, { ok: true });
  }

  private async agentTyping(req: IncomingMessage, res: ServerResponse, user: UserRecord): Promise<void> {
    const body = await readJson(req);
    const chat = this.chatFor(user, body.chatId);
    await this.channel.typing(`telegram:${chat}`);
    sendJson(res, 200, { ok: true });
  }

  private async agentFile(req: IncomingMessage, res: ServerResponse, user: UserRecord): Promise<void> {
    const type = String(req.headers["content-type"] ?? "");
    if (!/^multipart\/form-data/i.test(type)) throw new HubHttpError(415, "send multipart/form-data");
    const buf = await readBody(req, MAX_UPLOAD_BYTES);
    const form = await new Request("http://hub.local/", { method: "POST", headers: { "content-type": type }, body: buf }).formData().catch(() => undefined);
    if (!form) throw new HubHttpError(400, "malformed upload");
    const chat = this.chatFor(user, form.get("chatId") ?? undefined);
    const file = form.get("file");
    if (!file || typeof file === "string") throw new HubHttpError(400, "no file");
    const caption = form.get("caption");
    await this.channel.sendFile({
      conversationKey: `telegram:${chat}`,
      filename: file.name || "file",
      contentType: file.type || "application/octet-stream",
      content: Buffer.from(await file.arrayBuffer()),
      ...(typeof caption === "string" && caption ? { caption } : {}),
    });
    sendJson(res, 200, { ok: true });
  }

  private async serveFile(res: ServerResponse, user: UserRecord, fileId: string): Promise<void> {
    // Only files that came from this user's own chat can be fetched, never another person's.
    if (!fileId || this.files.get(fileId) !== user.id) throw new HubHttpError(404, "unknown file");
    let out: Awaited<ReturnType<TelegramChannel["downloadFile"]>>;
    try {
      out = await this.channel.downloadFile(fileId);
    } catch (err) {
      throw new HubHttpError((err as Error).message === "too large" ? 413 : 502, (err as Error).message);
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": out.bytes.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(out.bytes);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HubHttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req, MAX_JSON_BYTES);
  try {
    const parsed: unknown = JSON.parse(buf.toString("utf8") || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // falls through to the error below
  }
  throw new HubHttpError(400, "invalid json");
}
