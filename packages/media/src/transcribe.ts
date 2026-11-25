/**
 * Voice notes to text. Talks to any OpenAI-compatible `/audio/transcriptions` endpoint
 * (OpenAI, Groq, a local whisper server), so the provider is a base URL and a key, not code.
 *
 * Accuracy on Arabic dialects depends on the model you point it at; the language is
 * auto-detected unless STT_LANGUAGE (an ISO code such as "ar") pins it.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** OpenAI-style endpoints refuse bigger files; a bigger voice note is reported, not sent. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "whisper-1";
const REQUEST_TIMEOUT_MS = 120_000;

export interface TranscriberOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** ISO 639-1 code to force, e.g. "ar". Unset: the model detects it. */
  language?: string;
  fetchImpl?: typeof fetch;
}

export class Transcriber {
  private readonly base: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: TranscriberOptions) {
    if (!opts.apiKey.trim()) throw new Error("A speech-to-text API key is required");
    this.base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The words spoken in the file, trimmed. Throws a short error (never the key) when it cannot. */
  async transcribe(file: string, mimeType?: string): Promise<string> {
    const size = statSync(file).size;
    if (size === 0) throw new Error("the recording is empty");
    if (size > MAX_AUDIO_BYTES) throw new Error("the recording is too large");
    const form = new FormData();
    form.set("model", this.model);
    form.set("response_format", "json");
    if (this.opts.language) form.set("language", this.opts.language);
    form.set("file", new Blob([readFileSync(file)], { type: mimeType?.split(";")[0] || "application/octet-stream" }), path.basename(file));
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`speech-to-text is unreachable (${scrub((err as Error).message, this.opts.apiKey)})`);
    }
    if (!res.ok) throw new Error(`speech-to-text failed (${res.status})`);
    const body = (await res.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new Error("no speech was found");
    return text;
  }
}

/** STT_API_KEY, else OPENAI_API_KEY. STT_BASE_URL, STT_MODEL and STT_LANGUAGE are optional. Undefined without a key. */
export function transcriberFromEnv(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Transcriber | undefined {
  const apiKey = (env.STT_API_KEY || env.OPENAI_API_KEY || "").trim();
  if (!apiKey || env.STT_ENABLED?.trim() === "0") return undefined;
  const baseUrl = env.STT_BASE_URL?.trim() || (env.STT_API_KEY ? undefined : env.OPENAI_BASE_URL?.trim());
  return new Transcriber({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(env.STT_MODEL?.trim() ? { model: env.STT_MODEL.trim() } : {}),
    ...(env.STT_LANGUAGE?.trim() ? { language: env.STT_LANGUAGE.trim().toLowerCase() } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

function scrub(text: string, secret: string): string {
  return text.split(secret).join("<key>");
}
