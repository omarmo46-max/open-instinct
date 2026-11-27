/**
 * C7 TOTP (RFC 6238) and step-up. `StepUp` makes the owner type a fresh code from their
 * authenticator app before a sensitive action (revealing a stored secret, using a credential).
 * The code is caught by the runtime before the model sees it.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("not a base32 secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (out.length === 0) throw new Error("empty secret");
  return Buffer.from(out);
}

export type TotpAlgo = "sha1" | "sha256" | "sha512";

export function hotp(secret: Buffer, counter: number, digits = 6, algo: TotpAlgo = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algo, secret).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export interface TotpOptions {
  now?: Date;
  step?: number;
  digits?: number;
  algo?: TotpAlgo;
}

export function totp(secretBase32: string, o: TotpOptions = {}): string {
  const step = o.step ?? 30;
  return hotp(base32Decode(secretBase32), Math.floor((o.now ?? new Date()).getTime() / 1000 / step), o.digits ?? 6, o.algo ?? "sha1");
}

/** Accepts the current code and `window` steps either side (clock drift). Returns the step it matched, so a caller can refuse a replay. */
export function verifyTotp(secretBase32: string, code: string, o: TotpOptions & { window?: number } = {}): { ok: boolean; step?: number } {
  const digits = o.digits ?? 6;
  const clean = code.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return { ok: false };
  const stepSize = o.step ?? 30;
  const secret = base32Decode(secretBase32);
  const nowStep = Math.floor((o.now ?? new Date()).getTime() / 1000 / stepSize);
  const window = o.window ?? 1;
  for (let d = -window; d <= window; d++) {
    const expected = Buffer.from(hotp(secret, nowStep + d, digits, o.algo ?? "sha1"));
    const given = Buffer.from(clean);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return { ok: true, step: nowStep + d };
  }
  return { ok: false };
}

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function otpauthUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  return `otpauth://totp/${label}?secret=${opts.secret}&issuer=${encodeURIComponent(opts.issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export interface StepUpOptions {
  /** The owner's TOTP secret, or undefined when step-up is not set up (then nothing is required). */
  secret: () => string | undefined;
  now?: () => Date;
  /** How long a verified code unlocks sensitive actions. */
  elevatedMs?: number;
  /** How long a challenge waits for its code. */
  challengeMs?: number;
  maxFailures?: number;
  lockMs?: number;
}

const TEXT = {
  en: { ok: "Verified. Sensitive actions are unlocked for {min} minutes.", bad: "That code did not work. {left} tries left.", locked: "Too many wrong codes. Step-up is locked for {min} minutes.", replay: "That code was already used. Wait for the next one." },
  ar: { ok: "تم التحقق. الإجراءات الحساسة مفتوحة لمدة {min} دقايق.", bad: "الكود ده مش صح. فاضل {left} محاولات.", locked: "محاولات غلط كتير. التحقق مقفول لمدة {min} دقيقة.", replay: "الكود ده اتستخدم قبل كده. استنى الكود اللي بعده." },
} as const;

export class StepUp {
  private readonly o: StepUpOptions;
  private readonly now: () => Date;
  private elevatedUntil = 0;
  private pendingUntil = 0;
  private failures = 0;
  private lockedUntil = 0;
  private lastStep = -1;

  constructor(o: StepUpOptions) {
    this.o = o;
    this.now = o.now ?? (() => new Date());
  }

  enabled(): boolean {
    return Boolean(this.o.secret());
  }

  isElevated(): boolean {
    return this.now().getTime() < this.elevatedUntil;
  }

  isLocked(): boolean {
    return this.now().getTime() < this.lockedUntil;
  }

  /** Remember that a code is expected, so a bare number from the owner is treated as one. */
  challenge(): void {
    this.pendingUntil = this.now().getTime() + (this.o.challengeMs ?? 5 * 60_000);
  }

  hasPending(): boolean {
    return this.now().getTime() < this.pendingUntil;
  }

  /** An owner message that is only a 6-digit code while a challenge is open. */
  tryCode(text: string): { handled: boolean; ok?: boolean; reply?: string } {
    const secret = this.o.secret();
    if (!secret || !this.hasPending() || !/^\s*\d{6}\s*$/.test(text)) return { handled: false };
    const lang = /[\u0600-\u06FF]/.test(text) ? "ar" : "en";
    const t = TEXT[lang];
    const min = (ms: number): string => String(Math.max(1, Math.round(ms / 60_000)));
    const now = this.now().getTime();
    if (this.isLocked()) return { handled: true, ok: false, reply: t.locked.replace("{min}", min(this.lockedUntil - now)) };
    const r = verifyTotp(secret, text, { now: this.now() });
    if (r.ok && r.step !== undefined && r.step <= this.lastStep) return { handled: true, ok: false, reply: t.replay };
    if (r.ok) {
      this.lastStep = r.step ?? this.lastStep;
      this.failures = 0;
      this.pendingUntil = 0;
      this.elevatedUntil = now + (this.o.elevatedMs ?? 5 * 60_000);
      return { handled: true, ok: true, reply: t.ok.replace("{min}", min(this.o.elevatedMs ?? 5 * 60_000)) };
    }
    this.failures++;
    const max = this.o.maxFailures ?? 5;
    if (this.failures >= max) {
      this.lockedUntil = now + (this.o.lockMs ?? 15 * 60_000);
      this.failures = 0;
      this.pendingUntil = 0;
      return { handled: true, ok: false, reply: t.locked.replace("{min}", min(this.o.lockMs ?? 15 * 60_000)) };
    }
    return { handled: true, ok: false, reply: t.bad.replace("{left}", String(max - this.failures)) };
  }
}
