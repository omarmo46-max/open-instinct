/**
 * C2 action monitor. A second, separate judge that looks at each tool call after the policy and
 * before it runs, and answers allow, ask (the owner confirms) or block. It can only tighten what
 * the policy decided, never loosen it. It looks at what the call would DO, not at what the model
 * says about it: secrets in the arguments, a conversation that just handled an attack, a burst of
 * outward actions, stored credentials being used.
 */
import { findSecretRefs, refLabel } from "./secret-refs.js";
import type { ToolAssessInput, ToolAssessResult } from "./security-types.js";
import type { Capability } from "./types.js";

/** Calls that change something outside the agent or cannot be taken back. */
const RISKY: ReadonlySet<Capability> = new Set<Capability>(["email.send", "purchase", "travel.book", "computer.use", "files.write", "network.invite", "trust.manage", "schedule.manage", "phone.call", "calendar.write", "plans.commit", "memory.write", "apps.use"]);
/** Calls that put the model's words in front of someone else, or on the network. */
const OUTWARD: ReadonlySet<Capability> = new Set<Capability>(["email.send", "network.ask", "network.invite", "phone.call", "apps.use", "computer.use", "files.write", "owner.relay", "plans.propose", "plans.commit"]);

const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["an API key", /\bsk-[A-Za-z0-9_-]{20,}\b|\bAIza[0-9A-Za-z_-]{35}\b|\bAKIA[0-9A-Z]{16}\b/],
  ["a GitHub token", /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["a login token (JWT)", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["a bot token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
];

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** What kind of secret this text contains, if any. */
export function findSecretLike(text: string): string | undefined {
  for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) return label;
  for (const m of text.matchAll(/(?<![\d])(?:\d[ -]?){13,19}(?![\d])/g)) {
    if (luhnValid(m[0].replace(/[ -]/g, ""))) return "a card number";
  }
  return undefined;
}

export interface ActionMonitorOptions {
  /** Values of stored secrets (vault, 1Password leases). A call that would carry one is stopped. */
  secretValues?: () => string[];
  /** Most outward calls per conversation per minute. */
  maxOutwardPerMinute?: number;
  /** For strangers and groups the same rule is tighter. */
  maxOutwardPerMinuteStranger?: number;
  now?: () => Date;
}

const stringify = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
};

export class ActionMonitor {
  private readonly opts: ActionMonitorOptions;
  private readonly now: () => Date;
  private readonly outward = new Map<string, number[]>();

  constructor(opts: ActionMonitorOptions = {}) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  /** Count an outward call that actually ran. */
  noteRan(conversationKey: string, capabilities: Capability[]): void {
    if (!capabilities.some((c) => OUTWARD.has(c))) return;
    const t = this.now().getTime();
    const list = (this.outward.get(conversationKey) ?? []).filter((at) => at > t - 60_000);
    list.push(t);
    this.outward.set(conversationKey, list);
  }

  reset(conversationKey: string): void {
    this.outward.delete(conversationKey);
  }

  assess(input: ToolAssessInput, tainted: boolean): ToolAssessResult {
    const owner = input.principalKind === "owner";
    const refs = findSecretRefs(input.args);

    // Stored credentials: only the owner, only into a tool built to take them, and only with a yes.
    if (refs.length > 0) {
      if (!owner) return { action: "block", reason: "only the owner can use stored credentials" };
      if (!input.acceptsSecrets) return { action: "block", reason: `${input.tool} cannot be given stored credentials` };
      if (tainted) return { action: "block", reason: "this conversation just handled content that looked like an attack, so stored credentials are locked until the owner starts a new chat" };
      return { action: "ask", reason: "stored credential use", prompt: `use stored credential${refs.length > 1 ? "s" : ""} ${refs.map(refLabel).join(", ")} for: ${input.describe}` };
    }
    if (input.secretAccess) {
      if (!owner) return { action: "block", reason: "only the owner can read stored secrets" };
      if (tainted) return { action: "block", reason: "stored secrets are locked in a conversation that just handled content that looked like an attack" };
      return { action: "ask", reason: "reveals a stored secret", prompt: `reveal a stored secret: ${input.describe}` };
    }

    // A call that would carry a secret out, whatever the model was told.
    if (!input.acceptsSecrets) {
      const json = stringify(input.args);
      const known = (this.opts.secretValues?.() ?? []).find((v) => v.length >= 6 && json.includes(v));
      const looks = known ? "a stored secret" : findSecretLike(json);
      if (looks) {
        return owner
          ? { action: "ask", reason: `carries ${looks}`, prompt: `${input.describe} (this would send ${looks})` }
          : { action: "block", reason: `the call would send ${looks}` };
      }
    }

    const risky = input.capabilities.some((c) => RISKY.has(c));
    if (tainted && risky) {
      return owner
        ? { action: "ask", reason: "after a suspicious message", prompt: `${input.describe} (a message in this chat looked like an attack, so please confirm this is what you want)` }
        : { action: "block", reason: "this conversation just handled content that looked like an attack" };
    }

    if (input.capabilities.some((c) => OUTWARD.has(c))) {
      const t = this.now().getTime();
      const recent = (this.outward.get(input.conversationKey) ?? []).filter((at) => at > t - 60_000).length;
      const limit = owner ? (this.opts.maxOutwardPerMinute ?? 8) : (this.opts.maxOutwardPerMinuteStranger ?? 3);
      if (recent >= limit) return { action: "block", reason: `too many outward actions in a minute (${recent}); slow down and tell the owner` };
    }
    return { action: "allow" };
  }
}
