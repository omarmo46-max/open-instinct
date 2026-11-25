/**
 * Saving a file someone sent. Shared by the local channel and the remote one so an
 * attachment looks the same to the agent whichever way it arrived: a hashed name inside the
 * inbound folder, owner-only permissions.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InboundMessage } from "@open-instinct/core";
import { extensionFor, type MediaInfo } from "./parse.js";

export function saveInboundFile(mediaDir: string, message: InboundMessage, media: MediaInfo, bytes: Buffer, remotePath?: string): void {
  mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  // The same naming as the Inkbox hydrator and the WhatsApp channel, so attachment readers treat all alike.
  const hash = createHash("sha256").update(`telegram\n${message.replyRef.chatId}\n${message.replyRef.messageId}`).digest("hex");
  const target = path.join(mediaDir, `${hash}${extensionFor(media.mimeType, media.name ?? remotePath)}`);
  writeFileSync(target, bytes, { mode: 0o600 });
  message.attachments = [{ path: target, ...(media.mimeType ? { mimeType: media.mimeType } : {}), ...(media.name ? { name: media.name } : {}) }];
}

/** The line the agent reads when a file could not be fetched. */
export function noteDownloadFailure(message: InboundMessage, media: MediaInfo, reason: string): void {
  const what = media.voiceNote ? "voice note" : media.kind;
  message.text += `${message.text ? "\n" : ""}[A ${what} could not be downloaded: ${reason}]`;
}
