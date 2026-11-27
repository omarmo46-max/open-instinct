/**
 * Partner layer: the foundation for E1 (business-agent protocol) and E2 (domain connectors).
 *
 * E1 is the message shape ("OPP/1"): a typed request from the owner's agent to a business, and a typed answer.
 * E2 is the connector contract: one adapter per partner, registered per domain (health, restaurants, travel...).
 * No partner is connected today, so the registry is empty and the tools say so plainly and point to the fallback
 * (web or phone). When a partner signs up, its adapter is registered; nothing else in the agent changes.
 *
 * Committing intents (book, order, cancel) are two steps: the partner returns a proposal, the owner says yes,
 * then `partner_confirm` commits that exact proposal once. Money still moves only through the payment tools.
 */
import crypto from "node:crypto";
import { Type } from "typebox";
import type { AuditLog, InstinctConfig, Principal, RegisteredTool, StateDir, ToolResultLike } from "@open-instinct/core";
import { defineTool, textResult } from "./define.js";

export const PARTNER_PROTOCOL_VERSION = "OPP/1";
export const PARTNER_DOMAINS = ["health", "restaurants", "travel", "retail", "government", "utilities", "other"] as const;
export const PARTNER_INTENTS = ["info", "quote", "availability", "status", "book", "order", "cancel"] as const;
export const COMMITTING_INTENTS: readonly PartnerIntent[] = ["book", "order", "cancel"];
const PROPOSAL_TTL_MS = 30 * 60_000;
const PROPOSALS_FILE = "partner-proposals.json";

export type PartnerDomain = (typeof PARTNER_DOMAINS)[number];
export type PartnerIntent = (typeof PARTNER_INTENTS)[number];

export interface PartnerRequest {
  version: typeof PARTNER_PROTOCOL_VERSION;
  id: string;
  domain: PartnerDomain;
  intent: PartnerIntent;
  /** What it is about: a clinic visit, a table, a bill. Plain words. */
  subject: string;
  details: Record<string, string | number | boolean>;
  onBehalfOf: { name: string };
  /** Same key on a retry must never create a second booking. */
  idempotencyKey: string;
}

export interface PartnerProposal {
  id: string;
  summary: string;
  amount?: number;
  currency?: string;
  expiresAt?: string;
}

export interface PartnerResponse {
  requestId: string;
  status: "ok" | "needs_info" | "proposal" | "declined" | "error";
  message: string;
  missing?: string[];
  proposal?: PartnerProposal;
}

export interface PartnerConnector {
  id: string;
  label: string;
  domains: PartnerDomain[];
  intents: PartnerIntent[];
  handle(req: PartnerRequest): Promise<PartnerResponse>;
  /** Commit a proposal this connector made. Called only after the owner's yes. */
  confirm?(proposalId: string, idempotencyKey: string): Promise<PartnerResponse>;
}

export const FALLBACK: Record<PartnerDomain, string> = {
  health: "Find the clinic's booking page or phone number and use the web or phone tools; the owner approves each call.",
  restaurants: "Use the dining skill: web search the venue, then a phone call the owner approves.",
  travel: "Use the travel skill and the owner's approval before booking.",
  retail: "Use the purchases skill: compare on the web, pay through the payment tools.",
  government: "Look up the official service page and guide the owner through it; do not submit forms without the owner.",
  utilities: "Use the provider's official site or app steps; the owner approves any payment.",
  other: "Use web search and ask the owner what they prefer.",
};

export class PartnerRegistry {
  private readonly map = new Map<string, PartnerConnector>();
  register(c: PartnerConnector): void {
    if (this.map.has(c.id)) throw new Error(`partner "${c.id}" is already registered`);
    this.map.set(c.id, c);
  }
  get(id: string): PartnerConnector | undefined {
    return this.map.get(id);
  }
  list(): PartnerConnector[] {
    return [...this.map.values()];
  }
  forDomain(domain: PartnerDomain, intent: PartnerIntent): PartnerConnector[] {
    return this.list().filter((c) => c.domains.includes(domain) && c.intents.includes(intent));
  }
}

export function validateRequest(r: PartnerRequest): string | undefined {
  if (r.version !== PARTNER_PROTOCOL_VERSION) return "unsupported protocol version";
  if (!PARTNER_DOMAINS.includes(r.domain)) return "unknown domain";
  if (!PARTNER_INTENTS.includes(r.intent)) return "unknown intent";
  if (!r.subject.trim() || r.subject.length > 300) return "subject must be 1 to 300 characters";
  if (!r.idempotencyKey) return "idempotencyKey is required";
  if (JSON.stringify(r.details).length > 4000) return "details are too large";
  return undefined;
}

interface StoredProposal {
  proposalId: string;
  connectorId: string;
  requestId: string;
  summary: string;
  idempotencyKey: string;
  expiresAt: string;
  used: boolean;
}

export interface PartnerToolDeps {
  registry: PartnerRegistry;
  config: InstinctConfig;
  audit: Pick<AuditLog, "append">;
  state: Pick<StateDir, "readJson" | "writeJson">;
  now?: () => Date;
}

const fail = (text: string): ToolResultLike => ({ content: [{ type: "text", text }], isError: true });
const isOwner = (p: Principal) => p.kind === "owner";

export function partnerTools(d: PartnerToolDeps): RegisteredTool[] {
  const now = () => (d.now ?? (() => new Date()))();
  const readP = () => d.state.readJson<{ items?: StoredProposal[] }>(PROPOSALS_FILE, {}).items ?? [];
  const writeP = (items: StoredProposal[]) => d.state.writeJson(PROPOSALS_FILE, { version: 1, items: items.slice(-100) });

  const list = defineTool({
    name: "partner_list",
    label: "Connected partners",
    description: "List the business partners connected to this agent, by domain, and what each can do. Says when none is connected and what to use instead.",
    parameters: Type.Object({}),
    meta: { capabilities: ["apps.use"], group: "apps", describe: () => "list partners" },
    execute: async () => {
      const all = d.registry.list();
      if (all.length === 0) return textResult("No business partner is connected yet. Use the web and phone tools, with the owner's approval for calls and payments.");
      return textResult(all.map((c) => `${c.id} (${c.label}): ${c.domains.join(", ")}; can ${c.intents.join(", ")}`).join("\n"));
    },
  });

  const request = defineTool({
    name: "partner_request",
    label: "Ask a business partner",
    description:
      "Send a typed request (info, quote, availability, status, book, order, cancel) to a connected business partner for one domain. book, order and cancel never commit here: the partner returns a proposal, you show it to the owner, and after the owner's yes you call partner_confirm. With no partner connected it says what to do instead.",
    parameters: Type.Object({
      domain: Type.Union(PARTNER_DOMAINS.map((x) => Type.Literal(x)) as never),
      intent: Type.Union(PARTNER_INTENTS.map((x) => Type.Literal(x)) as never),
      subject: Type.String(),
      details: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
      partnerId: Type.Optional(Type.String({ description: "Pick one when several partners cover the domain" })),
    }),
    meta: { capabilities: ["apps.use"], group: "apps", describe: (a: unknown) => `partner ${(a as { intent?: string })?.intent ?? ""} ${(a as { domain?: string })?.domain ?? ""}` },
    execute: async (a: any, ctx) => {
      if (!isOwner(ctx.principal)) return fail("Only the owner can send business requests.");
      const req: PartnerRequest = {
        version: PARTNER_PROTOCOL_VERSION,
        id: `req_${crypto.randomBytes(6).toString("hex")}`,
        domain: a.domain,
        intent: a.intent,
        subject: String(a.subject ?? "").trim(),
        details: a.details ?? {},
        onBehalfOf: { name: d.config.owner.name },
        idempotencyKey: `idem_${crypto.randomBytes(8).toString("hex")}`,
      };
      const bad = validateRequest(req);
      if (bad) return fail(bad);
      const matches = d.registry.forDomain(req.domain, req.intent);
      const chosen = a.partnerId ? matches.find((c) => c.id === a.partnerId) : matches[0];
      if (!chosen) return textResult(`No connected partner handles ${req.intent} for ${req.domain}. ${FALLBACK[req.domain]}`);
      if (matches.length > 1 && !a.partnerId) return textResult(`Several partners fit: ${matches.map((c) => c.id).join(", ")}. Ask the owner which one, then call again with partnerId.`);
      let res: PartnerResponse;
      try {
        res = await chosen.handle(req);
      } catch (err) {
        return fail(`The partner did not answer: ${(err as Error).message}`);
      }
      d.audit.append({ kind: "outbound", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { via: "partner", partner: chosen.id, domain: req.domain, intent: req.intent, status: res.status } });
      if (res.status === "proposal" && res.proposal) {
        if (!COMMITTING_INTENTS.includes(req.intent)) return textResult(res.message);
        const items = readP().filter((p) => Date.parse(p.expiresAt) > now().getTime());
        const cap = now().getTime() + PROPOSAL_TTL_MS;
        const expires = Math.min(cap, res.proposal.expiresAt ? Date.parse(res.proposal.expiresAt) || cap : cap);
        items.push({ proposalId: res.proposal.id, connectorId: chosen.id, requestId: req.id, summary: res.proposal.summary, idempotencyKey: req.idempotencyKey, expiresAt: new Date(expires).toISOString(), used: false });
        writeP(items);
        const price = res.proposal.amount !== undefined ? ` Price: ${res.proposal.amount} ${res.proposal.currency ?? ""}.` : "";
        return textResult(`Proposal ${res.proposal.id} from ${chosen.label}: ${res.proposal.summary}.${price} Nothing is booked. Show this to the owner; only after a clear yes call partner_confirm with this id.`);
      }
      if (res.status === "needs_info") return textResult(`${res.message}${res.missing?.length ? ` Missing: ${res.missing.join(", ")}.` : ""}`);
      return res.status === "error" || res.status === "declined" ? fail(res.message) : textResult(res.message);
    },
  });

  const confirm = defineTool({
    name: "partner_confirm",
    label: "Confirm a partner proposal",
    description: "Commit one proposal the owner has just said yes to. Works once per proposal and only while it is fresh. Never call it without the owner's clear yes to this exact proposal. Payment still goes through the payment tools.",
    parameters: Type.Object({ proposalId: Type.String() }),
    meta: { capabilities: ["plans.commit"], group: "apps", describe: (a: unknown) => `confirm partner proposal ${(a as { proposalId?: string })?.proposalId ?? ""}` },
    execute: async ({ proposalId }, ctx) => {
      if (!isOwner(ctx.principal)) return fail("Only the owner can confirm.");
      const items = readP();
      const p = items.find((x) => x.proposalId === proposalId);
      if (!p || p.used) return fail("Unknown or already used proposal.");
      if (Date.parse(p.expiresAt) < now().getTime()) return fail("The proposal has expired. Ask the partner again.");
      const c = d.registry.get(p.connectorId);
      if (!c?.confirm) return fail("This partner cannot confirm proposals.");
      p.used = true;
      writeP(items);
      let res: PartnerResponse;
      try {
        res = await c.confirm(p.proposalId, p.idempotencyKey);
      } catch (err) {
        return fail(`The partner did not confirm: ${(err as Error).message}`);
      }
      d.audit.append({ kind: "outbound", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { via: "partner", partner: c.id, confirmed: proposalId, status: res.status } });
      return res.status === "ok" ? textResult(res.message) : fail(res.message);
    },
  });

  return [list, request, confirm];
}
