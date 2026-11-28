/**
 * Bring your own model, with automatic fallback.
 *
 * The owner (usually from the website dashboard) gives the agent a provider, a model name and an API key.
 * While that model works, every turn uses it. When it stops (bad key, no quota, provider down) before it
 * produced any output, the same turn is answered by the default model, the owner is told once, and the website
 * is told so it can show the status. After a cooldown the custom model is tried again; when it works, the owner
 * is told it is back. The key never appears in a message, a log line or the status file shown to the owner.
 */
import fs from "node:fs";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { OPENAI_COMPATIBLE_PROVIDER, resolveModel } from "@open-instinct/core";

export const CUSTOM_MODEL_FILE = "custom-model.json";
export const DEFAULT_COOLDOWN_MS = 10 * 60_000;

export interface CustomModelConfig {
  enabled: boolean;
  /** anthropic, openai, google, openrouter or compatible. */
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
}

export interface CustomModelState extends CustomModelConfig {
  status: "active" | "failed";
  lastError?: string;
  failedAt?: string;
}

const PROVIDER_IDS: Record<string, string> = { anthropic: "anthropic", openai: "openai", google: "google", openrouter: "openrouter", compatible: OPENAI_COMPATIBLE_PROVIDER };

export class CustomModelStore {
  constructor(private readonly dir: string) {}
  private get file(): string {
    return path.join(this.dir, CUSTOM_MODEL_FILE);
  }
  get(): CustomModelState | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as CustomModelState;
    } catch {
      return undefined;
    }
  }
  private write(s: CustomModelState | undefined): void {
    if (!s) return void fs.rmSync(this.file, { force: true });
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(s), { mode: 0o600 });
  }

  /** Apply what the dashboard sent. `{ enabled: false }` switches back to the default; `remove` deletes the key. */
  apply(body: unknown): { ok: boolean; error?: string } {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (b.remove === true) return this.write(undefined), { ok: true };
    const cur = this.get();
    if (b.enabled === false) {
      if (cur) this.write({ ...cur, enabled: false });
      return { ok: true };
    }
    const provider = String(b.provider ?? "");
    const model = String(b.model ?? "");
    const apiKey = String(b.apiKey ?? "");
    if (!PROVIDER_IDS[provider]) return { ok: false, error: "unknown provider" };
    if (!/^[\w.:/@+-]{1,120}$/.test(model)) return { ok: false, error: "bad model name" };
    if (apiKey.length < 8 || apiKey.length > 400) return { ok: false, error: "bad key" };
    const baseUrl = typeof b.baseUrl === "string" && b.baseUrl ? b.baseUrl : undefined;
    if (provider === "compatible" && !baseUrl) return { ok: false, error: "an endpoint URL is required" };
    this.write({ enabled: true, provider, model, ...(baseUrl ? { baseUrl } : {}), apiKey, status: "active" });
    return { ok: true };
  }

  setStatus(status: "active" | "failed", now: Date, error?: string): void {
    const cur = this.get();
    if (!cur) return;
    const { lastError: _e, failedAt: _f, ...rest } = cur;
    this.write({ ...rest, status, ...(status === "failed" ? { lastError: error ?? "stopped", failedAt: now.toISOString() } : {}) });
  }

  /** What the owner may see: never the key. */
  publicStatus(): { enabled: boolean; provider: string; model: string; status: string; lastError?: string } | undefined {
    const s = this.get();
    return s ? { enabled: s.enabled, provider: s.provider, model: s.model, status: s.status, ...(s.lastError ? { lastError: s.lastError } : {}) } : undefined;
  }
}

export function buildCustomModel(cfg: CustomModelConfig): Model<any> {
  const provider = PROVIDER_IDS[cfg.provider];
  if (!provider) throw new Error("unknown provider");
  const env = cfg.baseUrl ? { OPENAI_BASE_URL: cfg.baseUrl } : {};
  try {
    return resolveModel(`${provider}/${cfg.model}`, env);
  } catch (error) {
    // A model the built-in catalog does not list yet (a new release, a private deployment): borrow the provider's
    // settings from one of its catalog models and use the name the owner gave. Compatible endpoints have no catalog.
    if (provider === OPENAI_COMPATIBLE_PROVIDER) throw error;
    const template = (getBuiltinModels as (p: string) => Model<any>[])(provider)[0];
    if (!template) throw error;
    return { ...template, id: cfg.model, name: cfg.model, reasoning: false };
  }
}

export interface FailoverHooks {
  /** Tell the owner in their own channel. */
  notifyOwner(text: string): Promise<unknown> | unknown;
  /** Tell the website dashboard. */
  report(status: "failed" | "active", error?: string): Promise<unknown> | unknown;
}

const redact = (text: string, key: string) => (key ? text.split(key).join("[key]") : text).slice(0, 300);

export function createFailoverStreamFn(base: StreamFn, store: CustomModelStore, hooks: FailoverHooks, o: { cooldownMs?: number; now?: () => Date; log?: (m: string) => void } = {}): StreamFn {
  const now = o.now ?? (() => new Date());
  const cooldown = o.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const log = o.log ?? (() => {});
  const safe = (p: Promise<unknown> | unknown) => Promise.resolve(p).catch((e) => log(`custom model hook failed: ${(e as Error).message}`));

  return ((model: Model<any>, context: unknown, options?: Record<string, unknown>) => {
    const cfg = store.get();
    const waiting = cfg?.status === "failed" && cfg.failedAt && now().getTime() - Date.parse(cfg.failedAt) < cooldown;
    if (!cfg || !cfg.enabled || waiting) return (base as any)(model, context, options);

    let custom: Model<any>;
    try {
      custom = buildCustomModel(cfg);
    } catch (e) {
      const why = redact((e as Error).message, cfg.apiKey);
      store.setStatus("failed", now(), why);
      void safe(hooks.notifyOwner(`Your custom model could not be used (${why}). I switched back to the default model.`));
      void safe(hooks.report("failed", why));
      return (base as any)(model, context, options);
    }

    const out = createAssistantMessageEventStream();
    void (async () => {
      let committed = false;
      const held: AssistantMessageEvent[] = [];
      let failure: string | undefined;
      try {
        const s = await (base as any)(custom, context, { ...(options ?? {}), apiKey: cfg.apiKey });
        for await (const ev of s as AsyncIterable<AssistantMessageEvent>) {
          if (!committed) {
            if (ev.type === "error") {
              failure = (ev.error as { errorMessage?: string }).errorMessage || "the provider returned an error";
              break;
            }
            held.push(ev);
            if (ev.type !== "start") {
              committed = true;
              for (const h of held) out.push(h);
              held.length = 0;
            }
          } else out.push(ev);
        }
        if (!committed && failure === undefined) for (const h of held) out.push(h);
      } catch (e) {
        if (!committed) failure = (e as Error).message || "the provider could not be reached";
        else out.push({ type: "error", reason: "error", error: { errorMessage: (e as Error).message } } as never);
      }

      if (committed || failure === undefined) {
        if (cfg.status === "failed") {
          store.setStatus("active", now());
          void safe(hooks.notifyOwner("Your custom model is working again, so I am using it."));
          void safe(hooks.report("active"));
        }
        try {
          out.end();
        } catch {}
        return;
      }

      const why = redact(failure, cfg.apiKey);
      const first = cfg.status !== "failed";
      store.setStatus("failed", now(), why);
      log(`custom model failed, using the default: ${why}`);
      if (first) {
        void safe(hooks.notifyOwner(`Your custom model stopped (${why}). I switched back to the default model and will keep trying yours in the background.`));
        void safe(hooks.report("failed", why));
      }
      try {
        for await (const ev of (await (base as any)(model, context, options)) as AsyncIterable<AssistantMessageEvent>) out.push(ev);
      } catch (e) {
        out.push({ type: "error", reason: "error", error: { errorMessage: (e as Error).message } } as never);
      }
      try {
        out.end();
      } catch {}
    })();
    return out;
  }) as unknown as StreamFn;
}
