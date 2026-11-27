/**
 * C4 signed tool identity and short-lived credentials.
 * - The agent has an Ed25519 identity. Every tool is fingerprinted (name, description, schema,
 *   capabilities) and the fingerprint is pinned and signed. A tool whose description or schema
 *   changes after it was pinned (the "rug pull" of a tool server) is quarantined until the owner
 *   approves the new fingerprint.
 * - A signed manifest lets another agent verify which tools this one runs.
 * - Credentials for a single tool call are signed tokens that expire in minutes, can be limited
 *   to one tool and one use, and can be revoked.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from "node:crypto";
import fs from "node:fs";
import type { RegisteredTool } from "./tools.js";
import type { StateDir } from "./state.js";

const b64 = (b: Buffer): string => b.toString("base64");
const b64url = (b: Buffer): string => b.toString("base64url");

/** JSON with sorted keys, so the same value always gives the same bytes. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, norm(x)]));
    return v;
  };
  return JSON.stringify(norm(value));
}

export function writePrivateFile(state: StateDir, name: string, value: unknown): void {
  state.writeJson(name, value);
  try {
    fs.chmodSync(state.path(name), 0o600);
  } catch {
    // best effort on filesystems without modes
  }
}

export class Identity {
  private readonly privateKeyPem: string;
  readonly publicKey: string;

  private constructor(privateKeyPem: string, publicKey: string) {
    this.privateKeyPem = privateKeyPem;
    this.publicKey = publicKey;
  }

  /** The agent's identity, created on first use and kept in `keys/identity.json` (mode 0600). */
  static load(state: StateDir): Identity {
    const stored = state.readJson<{ privateKeyPem?: string; publicKey?: string }>("keys/identity.json", {});
    if (stored.privateKeyPem && stored.publicKey) return new Identity(stored.privateKeyPem, stored.publicKey);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pub = b64(publicKey.export({ type: "spki", format: "der" }) as Buffer);
    writePrivateFile(state, "keys/identity.json", { version: 1, privateKeyPem: pem, publicKey: pub, createdAt: new Date().toISOString() });
    return new Identity(pem, pub);
  }

  get fingerprint(): string {
    return createHash("sha256").update(Buffer.from(this.publicKey, "base64")).digest("hex").slice(0, 16);
  }

  sign(data: string | Buffer): string {
    return b64(edSign(null, Buffer.from(data), createPrivateKey(this.privateKeyPem)));
  }

  static verify(publicKey: string, data: string | Buffer, signature: string): boolean {
    try {
      return edVerify(null, Buffer.from(data), createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  }
}

export function toolFingerprint(tool: RegisteredTool): string {
  const s = tool.spec;
  return createHash("sha256")
    .update(canonicalJson({ name: s.name, description: s.description, parameters: s.parameters, capabilities: [...s.meta.capabilities].sort(), secretAccess: s.meta.secretAccess === true, acceptsSecrets: s.meta.acceptsSecrets === true }))
    .digest("hex");
}

interface PinRecord {
  fingerprint: string;
  sig: string;
  firstSeen: string;
  approvedAt?: string;
}

export interface PinCheck {
  added: string[];
  changed: string[];
  unchanged: number;
}

export class ToolPins {
  private readonly state: StateDir;
  private readonly identity: Identity;
  private readonly now: () => Date;

  constructor(state: StateDir, identity: Identity, now: () => Date = () => new Date()) {
    this.state = state;
    this.identity = identity;
    this.now = now;
  }

  private load(): Record<string, PinRecord> {
    const raw = this.state.readJson<{ pins?: Record<string, PinRecord> }>("keys/tool-pins.json", {});
    return raw.pins && typeof raw.pins === "object" ? raw.pins : {};
  }

  private save(pins: Record<string, PinRecord>): void {
    writePrivateFile(this.state, "keys/tool-pins.json", { version: 1, pins });
  }

  private record(name: string, fingerprint: string, approved: boolean): PinRecord {
    return { fingerprint, sig: this.identity.sign(`${name}\n${fingerprint}`), firstSeen: this.now().toISOString(), ...(approved ? { approvedAt: this.now().toISOString() } : {}) };
  }

  /**
   * Compare the registry with the pins. New tools are pinned; a tool that differs from its pin (or
   * whose pin was tampered with) is reported as changed and not re-pinned. Only tools from outside
   * servers (`meta.external`) are watched: they can change under the agent between two starts, while
   * the agent's own tools change only when the software is upgraded.
   */
  check(tools: RegisteredTool[], watch: (t: RegisteredTool) => boolean = (t) => t.spec.meta.external === true): PinCheck {
    const pins = this.load();
    const out: PinCheck = { added: [], changed: [], unchanged: 0 };
    for (const tool of tools.filter(watch)) {
      const name = tool.spec.name;
      const fp = toolFingerprint(tool);
      const pin = pins[name];
      if (!pin) {
        pins[name] = this.record(name, fp, false);
        out.added.push(name);
      } else if (pin.fingerprint !== fp || !Identity.verify(this.identity.publicKey, `${name}\n${pin.fingerprint}`, pin.sig)) out.changed.push(name);
      else out.unchanged++;
    }
    if (out.added.length) this.save(pins);
    return out;
  }

  /** The owner accepts the tool as it is now. */
  approve(tool: RegisteredTool): void {
    const pins = this.load();
    const name = tool.spec.name;
    pins[name] = this.record(name, toolFingerprint(tool), true);
    this.save(pins);
  }

  list(): Array<{ name: string; fingerprint: string; approved: boolean }> {
    return Object.entries(this.load()).map(([name, p]) => ({ name, fingerprint: p.fingerprint.slice(0, 12), approved: Boolean(p.approvedAt) }));
  }
}

export interface ToolManifest {
  v: 1;
  agent: string;
  publicKey: string;
  issuedAt: string;
  tools: Array<{ name: string; fingerprint: string }>;
  signature: string;
}

export function signManifest(identity: Identity, tools: RegisteredTool[], now: Date = new Date()): ToolManifest {
  const body = { v: 1 as const, agent: identity.fingerprint, publicKey: identity.publicKey, issuedAt: now.toISOString(), tools: tools.map((t) => ({ name: t.spec.name, fingerprint: toolFingerprint(t) })).sort((a, b) => (a.name < b.name ? -1 : 1)) };
  return { ...body, signature: identity.sign(canonicalJson(body)) };
}

/** True when the manifest is signed by the key it carries (and by `expectedPublicKey` when given). */
export function verifyManifest(m: ToolManifest, expectedPublicKey?: string): boolean {
  if (expectedPublicKey && m.publicKey !== expectedPublicKey) return false;
  const { signature, ...body } = m;
  return Identity.verify(m.publicKey, canonicalJson(body), signature);
}

export interface CredentialClaims {
  iss: string;
  sub: string;
  aud: string;
  scp: string[];
  iat: number;
  exp: number;
  jti: string;
  once: boolean;
}

export const MAX_CREDENTIAL_SECONDS = 900;

export class CredentialIssuer {
  private readonly identity: Identity;
  private readonly now: () => Date;
  private readonly used = new Set<string>();
  private readonly revoked = new Set<string>();

  constructor(identity: Identity, now: () => Date = () => new Date()) {
    this.identity = identity;
    this.now = now;
  }

  issue(opts: { subject: string; audience: string; scope?: string[]; ttlSeconds?: number; singleUse?: boolean }): string {
    const iat = Math.floor(this.now().getTime() / 1000);
    const ttl = Math.min(MAX_CREDENTIAL_SECONDS, Math.max(5, Math.round(opts.ttlSeconds ?? 120)));
    const claims: CredentialClaims = { iss: this.identity.fingerprint, sub: opts.subject, aud: opts.audience, scp: opts.scope ?? [], iat, exp: iat + ttl, jti: b64url(randomBytes(9)), once: opts.singleUse === true };
    const payload = b64url(Buffer.from(JSON.stringify(claims)));
    return `ic1.${payload}.${b64url(Buffer.from(this.identity.sign(payload), "base64"))}`;
  }

  /** Check a credential for one tool and one scope. Throws a short reason when it is not acceptable. */
  verify(token: string, expect: { audience: string; scope?: string }): CredentialClaims {
    const [tag, payload, sig] = token.split(".");
    if (tag !== "ic1" || !payload || !sig) throw new Error("not a credential");
    if (!Identity.verify(this.identity.publicKey, payload, Buffer.from(sig, "base64url").toString("base64"))) throw new Error("bad signature");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CredentialClaims;
    const now = Math.floor(this.now().getTime() / 1000);
    if (now >= claims.exp) throw new Error("expired");
    if (claims.aud !== expect.audience) throw new Error("wrong audience");
    if (expect.scope && !claims.scp.includes(expect.scope)) throw new Error("scope not granted");
    if (this.revoked.has(claims.jti)) throw new Error("revoked");
    if (claims.once) {
      if (this.used.has(claims.jti)) throw new Error("already used");
      this.used.add(claims.jti);
      if (this.used.size > 5000) this.used.delete(this.used.values().next().value as string);
    }
    return claims;
  }

  revoke(token: string): void {
    const payload = token.split(".")[1];
    if (!payload) return;
    try {
      this.revoked.add((JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CredentialClaims).jti);
    } catch {
      // not a credential: nothing to revoke
    }
  }
}
