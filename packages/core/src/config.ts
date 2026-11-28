/**
 * config.json: who the owner is, which model to use, feature flags. The file wins
 * over the environment after first boot; env only seeds it. The one exception is
 * ORION_MODEL, which operators use to swap models without editing state.
 */
import { normalizeEmail, normalizeHandle, normalizePhone, normalizeTelegramId } from "./principal.js";
import type { StateDir } from "./state.js";
import type { OrionConfig } from "./types.js";

const FILE = "config.json";

export const DEFAULT_MODEL = "anthropic/claude-fable-5-1";
export const DEFAULT_FALLBACK_MODEL = "anthropic/claude-opus-5-5";
export const DEFAULT_CHEAP_MODEL = "anthropic/claude-sonnet-5-5";
export const DEFAULT_TOOLKITS = ["gmail", "googlecalendar", "googlecontacts"];

function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function defaultConfig(): OrionConfig {
  return {
    version: 1,
    owner: { name: "Owner", phones: [], emails: [], timezone: systemTimezone() },
    agent: { name: "Orion" },
    model: { primary: DEFAULT_MODEL, fallback: DEFAULT_FALLBACK_MODEL, cheap: DEFAULT_CHEAP_MODEL, thinking: "medium" },
    computer: { mode: "auto" },
    apps: { enabled: false, toolkits: [...DEFAULT_TOOLKITS] },
    features: { typingIndicators: true, tapbacks: true, journal: true },
  };
}

/** Comma-separated env values. Phones contain spaces, so whitespace is not a separator. */
function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** TELEGRAM_OWNER_ID: one or more numeric Telegram user ids, comma separated. Anything else is ignored. */
export function telegramIdsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return [...new Set(splitList(env.TELEGRAM_OWNER_ID).map((s) => normalizeTelegramId(s) ?? "").filter(Boolean))];
}

const COMPUTER_MODES = new Set<OrionConfig["computer"]["mode"]>(["auto", "desktopd", "maritime", "none"]);

/** Build a fresh config from the environment. Used only when config.json is missing. */
export function configFromEnv(env: NodeJS.ProcessEnv): OrionConfig {
  const cfg = defaultConfig();
  if (env.ORION_OWNER_NAME?.trim()) cfg.owner.name = env.ORION_OWNER_NAME.trim();
  cfg.owner.phones = splitList(env.ORION_OWNER_PHONE).map(normalizePhone).filter(Boolean);
  cfg.owner.emails = splitList(env.ORION_OWNER_EMAIL).map(normalizeEmail).filter(Boolean);
  const telegramIds = telegramIdsFromEnv(env);
  if (telegramIds.length > 0) cfg.owner.telegramIds = telegramIds;
  if (/^(1|true|yes)$/i.test((env.ORION_CLAIM_OWNER_ON_FIRST_CONTACT ?? "").trim())) cfg.owner.claimOnFirstContact = true;
  // The claim only works with a one-time code; see owner-claim.ts.
  if (env.ORION_OWNER_CLAIM_CODE?.trim()) cfg.owner.claimCode = env.ORION_OWNER_CLAIM_CODE.trim();
  if (env.ORION_OWNER_CLAIM_EXPIRES_AT?.trim()) cfg.owner.claimExpiresAt = env.ORION_OWNER_CLAIM_EXPIRES_AT.trim();
  if (env.ORION_OWNER_LANGUAGE?.trim()) cfg.owner.language = env.ORION_OWNER_LANGUAGE.trim().toLowerCase();
  if (env.ORION_OWNER_LOCALE?.trim()) cfg.owner.locale = env.ORION_OWNER_LOCALE.trim();
  // ORION_TIMEZONE is the name older .env.example files used; keep honouring it.
  const timezone = env.ORION_OWNER_TIMEZONE?.trim() || env.ORION_TIMEZONE?.trim();
  if (timezone) cfg.owner.timezone = timezone;
  if (/^(1|true|yes)$/i.test((env.ORION_ACK_SLOW_REPLIES ?? "").trim())) cfg.features.ackSlowReplies = true;
  if (env.ORION_MODEL?.trim()) cfg.model.primary = env.ORION_MODEL.trim();
  if (env.ORION_AGENT_NAME?.trim()) cfg.agent.name = env.ORION_AGENT_NAME.trim();
  if (env.INKBOX_AGENT_HANDLE?.trim()) cfg.agent.handle = normalizeHandle(env.INKBOX_AGENT_HANDLE);
  const mode = env.ORION_COMPUTER?.trim() as OrionConfig["computer"]["mode"] | undefined;
  if (mode && COMPUTER_MODES.has(mode)) cfg.computer.mode = mode;
  const toolkits = splitList(env.COMPOSIO_TOOLKITS).map((t) => t.toLowerCase());
  if (toolkits.length > 0) {
    cfg.apps.toolkits = toolkits;
    cfg.apps.enabled = true;
  }
  return cfg;
}

/** Fill gaps in an older or hand-edited file so every consumer can rely on the shape. */
function withDefaults(raw: Partial<OrionConfig>): OrionConfig {
  const d = defaultConfig();
  return {
    version: 1,
    owner: {
      ...d.owner,
      ...(raw.owner ?? {}),
      phones: (raw.owner?.phones ?? []).map(normalizePhone).filter(Boolean),
      emails: (raw.owner?.emails ?? []).map(normalizeEmail).filter(Boolean),
      ...((raw.owner?.telegramIds ?? []).length > 0 ? { telegramIds: [...new Set((raw.owner?.telegramIds ?? []).map((t) => normalizeTelegramId(String(t)) ?? "").filter(Boolean))] } : {}),
    },
    agent: { ...d.agent, ...(raw.agent ?? {}) },
    model: { ...d.model, ...(raw.model ?? {}) },
    computer: { ...d.computer, ...(raw.computer ?? {}) },
    apps: { ...d.apps, ...(raw.apps ?? {}), toolkits: raw.apps?.toolkits ?? d.apps.toolkits },
    features: { ...d.features, ...(raw.features ?? {}) },
    ...(raw.triggers && typeof raw.triggers === "object" ? { triggers: { ...raw.triggers } } : {}),
    ...((raw.groups?.allow ?? []).length > 0
      ? {
          groups: {
            allow: (raw.groups?.allow ?? [])
              .filter((g) => g && typeof g.key === "string" && /^telegram:-\d{1,20}$/.test(g.key))
              .map((g) => ({ key: g.key, ...(typeof g.title === "string" && g.title ? { title: g.title.slice(0, 120) } : {}), allowedAt: typeof g.allowedAt === "string" ? g.allowedAt : new Date(0).toISOString() })),
          },
        }
      : {}),
  };
}

export function loadConfig(state: StateDir, env: NodeJS.ProcessEnv): OrionConfig {
  if (!state.exists(FILE)) {
    const seeded = configFromEnv(env);
    saveConfig(state, seeded);
    return seeded;
  }
  const cfg = withDefaults(state.readJson<Partial<OrionConfig>>(FILE, {}));
  if (env.ORION_MODEL?.trim()) cfg.model.primary = env.ORION_MODEL.trim();
  return cfg;
}

export function saveConfig(state: StateDir, config: OrionConfig): void {
  state.writeJson(FILE, config);
}
