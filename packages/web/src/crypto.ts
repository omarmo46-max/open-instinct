import crypto from "node:crypto";

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const code6 = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await new Promise<Buffer>((res, rej) => crypto.scrypt(password, salt, 64, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const want = Buffer.from(keyB64, "base64");
  const got = await new Promise<Buffer>((res, rej) => crypto.scrypt(password, Buffer.from(saltB64, "base64"), want.length, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
  return crypto.timingSafeEqual(want, got);
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ct>, all base64url. */
export function seal(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function open(key: Buffer, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("bad sealed value");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
