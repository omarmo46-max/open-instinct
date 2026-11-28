/**
 * Telegram for an agent behind a shared front door. The gateway owns the bot and its token;
 * this channel is what the agent uses instead of a bot of its own: it sends through the
 * gateway's agent API, authenticated with the agent's own token, and the gateway only lets it
 * write to the one chat its owner linked. Files people send are fetched through the gateway
 * too, on demand.
 */
import type { FileOutbox, InboundMessage, Outbox, OutboundFile, OutboundMessage } from "@orion-ai/core";
import { noteDownloadFailure, saveInboundFile } from "./files.js";
import { TELEGRAM_DOWNLOAD_MAX_BYTES, chatIdFromConversationKey, type MediaInfo, type MediaKind } from "./parse.js";

export interface GatewayTelegramOptions {
  /** The gateway's public base URL (TELEGRAM_GATEWAY_URL). */
  gatewayUrl: string;
  /** This agent's token (TELEGRAM_GATEWAY_TOKEN). It is a password. */
  token: string;
  /** Where inbound media is saved (workspace/inbound). */
  mediaDir: string;
  maxMediaBytes?: number;
  fetchImpl?: typeof fetch;
  logger?: (m: string) => void;
}

const KINDS: ReadonlySet<string> = new Set(["image", "audio", "video", "document", "sticker"]);

export class GatewayTelegramChannel implements Outbox, FileOutbox {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GatewayTelegramOptions) {
    if (!opts.token.trim()) throw new Error("TELEGRAM_GATEWAY_TOKEN is empty");
    if (!/^https?:\/\//i.test(opts.gatewayUrl)) throw new Error("TELEGRAM_GATEWAY_URL must be an http(s) URL");
    this.base = opts.gatewayUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(msg: OutboundMessage): Promise<void> {
    const chatId = this.chatOf(msg.conversationKey, msg.to);
    await this.request("POST", "send", {
      json: { chatId, text: msg.text, ...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}), ...(msg.mediaUrls?.length ? { mediaUrls: msg.mediaUrls } : {}) },
    });
  }

  async sendFile(file: OutboundFile): Promise<void> {
    const chatId = this.chatOf(file.conversationKey, file.to);
    const form = new FormData();
    form.set("chatId", chatId);
    if (file.caption) form.set("caption", file.caption);
    form.set("file", new Blob([file.content], { type: file.contentType || "application/octet-stream" }), file.filename);
    await this.request("POST", "file", { form, timeoutMs: 180_000 });
  }

  async typing(conversationKey: string): Promise<void> {
    const chatId = chatIdFromConversationKey(conversationKey);
    if (!chatId) return;
    await this.request("POST", "typing", { json: { chatId } }).catch(() => undefined);
  }

  /** Fetch the file a `telegram.message` event points at, and attach it. Never throws; a failure becomes a line in the text. */
  async hydrate(message: InboundMessage): Promise<InboundMessage> {
    const ref = message.meta?.telegramFile as { fileId?: string; kind?: string; mimeType?: string; name?: string; size?: number; voiceNote?: boolean } | undefined;
    if (message.channel !== "telegram" || !ref?.fileId) return message;
    const media: MediaInfo = {
      kind: (KINDS.has(ref.kind ?? "") ? ref.kind : "document") as MediaKind,
      fileId: ref.fileId,
      ...(ref.mimeType ? { mimeType: ref.mimeType } : {}),
      ...(ref.name ? { name: ref.name } : {}),
      ...(ref.size !== undefined ? { size: ref.size } : {}),
      ...(ref.voiceNote ? { voiceNote: true } : {}),
    };
    const out: InboundMessage = { ...message, meta: { ...message.meta } };
    delete out.meta!.telegramFile;
    const cap = this.opts.maxMediaBytes ?? TELEGRAM_DOWNLOAD_MAX_BYTES;
    try {
      if (media.size !== undefined && media.size > cap) throw new Error("too large");
      const res = await this.request("GET", `file?id=${encodeURIComponent(ref.fileId)}`, { raw: true, timeoutMs: 120_000 });
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > cap) throw new Error("too large");
      saveInboundFile(this.opts.mediaDir, out, media, bytes, undefined);
    } catch (err) {
      noteDownloadFailure(out, media, (err as Error).message);
    }
    return out;
  }

  private chatOf(conversationKey: string | undefined, to: string | string[] | undefined): string {
    const one = Array.isArray(to) ? to[0] : to;
    const id = chatIdFromConversationKey(conversationKey) ?? one?.trim().replace(/^(telegram|tg):/i, "");
    if (!id || !/^\d{1,15}$/.test(id)) throw new Error("Telegram send needs a telegram: conversation or a numeric Telegram user id");
    return id;
  }

  private async request(method: "GET" | "POST", route: string, o: { json?: unknown; form?: FormData; raw?: boolean; timeoutMs?: number }): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/api/agent/telegram/${route}`, {
        method,
        headers: { authorization: `Bearer ${this.opts.token}`, ...(o.json !== undefined ? { "content-type": "application/json" } : {}) },
        ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : {}),
        ...(o.form ? { body: o.form } : {}),
        signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new Error(`the Telegram gateway is unreachable (${(err as Error).message.split(this.opts.token).join("<token>")})`);
    }
    if (!res.ok) {
      const detail = await res.json().then((b) => (b as { error?: string }).error).catch(() => undefined);
      throw new Error(`Telegram gateway ${route} failed (${res.status}${detail ? `: ${detail}` : ""})`);
    }
    return res;
  }
}
