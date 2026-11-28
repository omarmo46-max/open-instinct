import type { AuditLog, InstinctConfig, Outbox, RegisteredTool, StateDir } from "@open-instinct/core";
import { EgpBudget } from "./budget.js";
import { EgpCardStore } from "./cards.js";
import { IssuerRegistry, vodafoneCashManual, type CardIssuer } from "./issuer.js";
import { EGP_PAGE_PREFIX, handleEgpCardPage, type PageResult } from "./page.js";
import { egpTools } from "./tools.js";

export interface EgpRailOptions {
  state: StateDir;
  outbox: Outbox;
  config: InstinctConfig;
  audit: Pick<AuditLog, "append">;
  publicUrl: string;
  /** Extra issuers, such as a partner's automatic one. */
  issuers?: CardIssuer[];
  issuerId?: string;
  now?: () => Date;
}

export interface EgpRail {
  tools: RegisteredTool[];
  /** Serves the owner's private card page. Returns undefined for paths that are not its own. */
  handleHttp(method: string, path: string, body: string): PageResult | undefined;
  /** What the dashboard shows: budget, caps and open card requests. Never card data. */
  status(): { enabled: boolean; poolPiasters: number; availablePiasters: number; usedTodayPiasters: number; perPurchasePiasters: number; dailyPiasters: number; open: Array<{ id: string; piasters: number; merchant: string; status: string }> };
}

export function createEgpRail(o: EgpRailOptions): EgpRail {
  const now = o.now ?? (() => new Date());
  const budget = new EgpBudget(o.state, now);
  const cards = new EgpCardStore(o.state, now);
  const issuers = new IssuerRegistry([vodafoneCashManual, ...(o.issuers ?? [])]);
  const tools = egpTools({ outbox: o.outbox, config: o.config, audit: o.audit, state: o.state, budget, cards, issuers, issuerId: o.issuerId ?? vodafoneCashManual.id, publicUrl: o.publicUrl.replace(/\/+$/, "") });
  return {
    tools,
    handleHttp: (method, path, body) => (path.startsWith(EGP_PAGE_PREFIX) ? handleEgpCardPage(cards, method, path, body) : undefined),
    status: () => {
      cards.sweep();
      const b = budget.get();
      return {
        enabled: b.enabled,
        poolPiasters: b.poolPiasters,
        availablePiasters: budget.available(b),
        usedTodayPiasters: budget.usedToday(b),
        perPurchasePiasters: b.perPurchasePiasters,
        dailyPiasters: b.dailyPiasters,
        open: cards.list().filter((r) => ["awaiting_card", "card_ready", "delivered"].includes(r.status)).map((r) => ({ id: r.id, piasters: r.piasters, merchant: r.merchant, status: r.status })),
      };
    },
  };
}

export { EgpBudget, BUDGET_FILE } from "./budget.js";
export { EgpCardStore, CARDS_FILE, luhn, validateCard, type CardData, type CardRequest } from "./cards.js";
export { IssuerRegistry, vodafoneCashManual, type AutomaticCardIssuer, type CardIssuer, type IssueRequest, type IssuedCard, type ManualCardIssuer } from "./issuer.js";
export { fmtEgp, toPiasters, cairoDay, EGP_CURRENCY, MAX_EGP } from "./money.js";
export { egpTools, type EgpToolDeps } from "./tools.js";
export { handleEgpCardPage, EGP_PAGE_PREFIX } from "./page.js";
