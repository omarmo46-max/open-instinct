/**
 * C5 end-to-end encrypted files between agents. A sender encrypts a file for one peer with an
 * ephemeral X25519 key, HKDF-SHA256 and AES-256-GCM, and signs the envelope with its Ed25519
 * identity. Only the holder of the peer's private key can read it; a relay or a hub sees noise.
 * Peers are pinned on first sight, and a changed key is refused until the owner replaces it.
 */
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import type { StateDir } from "./state.js";
import { canonicalJson, Identity, writePrivateFile } from "./tool-identity.js";

export const MAX_E2EE_BYTES = 25 * 1024 * 1024;
const ALG = "x25519-hkdf-sha256-aes256gcm";
const INFO = Buffer.from("orion-e2ee-v1");

export interface PeerBundle {
  x25519: string;
  ed25519: string;
}

export interface Envelope {
  v: 1;
  alg: string;
  /** The sender's ephemeral X25519 public key (DER, base64). */
  epk: string;
  /** The recipient's X25519 public key, bound into the encryption. */
  to: string;
  salt: string;
  nonce: string;
  ct: string;
  tag: string;
  meta: { name?: string; size: number; createdAt: string };
  /** The sender's Ed25519 public key. Must equal the pinned key of the peer it came from. */
  from: string;
  sig: string;
}

const x25519Public = (b64: string) => createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
const header = (e: Omit<Envelope, "ct" | "tag" | "sig">): string => canonicalJson({ v: e.v, alg: e.alg, epk: e.epk, to: e.to, salt: e.salt, nonce: e.nonce, meta: e.meta, from: e.from });

export class AgentKeyring {
  private readonly state: StateDir;
  private readonly identity: Identity;
  private readonly now: () => Date;
  private privateKeyPem = "";
  private publicKey = "";

  constructor(state: StateDir, identity: Identity, now: () => Date = () => new Date()) {
    this.state = state;
    this.identity = identity;
    this.now = now;
    const stored = state.readJson<{ privateKeyPem?: string; publicKey?: string }>("keys/e2ee.json", {});
    if (stored.privateKeyPem && stored.publicKey) {
      this.privateKeyPem = stored.privateKeyPem;
      this.publicKey = stored.publicKey;
    } else {
      const { publicKey, privateKey } = generateKeyPairSync("x25519");
      this.privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      this.publicKey = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
      writePrivateFile(state, "keys/e2ee.json", { version: 1, privateKeyPem: this.privateKeyPem, publicKey: this.publicKey });
    }
  }

  /** What to hand to a peer so it can send you files. Public keys only. */
  bundle(): PeerBundle & { fingerprint: string } {
    const fp = createHash("sha256").update(this.publicKey).update(this.identity.publicKey).digest("hex").slice(0, 16);
    return { x25519: this.publicKey, ed25519: this.identity.publicKey, fingerprint: fp };
  }

  private peers(): Record<string, PeerBundle> {
    return this.state.readJson<{ peers?: Record<string, PeerBundle> }>("keys/peers.json", {}).peers ?? {};
  }

  peer(id: string): PeerBundle | undefined {
    return this.peers()[id];
  }

  private validBundle(b: PeerBundle): void {
    if (!b || typeof b.x25519 !== "string" || typeof b.ed25519 !== "string") throw new Error("a peer needs an x25519 and an ed25519 key");
    x25519Public(b.x25519); // throws on a malformed key
    createPublicKey({ key: Buffer.from(b.ed25519, "base64"), format: "der", type: "spki" });
  }

  /** Trust a peer's keys on first sight. The same keys again are fine; different keys are refused. */
  pinPeer(id: string, b: PeerBundle): "pinned" | "unchanged" {
    if (!/^[\w.@:-]{1,80}$/.test(id)) throw new Error("peer id may use letters, digits and . _ @ : -");
    this.validBundle(b);
    const peers = this.peers();
    const known = peers[id];
    if (known) {
      if (known.x25519 === b.x25519 && known.ed25519 === b.ed25519) return "unchanged";
      throw new Error(`the keys for ${id} changed; confirm with them in person, then replace the pin`);
    }
    peers[id] = { x25519: b.x25519, ed25519: b.ed25519 };
    writePrivateFile(this.state, "keys/peers.json", { version: 1, peers });
    return "pinned";
  }

  replacePeer(id: string, b: PeerBundle): void {
    this.validBundle(b);
    const peers = this.peers();
    peers[id] = { x25519: b.x25519, ed25519: b.ed25519 };
    writePrivateFile(this.state, "keys/peers.json", { version: 1, peers });
  }

  encryptFor(peerId: string, data: Buffer, meta: { name?: string } = {}): Envelope {
    const peer = this.peer(peerId);
    if (!peer) throw new Error(`no pinned keys for ${peerId}`);
    if (data.length > MAX_E2EE_BYTES) throw new Error(`file is larger than ${MAX_E2EE_BYTES / 1024 / 1024} MB`);
    const eph = generateKeyPairSync("x25519");
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Public(peer.x25519) });
    const key = Buffer.from(hkdfSync("sha256", shared, salt, INFO, 32));
    const base = {
      v: 1 as const,
      alg: ALG,
      epk: (eph.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"),
      to: peer.x25519,
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
      meta: { ...(meta.name ? { name: meta.name.slice(0, 200) } : {}), size: data.length, createdAt: this.now().toISOString() },
      from: this.identity.publicKey,
    };
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(header(base)));
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    const env = { ...base, ct: ct.toString("base64"), tag: tag.toString("base64") };
    return { ...env, sig: this.identity.sign(canonicalJson(env)) };
  }

  /** Decrypt an envelope from a pinned peer. Throws on a wrong sender, a wrong recipient or any change to the bytes. */
  decryptFrom(peerId: string, env: Envelope): { data: Buffer; name?: string } {
    const peer = this.peer(peerId);
    if (!peer) throw new Error(`no pinned keys for ${peerId}`);
    if (env.v !== 1 || env.alg !== ALG) throw new Error("unsupported envelope");
    if (env.from !== peer.ed25519) throw new Error(`this file was not signed by ${peerId}`);
    const { sig, ...signed } = env;
    if (!Identity.verify(peer.ed25519, canonicalJson(signed), sig)) throw new Error("bad signature");
    if (env.to !== this.publicKey) throw new Error("this file was encrypted for someone else");
    const shared = diffieHellman({ privateKey: createPrivateKey(this.privateKeyPem), publicKey: x25519Public(env.epk) });
    const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(env.salt, "base64"), INFO, 32));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.nonce, "base64"));
    decipher.setAAD(Buffer.from(header(env)));
    decipher.setAuthTag(Buffer.from(env.tag, "base64"));
    try {
      const data = Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]);
      return { data, ...(env.meta.name ? { name: env.meta.name } : {}) };
    } catch {
      throw new Error("the file is damaged or was changed");
    }
  }
}
