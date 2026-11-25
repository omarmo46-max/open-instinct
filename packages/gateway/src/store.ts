import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One signed-up person. Secrets (identity key, signing key) never leave the gateway process. */
export interface UserRecord {
  id: string;
  name: string;
  phone: string;
  email?: string;
  handle: string;
  identityId: string;
  identityApiKey: string;
  signingKey: string;
  /** Signing key returned by the webhook subscription, when Inkbox hands one back. Tried after `signingKey`. */
  webhookSigningKey?: string;
  webhookSubscriptionId?: string;
  maritimeAgentId?: string;
  maritimeProjectId?: string;
  /** Telegram user id linked to this person (a private chat id is the same number). */
  telegramId?: string;
  /** The agent's own credential for the gateway's Telegram API. Secret; never leaves the gateway except into that agent's environment. */
  agentToken?: string;
  /** A one-time code that links a Telegram account when sent to the bot as `/start <code>`. */
  telegramLink?: { code: string; expiresAt: string };
  createdAt: string;
  updatedAt?: string;
  status: "provisioning" | "ready" | "error";
  error?: string;
}

interface StoreFile {
  version: 1;
  users: UserRecord[];
}

/**
 * JSON-file user store. The file holds API keys, so it is written with 0600
 * permissions through a temp file and rename, which keeps a crash from leaving
 * a half-written file behind.
 */
export class UserStore {
  readonly dir: string;
  readonly file: string;
  private cache: Map<string, UserRecord> | undefined;

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, "users.json");
  }

  all(): UserRecord[] {
    return [...this.load().values()].map(clone);
  }

  get(id: string): UserRecord | undefined {
    const u = this.load().get(id);
    return u ? clone(u) : undefined;
  }

  byHandle(handle: string): UserRecord | undefined {
    const h = handle.toLowerCase();
    for (const u of this.load().values()) if (u.handle.toLowerCase() === h) return clone(u);
    return undefined;
  }

  byIdentityId(identityId: string): UserRecord | undefined {
    for (const u of this.load().values()) if (u.identityId === identityId) return clone(u);
    return undefined;
  }

  byTelegramId(telegramId: string): UserRecord | undefined {
    if (!telegramId) return undefined;
    for (const u of this.load().values()) if (u.telegramId === telegramId) return clone(u);
    return undefined;
  }

  /** The user whose unexpired link code this is. Codes are compared in constant time. */
  byTelegramLinkCode(code: string, now = Date.now()): UserRecord | undefined {
    if (!code) return undefined;
    for (const u of this.load().values()) {
      const l = u.telegramLink;
      if (l && Date.parse(l.expiresAt) > now && sameSecret(l.code, code)) return clone(u);
    }
    return undefined;
  }

  /** The user an agent token belongs to, compared in constant time. */
  byAgentToken(token: string): UserRecord | undefined {
    if (!token) return undefined;
    let found: UserRecord | undefined;
    for (const u of this.load().values()) if (u.agentToken && sameSecret(u.agentToken, token)) found = u;
    return found ? clone(found) : undefined;
  }

  /** A record whose phone is not known yet (`""`) is never matched. */
  byPhone(phone: string): UserRecord | undefined {
    if (!phone) return undefined;
    for (const u of this.load().values()) if (u.phone === phone) return clone(u);
    return undefined;
  }

  save(u: UserRecord): UserRecord {
    const next = { ...clone(u), updatedAt: new Date().toISOString() };
    this.load().set(next.id, next);
    this.persist();
    return clone(next);
  }

  remove(id: string): boolean {
    const removed = this.load().delete(id);
    if (removed) this.persist();
    return removed;
  }

  private load(): Map<string, UserRecord> {
    if (this.cache) return this.cache;
    const map = new Map<string, UserRecord>();
    if (existsSync(this.file)) {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoreFile | UserRecord[];
      const users = Array.isArray(parsed) ? parsed : parsed.users ?? [];
      for (const u of users) map.set(u.id, u);
    }
    this.cache = map;
    return map;
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const body: StoreFile = { version: 1, users: [...this.load().values()] };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
    // rename keeps the temp file's mode, but an older file may have been created more loosely.
    chmodSync(this.file, 0o600);
  }
}

/** Equal secrets, without leaking where they differ: both sides are hashed to one length first. */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Strip anything a browser or a log line must not see. The name and the
 * provisioning error text stay out too: the id can leak, and this JSON must not
 * turn a leaked id into a profile.
 */
export function publicUser(u: UserRecord): Record<string, unknown> {
  return {
    id: u.id,
    handle: u.handle,
    phoneMasked: maskPhone(u.phone),
    status: u.status,
    hasError: u.status === "error",
    hasAgent: Boolean(u.maritimeAgentId),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${phone.slice(0, 2)}${"•".repeat(Math.max(0, phone.length - 6))}${phone.slice(-4)}`;
}
