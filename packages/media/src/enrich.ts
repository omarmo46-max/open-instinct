/**
 * Turns what a message carries into text the agent can use, before the runtime sees it:
 *
 *   voice note   -> its transcript, as the message text (the owner's own words)
 *   document     -> its text, inside an untrusted boundary (a PDF is somebody else's writing,
 *                   even when the owner forwards it, so it is data and never instructions)
 *   picture      -> left alone; the runtime hands it to the model when the model can see
 *
 * Nothing here throws. A file that cannot be read becomes one honest line in the message.
 */
import { isInside, wrapUntrusted, type InboundMessage } from "@orion-ai/core";
import { DEFAULT_MAX_CHARS, documentKind, extractDocumentText } from "./documents.js";
import type { Transcriber } from "./transcribe.js";

export interface EnrichOptions {
  /** Where channels save inbound files. Anything else is ignored. */
  inboundDir: string;
  /** Without one, voice notes stay attachments and the agent is told no transcript is available. */
  transcriber?: Transcriber;
  maxDocumentChars?: number;
  /** At most this many voice notes and documents per message. */
  maxFiles?: number;
  logger?: (m: string) => void;
}

const VOICE_PLACEHOLDERS = new Set(["[voice note]", "[attachment]", ""]);

function isAudio(mimeType: string | undefined, name: string | undefined): boolean {
  const type = (mimeType ?? "").toLowerCase();
  return type.startsWith("audio/") || /\.(ogg|oga|opus|mp3|m4a|aac|wav|amr|caf)$/i.test(name ?? "");
}

function clean(s: string | undefined, max = 120): string {
  return (s ?? "").replace(/[\r\n"<>]+/g, " ").trim().slice(0, max);
}

export async function enrichInbound(msg: InboundMessage, opts: EnrichOptions): Promise<InboundMessage> {
  const attachments = msg.attachments ?? [];
  if (attachments.length === 0) return msg;
  const log = opts.logger ?? (() => {});
  const maxFiles = opts.maxFiles ?? 5;
  const spoken: string[] = [];
  const notes: string[] = [];
  const documents: string[] = [];
  let used = 0;

  for (const a of attachments) {
    if (!a.path || !isInside(opts.inboundDir, a.path)) continue;
    const audio = isAudio(a.mimeType, a.name);
    const kind = audio ? undefined : documentKind(a.mimeType, a.name);
    if (!audio && !kind) continue;
    if (++used > maxFiles) {
      notes.push("[more files were attached than I read; ask for the others one at a time]");
      break;
    }
    try {
      if (audio) {
        if (!opts.transcriber) {
          notes.push("[a voice note arrived, but speech-to-text is not set up here, so I cannot hear it. Say so and ask for it in text.]");
          continue;
        }
        spoken.push(await opts.transcriber.transcribe(a.path, a.mimeType));
      } else {
        const label = clean(a.name) || "document";
        const out = await extractDocumentText(a.path, a.mimeType, a.name, opts.maxDocumentChars ?? DEFAULT_MAX_CHARS);
        if (!out || !out.text) {
          notes.push(`[the document "${label}" has no readable text (a scan or a picture of text?)]`);
          continue;
        }
        const header = `${label}${out.pages ? `, ${out.pages} page${out.pages === 1 ? "" : "s"}` : ""}${out.truncated ? ", cut to the first part" : ""}`;
        documents.push(wrapUntrusted(out.text, `document: ${header}`));
      }
    } catch (err) {
      const what = audio ? "voice note" : `document "${clean(a.name) || "file"}"`;
      log(`media: could not read a ${audio ? "voice note" : "document"}: ${(err as Error).message}`);
      notes.push(`[the ${what} could not be read: ${(err as Error).message}]`);
    }
  }
  if (spoken.length === 0 && notes.length === 0 && documents.length === 0) return msg;

  const typed = VOICE_PLACEHOLDERS.has(msg.text.trim()) ? "" : msg.text.trim();
  const voice = spoken.map((s) => `[voice note] ${s}`).join("\n");
  const text = [typed, voice, ...notes, ...documents].filter(Boolean).join("\n");
  return { ...msg, text: text || msg.text, meta: { ...(msg.meta ?? {}), ...(spoken.length ? { transcribed: spoken.length } : {}) } };
}
