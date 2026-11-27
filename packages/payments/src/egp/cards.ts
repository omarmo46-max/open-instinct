/**
 * One-time card intake. The owner creates a temporary card in their wallet app and types it into a
 * private page (never into chat). Card data lives only in a 0600 file, is handed to the agent once,
 * and is deleted on pickup or expiry. The request file never holds card data.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { StateDir } from "@open-instinct/core";
import { writeSecret, readSecret } from "../wallet.js";

export const CARDS_FILE = "egp-cards.json";
export const FORM_TTL_MS = 30 * 60_000;
/** Temporary wallet cards last 24 hours; the agent gets a shorter window. */
export const CARD_TTL_MS = 24 * 3600_000;

export type CardStatus = "awaiting_card" | "card_ready" | "delivered" | "done" | "failed" | "expired";

export interface CardRequest {
  id: string;
  tokenHash: string;
  piasters: number;
  merchant: string;
  merchantUrl?: string;
  reason: string;
  requestedBy: string;
  conversationKey: string;
  issuerId: string;
  status: CardStatus;
  createdAt: string;
  formExpiresAt: string;
  cardExpiresAt?: string;
}

export interface CardData {
  number: string;
  expMonth: number;
  expYear: number;
  cvv: string;
  holder?: string;
}

type Store = Pick<StateDir, "readJson" | "writeJson" | "path">;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function luhn(num: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function validateCard(c: CardData, now: Date): string | undefined {
  if (!/^\d{13,19}$/.test(c.number) || !luhn(c.number)) return "The card number is not valid.";
  if (!Number.isInteger(c.expMonth) || c.expMonth < 1 || c.expMonth > 12) return "The expiry month is not valid.";
  const year = c.expYear < 100 ? 2000 + c.expYear : c.expYear;
  if (year < now.getUTCFullYear() || (year === now.getUTCFullYear() && c.expMonth < now.getUTCMonth() + 1)) return "The card has expired.";
  if (!/^\d{3,4}$/.test(c.cvv)) return "The security code is not valid.";
  return undefined;
}

export class EgpCardStore {
  constructor(private readonly state: Store, private readonly now: () => Date = () => new Date()) {}

  private read(): CardRequest[] {
    const raw = this.state.readJson<{ requests?: CardRequest[] }>(CARDS_FILE, {});
    return Array.isArray(raw.requests) ? raw.requests : [];
  }
  private write(r: CardRequest[]): void {
    this.state.writeJson(CARDS_FILE, { version: 1, requests: r.slice(-200) });
  }
  private secretPath(id: string): string {
    return this.state.path("egp", `${id}.card.json`);
  }

  get(id: string): CardRequest | undefined {
    return this.read().find((r) => r.id === id);
  }
  list(): CardRequest[] {
    return this.read();
  }

  create(p: Omit<CardRequest, "id" | "tokenHash" | "status" | "createdAt" | "formExpiresAt" | "cardExpiresAt">): { request: CardRequest; token: string } {
    const id = `egp_${crypto.randomBytes(6).toString("hex")}`;
    const token = crypto.randomBytes(24).toString("base64url");
    const request: CardRequest = {
      ...p,
      id,
      tokenHash: sha(token),
      status: "awaiting_card",
      createdAt: this.now().toISOString(),
      formExpiresAt: new Date(this.now().getTime() + FORM_TTL_MS).toISOString(),
    };
    this.write([...this.read(), request]);
    return { request, token };
  }

  tokenOk(r: CardRequest, token: string): boolean {
    const a = Buffer.from(sha(token));
    const b = Buffer.from(r.tokenHash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** The owner's page calls this. Returns an error message, or undefined on success. */
  submit(id: string, token: string, card: CardData): string | undefined {
    this.sweep();
    const r = this.get(id);
    if (!r || !this.tokenOk(r, token)) return "This link is not valid.";
    if (r.status !== "awaiting_card") return "This request is no longer waiting for a card.";
    const bad = validateCard(card, this.now());
    if (bad) return bad;
    this.store(r, card);
    return undefined;
  }

  /** An automatic issuer (a future partner) hands the card over directly. */
  storeIssued(id: string, card: CardData, validUntil?: Date): void {
    const r = this.get(id);
    if (!r) throw new Error("unknown card request");
    this.store(r, card, validUntil);
  }

  private store(r: CardRequest, card: CardData, validUntil?: Date): void {
    writeSecret(this.secretPath(r.id), card);
    const until = validUntil ?? new Date(this.now().getTime() + CARD_TTL_MS);
    this.update(r.id, { status: "card_ready", cardExpiresAt: until.toISOString() });
  }

  /** Hand over the card once and delete it. */
  pickup(id: string): { request: CardRequest; card: CardData } | { error: string } {
    this.sweep();
    const r = this.get(id);
    if (!r) return { error: "Unknown card request." };
    if (r.status === "awaiting_card") return { error: "The owner has not created the card yet." };
    if (r.status !== "card_ready") return { error: `The card is not available (status: ${r.status}). Make a new request if you still need to pay.` };
    const card = readSecret<CardData>(this.secretPath(id));
    this.destroy(id);
    if (!card) return { error: "The card data is gone. Make a new request." };
    this.update(id, { status: "delivered" });
    return { request: { ...r, status: "delivered" }, card };
  }

  finish(id: string, status: "done" | "failed"): CardRequest | undefined {
    this.destroy(id);
    return this.update(id, { status });
  }

  /** Expire stale requests and delete any card data they still hold. */
  sweep(): void {
    const t = this.now().getTime();
    const all = this.read();
    let changed = false;
    for (const r of all) {
      const stale =
        (r.status === "awaiting_card" && Date.parse(r.formExpiresAt) < t) || (r.status === "card_ready" && r.cardExpiresAt !== undefined && Date.parse(r.cardExpiresAt) < t);
      if (stale) {
        this.destroy(r.id);
        r.status = "expired";
        changed = true;
      }
    }
    if (changed) this.write(all);
  }

  private destroy(id: string): void {
    fs.rmSync(this.secretPath(id), { force: true });
  }

  private update(id: string, patch: Partial<CardRequest>): CardRequest | undefined {
    const all = this.read();
    const r = all.find((x) => x.id === id);
    if (!r) return undefined;
    Object.assign(r, patch);
    this.write(all);
    return r;
  }
}
