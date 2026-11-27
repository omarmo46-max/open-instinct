/**
 * The owner's EGP budget. Egypt has no wallet API an agent can call, so the budget is the rule that
 * keeps the agent honest: a pool the owner sets, a per-purchase cap and a daily cap. Each card request
 * puts a hold on the pool; the hold becomes spend when the purchase is done, or is released if it fails.
 */
import type { StateDir } from "@open-instinct/core";
import { cairoDay, fmtEgp } from "./money.js";

export const BUDGET_FILE = "egp-budget.json";
const KEEP_HOLDS = 200;

export interface Hold {
  id: string;
  piasters: number;
  merchant: string;
  day: string;
  createdAt: string;
  status: "held" | "committed" | "released";
  finalPiasters?: number;
}

export interface BudgetState {
  version: 1;
  enabled: boolean;
  /** Money the owner has set aside for the agent. */
  poolPiasters: number;
  perPurchasePiasters: number;
  dailyPiasters: number;
  holds: Hold[];
}

export type BudgetCheck = { ok: true } | { ok: false; reason: string };

type Store = Pick<StateDir, "readJson" | "writeJson">;

const DEFAULTS: BudgetState = { version: 1, enabled: false, poolPiasters: 0, perPurchasePiasters: 0, dailyPiasters: 0, holds: [] };

export class EgpBudget {
  constructor(private readonly state: Store, private readonly now: () => Date = () => new Date()) {}

  get(): BudgetState {
    const raw = this.state.readJson<Partial<BudgetState>>(BUDGET_FILE, DEFAULTS);
    return { ...DEFAULTS, ...raw, version: 1, holds: Array.isArray(raw.holds) ? raw.holds : [] };
  }

  private save(s: BudgetState): void {
    s.holds = s.holds.slice(-KEEP_HOLDS);
    this.state.writeJson(BUDGET_FILE, s);
  }

  set(patch: Partial<Pick<BudgetState, "enabled" | "poolPiasters" | "perPurchasePiasters" | "dailyPiasters">>): BudgetState {
    const s = { ...this.get(), ...patch };
    this.save(s);
    return s;
  }

  /** Pool minus spend and open holds. */
  available(s = this.get()): number {
    const used = s.holds.reduce((n, h) => n + (h.status === "committed" ? (h.finalPiasters ?? h.piasters) : h.status === "held" ? h.piasters : 0), 0);
    return Math.max(0, s.poolPiasters - used);
  }

  usedToday(s = this.get()): number {
    const today = cairoDay(this.now());
    return s.holds
      .filter((h) => h.day === today && h.status !== "released")
      .reduce((n, h) => n + (h.status === "committed" ? (h.finalPiasters ?? h.piasters) : h.piasters), 0);
  }

  check(piasters: number): BudgetCheck {
    const s = this.get();
    if (!s.enabled) return { ok: false, reason: "The EGP budget is off. The owner turns it on with egp_budget_set." };
    if (s.perPurchasePiasters > 0 && piasters > s.perPurchasePiasters) return { ok: false, reason: `Above the per-purchase cap of ${fmtEgp(s.perPurchasePiasters)}.` };
    if (piasters > this.available(s)) return { ok: false, reason: `Not enough budget left: ${fmtEgp(this.available(s))} available.` };
    if (s.dailyPiasters > 0 && this.usedToday(s) + piasters > s.dailyPiasters) return { ok: false, reason: `Past today's cap of ${fmtEgp(s.dailyPiasters)} (${fmtEgp(this.usedToday(s))} used).` };
    return { ok: true };
  }

  reserve(id: string, piasters: number, merchant: string): BudgetCheck {
    const c = this.check(piasters);
    if (!c.ok) return c;
    const s = this.get();
    s.holds.push({ id, piasters, merchant, day: cairoDay(this.now()), createdAt: this.now().toISOString(), status: "held" });
    this.save(s);
    return { ok: true };
  }

  commit(id: string, finalPiasters?: number): boolean {
    return this.settle(id, "committed", finalPiasters);
  }

  release(id: string): boolean {
    return this.settle(id, "released");
  }

  private settle(id: string, status: "committed" | "released", finalPiasters?: number): boolean {
    const s = this.get();
    const h = s.holds.find((x) => x.id === id && x.status === "held");
    if (!h) return false;
    h.status = status;
    if (finalPiasters !== undefined) h.finalPiasters = finalPiasters;
    this.save(s);
    return true;
  }
}
