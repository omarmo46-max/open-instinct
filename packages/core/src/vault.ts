/**
 * C6 vault: logins, cards and addresses, encrypted at rest with AES-256-GCM. The key comes from
 * the environment (`ORION_VAULT_KEY`, 32 bytes as base64 or hex) or a passphrase run through
 * scrypt (`ORION_VAULT_PASSPHRASE`). Card security codes (CVV) are never stored.
 * The model never needs the values: it writes `{{secret:vault:Label.field}}` and the runtime
 * fills it in after the owner says yes (see SecretBroker).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import { luhnValid } from "./action-monitor.js";
import type { StateDir } from "./state.js";

const FILE = "vault.enc.json";
const MAX_ENTRIES = 500;
const MAX_FIELD = 2000;

export type VaultType = "login" | "card" | "address" | "note";

export interface VaultEntry {
  id: string;
  type: VaultType;
  label: string;
  fields: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface VaultSummary {
  id: string;
  type: VaultType;
  label: string;
  /** What a person needs to recognise it: never a secret. */
  hint: string;
}

const SPEC: Record<VaultType, { required: string[]; optional: string[]; secret: string[] }> = {
  login: { required: ["site", "username", "password"], optional: ["totpSecret", "notes"], secret: ["password", "totpSecret"] },
  card: { required: ["holder", "number", "expMonth", "expYear"], optional: ["brand", "billingAddress"], secret: ["number"] },
  address: { required: ["name", "line1", "city", "country"], optional: ["line2", "region", "postal", "phone", "email"], secret: [] },
  note: { required: ["text"], optional: [], secret: ["text"] },
};

export function isVaultType(t: string): t is VaultType {
  return t in SPEC;
}

interface Stored {
  v: 1;
  kdf: "raw" | "scrypt";
  salt?: string;
  nonce: string;
  tag: string;
  ct: string;
}

export function keyFromEnv(env: { ORION_VAULT_KEY?: string | undefined }): Buffer | undefined {
  const raw = env.ORION_VAULT_KEY?.trim();
  if (!raw) return undefined;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("ORION_VAULT_KEY must be 32 bytes (64 hex characters or base64)");
  return buf;
}

const clean = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new Error(`${name} must be text`);
  const s = v.replace(/\r\n/g, "\n").trim();
  if (s.length > MAX_FIELD) throw new Error(`${name} is too long`);
  return s;
};

export class Vault {
  private readonly state: StateDir;
  private readonly rawKey: Buffer | undefined;
  private readonly passphrase: string | undefined;
  private readonly now: () => Date;
  private cache: VaultEntry[] | undefined;
  private salt: Buffer | undefined;
  private derived: Buffer | undefined;

  constructor(state: StateDir, opts: { key?: Buffer | undefined; passphrase?: string | undefined; now?: () => Date } = {}) {
    this.state = state;
    this.rawKey = opts.key;
    this.passphrase = opts.passphrase;
    this.now = opts.now ?? (() => new Date());
  }

  /** True when a key or passphrase was given. Without one the vault stays shut. */
  get configured(): boolean {
    return Boolean(this.rawKey ?? this.passphrase);
  }

  private keyFor(salt: Buffer | undefined): Buffer {
    if (this.rawKey) return this.rawKey;
    if (!this.passphrase || !salt) throw new Error("the vault has no key");
    if (!this.derived) this.derived = scryptSync(this.passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    return this.derived;
  }

  private load(): VaultEntry[] {
    if (this.cache) return this.cache;
    if (!this.configured) throw new Error("the vault is locked: set ORION_VAULT_KEY or ORION_VAULT_PASSPHRASE");
    const stored = this.state.readJson<Partial<Stored>>(FILE, {});
    if (!stored.ct || !stored.nonce || !stored.tag) {
      this.cache = [];
      return this.cache;
    }
    const salt = stored.salt ? Buffer.from(stored.salt, "base64") : undefined;
    if (stored.kdf === "scrypt" && !this.passphrase) throw new Error("this vault was made with a passphrase; set ORION_VAULT_PASSPHRASE");
    this.salt = salt;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.keyFor(salt), Buffer.from(stored.nonce, "base64"));
      decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
      const json = Buffer.concat([decipher.update(Buffer.from(stored.ct, "base64")), decipher.final()]).toString("utf8");
      this.cache = (JSON.parse(json) as { entries: VaultEntry[] }).entries;
    } catch {
      throw new Error("the vault cannot be opened with this key");
    }
    return this.cache;
  }

  private save(entries: VaultEntry[]): void {
    if (!this.rawKey && !this.salt) this.salt = randomBytes(16);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keyFor(this.salt), nonce);
    const ct = Buffer.concat([cipher.update(JSON.stringify({ entries }), "utf8"), cipher.final()]);
    const out: Stored = { v: 1, kdf: this.rawKey ? "raw" : "scrypt", ...(this.salt && !this.rawKey ? { salt: this.salt.toString("base64") } : {}), nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
    this.state.writeJson(FILE, out);
    try {
      fs.chmodSync(this.state.path(FILE), 0o600);
    } catch {
      // best effort
    }
    this.cache = entries;
  }

  private validate(type: VaultType, fields: Record<string, unknown>): Record<string, string> {
    const spec = SPEC[type];
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (/cvv|cvc|security.?code|\bpin\b|card.?verification/i.test(k)) throw new Error("card security codes are never stored");
      if (![...spec.required, ...spec.optional].includes(k)) throw new Error(`unknown field "${k}" for a ${type}`);
      const value = clean(v, k);
      if (value) out[k] = value;
    }
    for (const k of spec.required) if (!out[k]) throw new Error(`a ${type} needs "${k}"`);
    if (type === "card") {
      const digits = out.number!.replace(/[ -]/g, "");
      if (!luhnValid(digits)) throw new Error("that card number is not valid");
      out.number = digits;
      const m = Number(out.expMonth);
      if (!(m >= 1 && m <= 12)) throw new Error("expMonth must be 1 to 12");
      if (!/^\d{2}(\d{2})?$/.test(out.expYear!)) throw new Error("expYear must be 2 or 4 digits");
    }
    return out;
  }

  list(): VaultSummary[] {
    return this.load().map(summarize);
  }

  find(idOrLabel: string): VaultEntry | undefined {
    const q = idOrLabel.trim().toLowerCase();
    return this.load().find((e) => e.id === idOrLabel.trim() || e.label.toLowerCase() === q);
  }

  put(input: { type: string; label: string; fields: Record<string, unknown> }): VaultEntry {
    if (!isVaultType(input.type)) throw new Error("type must be login, card, address or note");
    const entries = this.load();
    const label = clean(input.label, "label");
    if (!label || /[{}]/.test(label)) throw new Error("a label is needed and may not contain { or }");
    if (entries.some((e) => e.label.toLowerCase() === label.toLowerCase())) throw new Error(`there is already an entry called "${label}"`);
    if (entries.length >= MAX_ENTRIES) throw new Error("the vault is full");
    const at = this.now().toISOString();
    const entry: VaultEntry = { id: `v_${randomBytes(4).toString("hex")}`, type: input.type, label, fields: this.validate(input.type, input.fields), createdAt: at, updatedAt: at };
    this.save([...entries, entry]);
    return entry;
  }

  update(idOrLabel: string, fields: Record<string, unknown>): VaultEntry {
    const entries = this.load();
    const e = this.find(idOrLabel);
    if (!e) throw new Error(`nothing called "${idOrLabel}"`);
    const merged = this.validate(e.type, { ...e.fields, ...fields });
    const next: VaultEntry = { ...e, fields: merged, updatedAt: this.now().toISOString() };
    this.save(entries.map((x) => (x.id === e.id ? next : x)));
    return next;
  }

  remove(idOrLabel: string): boolean {
    const entries = this.load();
    const e = this.find(idOrLabel);
    if (!e) return false;
    this.save(entries.filter((x) => x.id !== e.id));
    return true;
  }

  /** `vault:<id or label>.<field>`. Throws when it does not point at a stored field. */
  lookup(ref: string): string {
    const m = /^vault:(.+)\.([A-Za-z0-9]+)$/.exec(ref.trim());
    if (!m) throw new Error(`"${ref}" is not a vault reference (use vault:Label.field)`);
    const e = this.find(m[1]!);
    if (!e) throw new Error(`nothing called "${m[1]}" in the vault`);
    const value = e.fields[m[2]!];
    if (value === undefined) throw new Error(`"${e.label}" has no field "${m[2]}"`);
    return value;
  }

  /** Every secret value, so it can be kept out of logs, replies and outgoing calls. */
  secretValues(): string[] {
    if (!this.configured) return [];
    const out: string[] = [];
    for (const e of this.load()) for (const f of SPEC[e.type].secret) if (e.fields[f] && e.fields[f]!.length >= 4) out.push(e.fields[f]!);
    return out;
  }

  /** Re-encrypt under a new key or passphrase. */
  rotate(next: { key?: Buffer; passphrase?: string }): Vault {
    const entries = this.load();
    const fresh = new Vault(this.state, { ...next, now: this.now });
    fresh.salt = next.key ? undefined : randomBytes(16);
    fresh.save(entries);
    return fresh;
  }
}

export function maskCard(number: string): string {
  return `····${number.slice(-4)}`;
}

function summarize(e: VaultEntry): VaultSummary {
  const f = e.fields;
  const hint = e.type === "login" ? `${f.site} (${f.username})` : e.type === "card" ? `${f.brand ?? "card"} ${maskCard(f.number ?? "")} (${f.holder})` : e.type === "address" ? `${f.line1}, ${f.city}` : "note";
  return { id: e.id, type: e.type, label: e.label, hint };
}
