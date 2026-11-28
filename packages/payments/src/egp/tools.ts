/**
 * EGP payment tools. Same shape as the Stripe Link tools, so the agent's habits carry over:
 * request, wait for the owner, pick up once, report the outcome. Budget rules run before anything is asked.
 */
import { Type } from "typebox";
import type { AuditLog, Capability, InstinctConfig, Outbox, Principal, RegisteredTool, StateDir } from "@orion-ai/core";
import { defineTool, errorResult, textResult } from "../define.js";
import { EgpBudget } from "./budget.js";
import { CARD_TTL_MS, EgpCardStore } from "./cards.js";
import { IssuerRegistry } from "./issuer.js";
import { MAX_EGP, fmtEgp, toPiasters } from "./money.js";

export interface EgpToolDeps {
  outbox: Outbox;
  config: InstinctConfig;
  audit: Pick<AuditLog, "append">;
  state: Pick<StateDir, "readJson" | "writeJson" | "path">;
  budget: EgpBudget;
  cards: EgpCardStore;
  issuers: IssuerRegistry;
  /** Which issuer to use. Default: the manual Vodafone Cash one. */
  issuerId: string;
  /** Public base URL for the private card page, no trailing slash. */
  publicUrl: string;
}

const isOwner = (p: Principal) => p.kind === "owner";
const META = { capabilities: ["purchase"] as Capability[], group: "apps" as const, recordsOwnSpend: true, amountUsd: () => 0 };

export function egpTools(deps: EgpToolDeps): RegisteredTool[] {
  return [statusTool(deps), setTool(deps), requestTool(deps), pickupTool(deps), doneTool(deps)];
}

function statusTool(d: EgpToolDeps): RegisteredTool {
  return defineTool({
    name: "egp_budget_status",
    label: "EGP budget status",
    description: "Show the owner's EGP budget: what is left, today's use, the caps and open card requests. Owner only.",
    parameters: Type.Object({}),
    meta: { ...META, describe: () => "read EGP budget" },
    execute: async (_a, ctx) => {
      if (!isOwner(ctx.principal)) return errorResult("Only the owner can see the budget.");
      d.cards.sweep();
      const s = d.budget.get();
      const open = d.cards.list().filter((r) => r.status === "awaiting_card" || r.status === "card_ready" || r.status === "delivered");
      return textResult(
        [
          `EGP budget is ${s.enabled ? "on" : "off"}.`,
          `Available: ${fmtEgp(d.budget.available(s))} of ${fmtEgp(s.poolPiasters)}.`,
          `Today: ${fmtEgp(d.budget.usedToday(s))}${s.dailyPiasters ? ` of ${fmtEgp(s.dailyPiasters)}` : " (no daily cap)"}.`,
          `Per purchase cap: ${s.perPurchasePiasters ? fmtEgp(s.perPurchasePiasters) : "none"}.`,
          `Open card requests: ${open.length ? open.map((r) => `${r.id} ${fmtEgp(r.piasters)} ${r.merchant} [${r.status}]`).join("; ") : "none"}.`,
        ].join("\n"),
      );
    },
  });
}

function setTool(d: EgpToolDeps): RegisteredTool {
  return defineTool({
    name: "egp_budget_set",
    label: "Set EGP budget",
    description: "Set the EGP budget the agent may spend: the pool, a per-purchase cap, a daily cap, and on/off. Owner only. Amounts in Egyptian pounds.",
    parameters: Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      budgetEgp: Type.Optional(Type.Number({ description: "Total pool in EGP. Keep the wallet balance at or above this." })),
      perPurchaseEgp: Type.Optional(Type.Number({ description: "Cap for one purchase; 0 means none" })),
      dailyEgp: Type.Optional(Type.Number({ description: "Cap per day (Cairo time); 0 means none" })),
    }),
    meta: { ...META, describe: () => "set EGP budget" },
    execute: async ({ enabled, budgetEgp, perPurchaseEgp, dailyEgp }, ctx) => {
      if (!isOwner(ctx.principal)) return errorResult("Only the owner can change the budget.");
      const patch: Parameters<EgpBudget["set"]>[0] = {};
      const conv = (v: number, allowZero: boolean): number | undefined => (allowZero && v === 0 ? 0 : toPiasters(v));
      if (enabled !== undefined) patch.enabled = enabled;
      if (budgetEgp !== undefined) {
        const p = conv(budgetEgp, true);
        if (p === undefined) return errorResult(`budgetEgp must be between 0 and ${MAX_EGP}.`);
        patch.poolPiasters = p;
      }
      if (perPurchaseEgp !== undefined) {
        const p = conv(perPurchaseEgp, true);
        if (p === undefined) return errorResult("perPurchaseEgp is not a valid amount.");
        patch.perPurchasePiasters = p;
      }
      if (dailyEgp !== undefined) {
        const p = conv(dailyEgp, true);
        if (p === undefined) return errorResult("dailyEgp is not a valid amount.");
        patch.dailyPiasters = p;
      }
      const s = d.budget.set(patch);
      d.audit.append({ kind: "security", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { event: "egp_budget_set", enabled: s.enabled, poolPiasters: s.poolPiasters, perPurchasePiasters: s.perPurchasePiasters, dailyPiasters: s.dailyPiasters } });
      return textResult(`Budget saved. ${s.enabled ? "On" : "Off"}, ${fmtEgp(d.budget.available(s))} available, per purchase ${s.perPurchasePiasters ? fmtEgp(s.perPurchasePiasters) : "no cap"}, daily ${s.dailyPiasters ? fmtEgp(s.dailyPiasters) : "no cap"}.`);
    },
  });
}

function requestTool(d: EgpToolDeps): RegisteredTool {
  return defineTool({
    name: "egp_card_request",
    label: "Request an EGP one-time card",
    description:
      "Ask for a one-time card to pay in Egyptian pounds. The budget is checked first. With the manual issuer the owner creates a temporary wallet card and types it into a private page; you are told when it is ready. Call only once the checkout total is known.",
    parameters: Type.Object({
      amountEgp: Type.Number({ description: "Exact total in EGP including fees and delivery" }),
      merchantName: Type.String(),
      merchantUrl: Type.Optional(Type.String()),
      context: Type.String({ description: "What is being bought and why, in plain words" }),
    }),
    meta: { ...META, describe: (a: unknown) => `pay ${(a as { merchantName?: string })?.merchantName ?? "a merchant"} in EGP` },
    execute: async ({ amountEgp, merchantName, merchantUrl, context }, ctx) => {
      const piasters = toPiasters(amountEgp);
      if (piasters === undefined) return errorResult(`amountEgp must be between 0.01 and ${MAX_EGP}.`);
      const merchant = merchantName.trim();
      if (!merchant) return errorResult("merchantName is required.");
      const issuer = d.issuers.get(d.issuerId);
      if (!issuer) return errorResult("No card issuer is configured.");
      d.cards.sweep();
      const { request, token } = d.cards.create({
        piasters,
        merchant,
        ...(merchantUrl ? { merchantUrl } : {}),
        reason: context.trim().slice(0, 500),
        requestedBy: ctx.principal.id,
        conversationKey: ctx.conversationKey,
        issuerId: issuer.id,
      });
      const held = d.budget.reserve(request.id, piasters, merchant);
      if (!held.ok) {
        d.cards.finish(request.id, "failed");
        return errorResult(held.reason);
      }
      d.audit.append({ kind: "spend", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { requestId: request.id, amountPiasters: piasters, currency: "EGP", merchantName: merchant, via: issuer.id } });

      if (issuer.mode === "automatic") {
        try {
          const issued = await issuer.issue({ requestId: request.id, piasters, merchant, ttlMs: CARD_TTL_MS, idempotencyKey: request.id });
          d.cards.storeIssued(request.id, issued.card, issued.validUntil);
          return textResult(`Card ready for ${fmtEgp(piasters)} at ${merchant}. Call egp_card_pickup with id ${request.id}.`);
        } catch (err) {
          d.budget.release(request.id);
          d.cards.finish(request.id, "failed");
          return errorResult(`The card issuer failed: ${(err as Error).message}`);
        }
      }

      const url = `${d.publicUrl}/egp/card/${request.id}/${token}`;
      const text = issuer.ownerSteps(fmtEgp(piasters), merchant, url);
      const phone = d.config.owner.phones[0];
      if (phone) {
        await d.outbox.send({ channel: "imessage", to: phone, text }, { principal: ctx.principal, conversationKey: ctx.conversationKey });
        return textResult(`Request ${request.id} for ${fmtEgp(piasters)} at ${merchant}. The owner has the steps and a private link (30 minutes). Tell the requester you are waiting and end your turn. When the owner says the card is entered, call egp_card_pickup.`);
      }
      return textResult(`Request ${request.id} created. The owner has no phone on file; give them these steps in chat without the card:\n${text}`);
    },
  });
}

function pickupTool(d: EgpToolDeps): RegisteredTool {
  return defineTool({
    name: "egp_card_pickup",
    label: "Pick up the EGP card",
    description: "Get the one-time card details once, after the owner entered them. Type them into the checkout at once. Never repeat them in a message, memory or file.",
    parameters: Type.Object({ id: Type.String() }),
    meta: { ...META, describe: () => "pick up EGP card" },
    execute: async ({ id }, ctx) => {
      const got = d.cards.pickup(id);
      if ("error" in got) return errorResult(got.error);
      const { card, request } = got;
      d.audit.append({ kind: "spend", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { requestId: id, cardDelivered: true, currency: "EGP", via: request.issuerId } });
      const exp = `${String(card.expMonth).padStart(2, "0")}/${card.expYear}`;
      return textResult(`Card for ${fmtEgp(request.piasters)} at ${request.merchant} (shown once):\nNumber ${card.number}\nExpiry ${exp}\nCVV ${card.cvv}\nType it into the checkout now. Then call egp_card_done with the outcome.`);
    },
  });
}

function doneTool(d: EgpToolDeps): RegisteredTool {
  return defineTool({
    name: "egp_card_done",
    label: "Report the EGP payment outcome",
    description: "Tell the budget how the payment ended. paid counts the spend; failed or cancelled releases the hold.",
    parameters: Type.Object({
      id: Type.String(),
      outcome: Type.Union([Type.Literal("paid"), Type.Literal("failed"), Type.Literal("cancelled")]),
      finalAmountEgp: Type.Optional(Type.Number({ description: "The amount actually charged, if different" })),
    }),
    meta: { ...META, describe: () => "report EGP payment outcome" },
    execute: async ({ id, outcome, finalAmountEgp }, ctx) => {
      const r = d.cards.get(id);
      if (!r) return errorResult("Unknown card request.");
      if (outcome === "paid") {
        const fin = finalAmountEgp === undefined ? undefined : toPiasters(finalAmountEgp);
        if (finalAmountEgp !== undefined && fin === undefined) return errorResult("finalAmountEgp is not valid.");
        if (fin !== undefined && fin > r.piasters) return errorResult("The charge cannot exceed the approved amount.");
        d.budget.commit(id, fin);
        d.cards.finish(id, "done");
        d.audit.append({ kind: "spend", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { requestId: id, paidPiasters: fin ?? r.piasters, currency: "EGP", merchantName: r.merchant } });
        return textResult(`Recorded. ${fmtEgp(d.budget.available())} left in the budget.`);
      }
      d.budget.release(id);
      d.cards.finish(id, "failed");
      return textResult(`Released the hold. ${fmtEgp(d.budget.available())} left in the budget.`);
    },
  });
}
