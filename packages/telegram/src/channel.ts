/**
 * Telegram as a channel: a bot (made with @BotFather) that people message one to one.
 *
 * Analogy: the bot is the agent's own account. Telegram holds the messages until this
 * process asks for them (long polling), so no public URL, tunnel or TLS is needed, and
 * the bot works behind NAT or inside a microVM. Replies go out through the same Bot API.
 *
 * Inbound: private chats only. Photos, voice notes, audio, video and documents (up to the
 * Bot API's 20 MB download limit) are saved into the inbound folder under a hashed name,
 * like Inkbox and WhatsApp attachments. Outbound: text (split at 4096 characters), links to
 * files, and a typing indicator. No dependencies: it speaks the HTTPS Bot API with fetch.
 *
 * The bot token is a password. It is never logged and never leaves this file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FileOutbox, InboundMessage, Outbox, OutboundFile, OutboundMessage } from "@orion-ai/core";
import { noteDownloadFailure, saveInboundFile } from "./files.js";
import { TELEGRAM_DOWNLOAD_MAX_BYTES, chatIdFromConversationKey, parseUpdate, splitText, type MediaInfo, type TgUpdate } from "./parse.js";

const DEFAULT_BASE_URL = "https://api.telegram.org";
const DEFAULT_POLL_SECONDS = 30;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const REQUEST_SLACK_MS = 15_000;

export type TelegramState = "idle" | "connecting" | "open" | "closed" | "unauthorized";

export interface TelegramChannelOptions {
  /** The bot token from @BotFather. Treat it like a password. */
  token: string;
  /** Where inbound media is saved (workspace/inbound). */
  mediaDir: string;
  /** Where the next update offset is remembered, so a restart does not replay old updates. */
  offsetFile: string;
  /** Called for every message from a person. The caller persists it before acting. */
  onInbound: (msg: InboundMessage) => void | Promise<void>;
  logger?: (m: string) => void;
  maxMediaBytes?: number;
  /** For tests and proxies. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Long-poll timeout in seconds (default 30). */
  pollSeconds?: number;
  /**
   * Default true: files are downloaded into `mediaDir` before the message is handed over.
   * False (a shared front door): the message carries `meta.telegramFile` and the agent that
   * owns the conversation fetches the file itself, so nothing is downloaded for nobody.
   */
  downloadMedia?: boolean;
  /** Also answer in groups when addressed (a mention, a reply or a command). The agent itself decides which groups it will speak in. */
  groups?: boolean;
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.name = "TelegramApiError";
  }
}

interface ApiResponse<T> { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } }

/** The Bot API takes uploads up to 50 MB; photos are shown inline up to 10 MB. */
export const TELEGRAM_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const TELEGRAM_CAPTION_LIMIT = 1024;

export class TelegramChannel implements Outbox, FileOutbox {
  private state: TelegramState = "idle";
  private stopped = true;
  private offset = 0;
  private abort?: AbortController;
  private loop?: Promise<void>;
  private botName?: string;
  private botId?: number;
  private readonly log: (m: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(private readonly opts: TelegramChannelOptions) {
    if (!opts.token.trim()) throw new Error("TELEGRAM_BOT_TOKEN is empty");
    this.log = opts.logger ?? (() => {});
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  status(): TelegramState {
    return this.state;
  }

  /** The bot's @username once the token has been checked. */
  username(): string | undefined {
    return this.botName;
  }

  /** Checks the token, then polls in the background. Never throws: a bad network only delays it. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.state = "connecting";
    this.offset = this.readOffset();
    this.abort = new AbortController();
    this.loop = this.run().catch((err: Error) => this.log(`telegram: stopped: ${this.scrub(err.message)}`));
    // Let the first getMe settle so boot logs say whether the token works.
    await Promise.race([this.waitUntilOpen(), new Promise((r) => setTimeout(r, 10_000))]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
    if (this.state !== "unauthorized") this.state = "closed";
  }

  async send(msg: OutboundMessage): Promise<void> {
    const chatId = chatIdFromConversationKey(msg.conversationKey) ?? toChatId(msg.to);
    if (!chatId) throw new Error("Telegram send needs a telegram: conversation or a numeric Telegram user id");
    const replyTo = msg.replyToMessageId && /^\d+$/.test(msg.replyToMessageId) ? Number(msg.replyToMessageId) : undefined;
    const chunks = splitText(msg.text);
    for (const [i, text] of chunks.entries()) {
      await this.call("sendMessage", {
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
        ...(i === 0 && replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      });
    }
    for (const url of msg.mediaUrls ?? []) {
      // Telegram fetches https links itself. If it cannot, the person still gets the link.
      if (/^https:\/\//i.test(url)) {
        try {
          await this.call("sendDocument", { chat_id: chatId, document: url });
          continue;
        } catch (err) {
          this.log(`telegram: could not send ${shorten(url)} as a file (${this.scrub((err as Error).message)}); sending the link`);
        }
      }
      await this.call("sendMessage", { chat_id: chatId, text: url });
    }
  }

  /** Upload a file into a chat. JPEG and PNG pictures show inline, everything else is a document. */
  async sendFile(file: OutboundFile): Promise<void> {
    const chatId = chatIdFromConversationKey(file.conversationKey) ?? toChatId(file.to);
    if (!chatId) throw new Error("Telegram send needs a telegram: conversation or a numeric Telegram user id");
    if (file.content.length === 0) throw new Error("the file is empty");
    if (file.content.length > TELEGRAM_UPLOAD_MAX_BYTES) throw new Error("the file is over Telegram's 50 MB limit for bots");
    const type = file.contentType.split(";")[0]!.trim().toLowerCase() || "application/octet-stream";
    const photo = (type === "image/jpeg" || type === "image/png") && file.content.length <= TELEGRAM_PHOTO_MAX_BYTES;
    const caption = file.caption?.trim();
    const inlineCaption = caption && caption.length <= TELEGRAM_CAPTION_LIMIT ? caption : undefined;
    const form = new FormData();
    form.set("chat_id", chatId);
    if (inlineCaption) form.set("caption", inlineCaption);
    form.set(photo ? "photo" : "document", new Blob([file.content], { type }), file.filename);
    await this.callForm(photo ? "sendPhoto" : "sendDocument", form);
    // A caption too long for Telegram still reaches the person, as its own message.
    if (caption && !inlineCaption) await this.send({ channel: "telegram", conversationKey: `telegram:${chatId}`, text: caption });
  }

  async typing(conversationKey: string): Promise<void> {
    const chatId = chatIdFromConversationKey(conversationKey);
    if (!chatId || this.state !== "open") return;
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------

  private async run(): Promise<void> {
    let retry = RETRY_MIN_MS;
    // 1. Verify the token. A wrong token (401) never gets better, so stop; a network error is retried.
    while (!this.stopped) {
      try {
        const me = await this.call<{ id?: number; username?: string; first_name?: string }>("getMe", {});
        this.botName = me.username;
        this.botId = me.id;
        break;
      } catch (err) {
        if (err instanceof TelegramApiError && (err.code === 401 || err.code === 404)) {
          this.state = "unauthorized";
          this.stopped = true;
          this.log("telegram: the bot token was rejected. Check TELEGRAM_BOT_TOKEN (create one with @BotFather).");
          return;
        }
        this.log(`telegram: cannot reach Telegram yet (${this.scrub((err as Error).message)}); retrying in ${Math.round(retry / 1000)}s`);
        await this.sleep(retry);
        retry = Math.min(retry * 2, RETRY_MAX_MS);
      }
    }
    if (this.stopped) return;
    // getUpdates and a webhook cannot coexist. Pending updates are kept.
    await this.call("deleteWebhook", { drop_pending_updates: false }).catch((err: Error) => this.log(`telegram: deleteWebhook failed: ${this.scrub(err.message)}`));
    this.state = "open";
    this.log(`telegram: connected as ${this.botName ? `@${this.botName}` : "the bot"}`);

    // 2. Poll.
    retry = RETRY_MIN_MS;
    while (!this.stopped) {
      try {
        const updates = await this.call<TgUpdate[]>(
          "getUpdates",
          { offset: this.offset, timeout: this.opts.pollSeconds ?? DEFAULT_POLL_SECONDS, allowed_updates: ["message"] },
          ((this.opts.pollSeconds ?? DEFAULT_POLL_SECONDS) * 1000) + REQUEST_SLACK_MS,
        );
        for (const update of updates) {
          if (this.stopped) return;
          await this.handle(update);
          this.offset = update.update_id + 1;
          this.saveOffset();
        }
        retry = RETRY_MIN_MS;
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof TelegramApiError && (err.code === 401 || err.code === 403)) {
          this.state = "unauthorized";
          this.stopped = true;
          this.log("telegram: the bot token is no longer accepted. Check TELEGRAM_BOT_TOKEN.");
          return;
        }
        const wait = err instanceof TelegramApiError && err.code === 429 && err.retryAfter ? err.retryAfter * 1000 : retry;
        const hint = err instanceof TelegramApiError && err.code === 409 ? " (another process is polling this bot, or a webhook is set: use one process per bot token)" : "";
        this.log(`telegram: poll failed: ${this.scrub((err as Error).message)}${hint}; retrying in ${Math.round(wait / 1000)}s`);
        await this.sleep(wait);
        retry = Math.min(retry * 2, RETRY_MAX_MS);
      }
    }
  }

  /** Parse one update, fetch its media, hand it over. Only a failed hand-over throws, so the update is retried. */
  private async handle(update: TgUpdate): Promise<void> {
    let parsed: ReturnType<typeof parseUpdate>;
    try {
      parsed = parseUpdate(update, this.opts.groups ? { groups: { botUsername: this.botName, botId: this.botId } } : {});
    } catch (err) {
      this.log(`telegram: ignored update ${update.update_id}: ${(err as Error).message}`);
      return;
    }
    if (!parsed) return;
    const { message, media } = parsed;
    if (media && this.opts.downloadMedia === false) {
      message.meta = {
        ...message.meta,
        telegramFile: { fileId: media.fileId, kind: media.kind, ...(media.mimeType ? { mimeType: media.mimeType } : {}), ...(media.name ? { name: media.name } : {}), ...(media.size !== undefined ? { size: media.size } : {}), ...(media.voiceNote ? { voiceNote: true } : {}) },
      };
    } else if (media) await this.attach(message, media);
    this.log(`telegram: message from ${message.from}${media ? ` (${media.voiceNote ? "voice note" : media.kind})` : ""}`);
    await this.opts.onInbound(message);
  }

  private async attach(message: InboundMessage, media: MediaInfo): Promise<void> {
    const cap = this.opts.maxMediaBytes ?? TELEGRAM_DOWNLOAD_MAX_BYTES;
    try {
      const { bytes, filePath } = await this.downloadFile(media.fileId, media.size, cap);
      saveInboundFile(this.opts.mediaDir, message, media, bytes, filePath);
    } catch (err) {
      noteDownloadFailure(message, media, this.scrub((err as Error).message));
    }
  }

  /** Fetch a file by its Telegram file id. Throws short errors ("too large", "download failed (404)"). */
  async downloadFile(fileId: string, declaredSize?: number, cap = this.opts.maxMediaBytes ?? TELEGRAM_DOWNLOAD_MAX_BYTES): Promise<{ bytes: Buffer; filePath: string }> {
    if (declaredSize !== undefined && declaredSize > cap) throw new Error("too large");
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("no download path");
    if (file.file_size !== undefined && file.file_size > cap) throw new Error("too large");
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/file/bot${this.opts.token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw new Error(this.scrub((err as Error).message));
    }
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > cap) throw new Error("too large");
    return { bytes, filePath: file.file_path };
  }

  private callForm<T = unknown>(method: string, form: FormData): Promise<T> {
    return this.call<T>(method, form, 120_000);
  }

  private async call<T = unknown>(method: string, body: Record<string, unknown> | FormData, timeoutMs = 30_000): Promise<T> {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (this.abort) signals.push(this.abort.signal);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/bot${this.opts.token}/${method}`, {
        method: "POST",
        // A FormData body sets its own multipart boundary header.
        ...(body instanceof FormData ? {} : { headers: { "content-type": "application/json" } }),
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      // fetch errors can carry the request URL, which contains the token.
      throw new Error(this.scrub((err as Error).message));
    }
    let data: ApiResponse<T>;
    try {
      data = (await res.json()) as ApiResponse<T>;
    } catch {
      throw new TelegramApiError(method, res.status, "response was not JSON");
    }
    if (!data.ok) throw new TelegramApiError(method, data.error_code ?? res.status, data.description ?? "unknown error", data.parameters?.retry_after);
    return data.result as T;
  }

  private waitUntilOpen(): Promise<void> {
    return new Promise((resolve) => {
      const tick = setInterval(() => {
        if (this.state === "open" || this.state === "unauthorized" || this.stopped) {
          clearInterval(tick);
          resolve();
        }
      }, 50);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort?.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  private readOffset(): number {
    try {
      if (!existsSync(this.opts.offsetFile)) return 0;
      const n = Number((JSON.parse(readFileSync(this.opts.offsetFile, "utf8")) as { offset?: unknown }).offset);
      return Number.isSafeInteger(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  private saveOffset(): void {
    try {
      mkdirSync(path.dirname(this.opts.offsetFile), { recursive: true });
      const tmp = `${this.opts.offsetFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ offset: this.offset }), { mode: 0o600 });
      renameSync(tmp, this.opts.offsetFile);
    } catch (err) {
      this.log(`telegram: could not save the update offset: ${(err as Error).message}`);
    }
  }

  private scrub(text: string): string {
    return text.split(this.opts.token).join("<token>");
  }
}

/** A private chat's id is the user's id. Accepts a number, `123`, or `telegram:123`; groups are not addressed this way. */
function toChatId(to: string | string[] | undefined): string | undefined {
  const one = Array.isArray(to) ? to[0] : to;
  const t = one?.trim().replace(/^(telegram|tg):/i, "");
  return t && /^\d{1,15}$/.test(t) ? t : undefined;
}

function shorten(url: string): string {
  return url.length > 60 ? `${url.slice(0, 57)}...` : url;
}
