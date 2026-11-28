/**
 * Concierge calls (E6): calls the owner pre-approved as a standing mandate, so each one does not need its own yes.
 *
 * The mandate is the approval. It names the exact numbers that may be called, what the calls may be for, the hours,
 * and daily caps. `concierge_call` refuses anything outside it. Changing the mandate goes through the always-ask
 * `phone.call` capability, so an injected instruction cannot widen it. Plain `phone_call` is untouched and still asks every time.
 */
import { Type } from "typebox";
import { defineTool, textResult } from "@orion-ai/core";
import type { AuditLog, InstinctConfig, Principal, RegisteredTool, StateDir, ToolResultLike } from "@orion-ai/core";
import { CALL_REASON_MAX, E164, VOICEMAIL_MESSAGE_MAX } from "./tools.js";
import type { CallOrigination, InkboxChannel } from "./channel.js";

function fail(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}

export const MANDATE_FILE = "concierge-mandate.json";
export const CALL_LOG_FILE = "concierge-calls.json";
const LOG_KEEP = 300;

export interface MandateNumber {
  number: string;
  label: string;
}

export interface Mandate {
  version: 1;
  enabled: boolean;
  numbers: MandateNumber[];
  /** Short purposes the calls may serve, such as "booking" or "reminder". A call must name one. */
  purposes: string[];
  maxCallsPerDay: number;
  maxCallsPerNumberPerDay: number;
  /** Local hours the calls may be placed, in the owner's timezone: start inclusive, end exclusive. */
  startHour: number;
  endHour: number;
  expiresAt?: string;
}

export interface CallLogEntry {
  at: string;
  day: string;
  number: string;
  purpose: string;
  callId?: string;
  status?: string;
}

export interface ConciergeDeps {
  channel: Pick<InkboxChannel, "placeCall">;
  config: InstinctConfig;
  audit: Pick<AuditLog, "append">;
  state: Pick<StateDir, "readJson" | "writeJson">;
  callOrigination?: CallOrigination;
  now?: () => Date;
}

const OFF: Mandate = { version: 1, enabled: false, numbers: [], purposes: [], maxCallsPerDay: 0, maxCallsPerNumberPerDay: 0, startHour: 9, endHour: 20 };
const isOwner = (p: Principal) => p.kind === "owner";
const clean = (n: string) => n.replace(/[\s()-]/g, "");

export function readMandate(state: Pick<StateDir, "readJson">): Mandate {
  const raw = state.readJson<Partial<Mandate>>(MANDATE_FILE, OFF);
  return { ...OFF, ...raw, version: 1, numbers: Array.isArray(raw.numbers) ? raw.numbers : [], purposes: Array.isArray(raw.purposes) ? raw.purposes : [] };
}

function localParts(d: Date, tz: string): { day: string; hour: number } {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(d)) % 24;
  return { day, hour };
}

export type MandateCheck = { ok: true } | { ok: false; reason: string };

/** Pure check: may this call go out now under this mandate? */
export function checkMandate(m: Mandate, log: CallLogEntry[], call: { number: string; purpose: string }, now: Date, tz: string): MandateCheck {
  if (!m.enabled) return { ok: false, reason: "No concierge mandate is active. The owner must set one first." };
  if (m.expiresAt && Date.parse(m.expiresAt) < now.getTime()) return { ok: false, reason: "The concierge mandate has expired." };
  if (!m.numbers.some((n) => n.number === call.number)) return { ok: false, reason: "That number is not on the owner's concierge list. Ask the owner to approve this call the normal way (phone_call)." };
  if (!m.purposes.includes(call.purpose)) return { ok: false, reason: `Purpose "${call.purpose}" is not in the mandate (allowed: ${m.purposes.join(", ") || "none"}).` };
  const { day, hour } = localParts(now, tz);
  if (hour < m.startHour || hour >= m.endHour) return { ok: false, reason: `Outside the allowed hours (${m.startHour}:00 to ${m.endHour}:00 owner time).` };
  const today = log.filter((l) => l.day === day);
  if (m.maxCallsPerDay > 0 && today.length >= m.maxCallsPerDay) return { ok: false, reason: `Daily limit of ${m.maxCallsPerDay} calls reached.` };
  if (m.maxCallsPerNumberPerDay > 0 && today.filter((l) => l.number === call.number).length >= m.maxCallsPerNumberPerDay) return { ok: false, reason: "Daily limit for this number reached." };
  return { ok: true };
}

export function conciergeTools(deps: ConciergeDeps): RegisteredTool[] {
  const now = () => (deps.now ?? (() => new Date()))();
  const tz = deps.config.owner.timezone;

  const setMandate = defineTool({
    name: "concierge_mandate_set",
    label: "Set concierge mandate",
    description:
      "Set the standing mandate for concierge calls: which numbers, what purposes, which hours, and daily limits. Owner only. Every change is held for the owner's own yes. Replaces the previous mandate.",
    parameters: Type.Object({
      enabled: Type.Boolean(),
      numbers: Type.Array(Type.Object({ number: Type.String({ description: "E.164, +20..." }), label: Type.String() }), { maxItems: 20 }),
      purposes: Type.Array(Type.String(), { maxItems: 10, description: 'Short words such as "booking", "reminder", "followup"' }),
      maxCallsPerDay: Type.Number(),
      maxCallsPerNumberPerDay: Type.Number(),
      startHour: Type.Number({ description: "0 to 23, owner time" }),
      endHour: Type.Number({ description: "1 to 24, owner time" }),
      expiresInDays: Type.Optional(Type.Number({ description: "Mandate ends after this many days. Default 30." })),
    }),
    meta: { capabilities: ["phone.call"], group: "messaging", describe: (a: unknown) => `change concierge mandate (${(a as { numbers?: unknown[] })?.numbers?.length ?? 0} numbers)` },
    execute: async (a, ctx) => {
      if (!isOwner(ctx.principal)) return fail("Only the owner can set the concierge mandate.");
      const numbers: MandateNumber[] = [];
      for (const n of a.numbers) {
        const num = clean(n.number);
        if (!E164.test(num)) return fail(`"${n.number}" is not a phone number in E.164 form.`);
        numbers.push({ number: num, label: n.label.trim().slice(0, 60) });
      }
      const ints = [a.maxCallsPerDay, a.maxCallsPerNumberPerDay, a.startHour, a.endHour];
      if (!ints.every((v) => Number.isInteger(v) && v >= 0) || a.startHour > 23 || a.endHour < 1 || a.endHour > 24 || a.startHour >= a.endHour) return fail("Check the limits and hours (start before end, whole numbers).");
      if (a.enabled && (numbers.length === 0 || a.purposes.length === 0 || a.maxCallsPerDay === 0)) return fail("An active mandate needs at least one number, one purpose and a daily limit above zero.");
      const days = a.expiresInDays === undefined ? 30 : Math.min(Math.max(Math.round(a.expiresInDays), 1), 365);
      const m: Mandate = {
        version: 1,
        enabled: a.enabled,
        numbers,
        purposes: a.purposes.map((p) => p.trim().toLowerCase()).filter(Boolean),
        maxCallsPerDay: a.maxCallsPerDay,
        maxCallsPerNumberPerDay: a.maxCallsPerNumberPerDay,
        startHour: a.startHour,
        endHour: a.endHour,
        expiresAt: new Date(now().getTime() + days * 86_400_000).toISOString(),
      };
      deps.state.writeJson(MANDATE_FILE, m);
      deps.audit.append({ kind: "security", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { event: "concierge_mandate_set", enabled: m.enabled, numbers: numbers.length, purposes: m.purposes, maxCallsPerDay: m.maxCallsPerDay, expiresAt: m.expiresAt } });
      return textResult(m.enabled ? `Mandate saved: ${numbers.length} number(s), purposes ${m.purposes.join(", ")}, up to ${m.maxCallsPerDay} calls a day, ${m.startHour}:00 to ${m.endHour}:00, until ${m.expiresAt}.` : "Mandate saved and switched off.");
    },
  });

  const status = defineTool({
    name: "concierge_mandate_status",
    label: "Concierge status",
    description: "Show the concierge mandate and today's calls. Owner only.",
    parameters: Type.Object({}),
    meta: { capabilities: ["phone.concierge"], group: "messaging", describe: () => "read concierge mandate" },
    execute: async (_a, ctx) => {
      if (!isOwner(ctx.principal)) return fail("Only the owner can see this.");
      const m = readMandate(deps.state);
      const { day } = localParts(now(), tz);
      const log = deps.state.readJson<{ calls?: CallLogEntry[] }>(CALL_LOG_FILE, {}).calls ?? [];
      const today = log.filter((l) => l.day === day);
      if (!m.enabled) return textResult("Concierge is off.");
      return textResult(`Concierge is on until ${m.expiresAt ?? "no end"}. Numbers: ${m.numbers.map((n) => `${n.label} ${n.number}`).join(", ")}. Purposes: ${m.purposes.join(", ")}. Hours ${m.startHour}:00 to ${m.endHour}:00. Today ${today.length} of ${m.maxCallsPerDay} calls.`);
    },
  });

  const call = defineTool({
    name: "concierge_call",
    label: "Concierge call",
    description:
      "Place a Voice AI call inside the owner's standing concierge mandate, with no per-call approval. Only for a number on the mandate list, for an allowed purpose, within the hours and daily limits. Anything else is refused: then use phone_call, which asks the owner. The outcome reaches the owner as a text when the call ends; do not report an outcome yourself.",
    parameters: Type.Object({
      toNumber: Type.String({ description: "E.164, must be on the mandate list" }),
      purpose: Type.String({ description: "One of the mandate's purposes" }),
      reason: Type.String({ description: "The brief Voice AI follows, second person, with every detail it needs" }),
      voicemailMessage: Type.Optional(Type.String()),
    }),
    meta: { capabilities: ["phone.concierge"], group: "messaging", describe: (a: unknown) => `concierge_call ${(a as { toNumber?: string })?.toNumber ?? ""}` },
    execute: async (a, ctx) => {
      if (!isOwner(ctx.principal)) return fail("Only the owner's own conversation can place concierge calls.");
      const number = clean(a.toNumber);
      if (!E164.test(number)) return fail(`"${a.toNumber}" is not in E.164 form.`);
      const reason = a.reason.trim();
      if (!reason || reason.length > CALL_REASON_MAX) return fail(`The brief must be 1 to ${CALL_REASON_MAX} characters.`);
      const vm = a.voicemailMessage?.trim();
      if (vm && vm.length > VOICEMAIL_MESSAGE_MAX) return fail(`The voicemail message must be under ${VOICEMAIL_MESSAGE_MAX} characters.`);
      const purpose = a.purpose.trim().toLowerCase();
      const t = now();
      const log = deps.state.readJson<{ calls?: CallLogEntry[] }>(CALL_LOG_FILE, {}).calls ?? [];
      const verdict = checkMandate(readMandate(deps.state), log, { number, purpose }, t, tz);
      if (!verdict.ok) return fail(verdict.reason);
      const placed = await deps.channel.placeCall({ toNumber: number, reason, ...(vm ? { voicemailMessage: vm } : {}), ...(deps.callOrigination ? { origination: deps.callOrigination } : {}) });
      const { day } = localParts(t, tz);
      const entry: CallLogEntry = { at: t.toISOString(), day, number, purpose, callId: placed.id, status: placed.status };
      deps.state.writeJson(CALL_LOG_FILE, { version: 1, calls: [...log, entry].slice(-LOG_KEEP) });
      deps.audit.append({ kind: "outbound", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { channel: "phone", via: "concierge", to: number, purpose, callId: placed.id } });
      return textResult(`Call ${placed.id}: ${placed.status}. Placed under the concierge mandate; the owner gets the result by text when it ends.`);
    },
  });

  return [setMandate, status, call];
}
