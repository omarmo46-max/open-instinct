/** The Phase C security layer: ties the firewall, action monitor, grounding checker, step-up and secret broker to the runtime's hooks. */
import { ActionMonitor } from "./action-monitor.js";
import { ContentFirewall, scanText, WARN_SCORE } from "./firewall.js";
import { GroundingChecker, type GroundingMode } from "./grounding.js";
import { findSecretRefs } from "./secret-refs.js";
import type { SecretBroker } from "./secrets-broker.js";
import type { FirewallFinding, InboundCheckInput, InboundDecision, SecurityHooks, ToolAssessInput, ToolAssessResult } from "./security-types.js";
import type { StepUp } from "./totp.js";
import type { Capability } from "./types.js";
import { hashArgs } from "./runtime.js";

const TAINT_MS = 30 * 60_000;

export interface SecurityLayerOptions {
  firewall?: ContentFirewall;
  monitor?: ActionMonitor;
  grounding?: GroundingChecker;
  groundingMode?: GroundingMode;
  stepUp?: StepUp;
  broker?: SecretBroker;
  /** Text the agent knows from memory, so facts it remembers are not flagged as made up. */
  memoryText?: () => string;
  /** Called when the firewall flags a message (for the audit log). */
  onFinding?: (conversationKey: string, decision: InboundDecision) => void;
  now?: () => Date;
}

export class SecurityLayer implements SecurityHooks {
  readonly firewall: ContentFirewall;
  readonly monitor: ActionMonitor;
  readonly grounding: GroundingChecker;
  private readonly o: SecurityLayerOptions;
  private readonly now: () => Date;
  private readonly taint = new Map<string, number>();

  constructor(o: SecurityLayerOptions = {}) {
    this.o = o;
    this.now = o.now ?? (() => new Date());
    this.firewall = o.firewall ?? new ContentFirewall();
    this.monitor = o.monitor ?? new ActionMonitor({ secretValues: () => o.broker?.knownValues() ?? [], now: this.now });
    this.grounding = o.grounding ?? new GroundingChecker();
  }

  /** True while a conversation is inside the window after a flagged message. */
  isTainted(conversationKey: string): boolean {
    const until = this.taint.get(conversationKey);
    if (until === undefined) return false;
    if (until <= this.now().getTime()) {
      this.taint.delete(conversationKey);
      return false;
    }
    return true;
  }

  inbound(input: InboundCheckInput): InboundDecision {
    const d = this.firewall.inspect(input);
    if (d.action !== "allow") {
      this.taint.set(input.conversationKey, this.now().getTime() + TAINT_MS);
      this.o.onFinding?.(input.conversationKey, d);
    }
    return d;
  }

  interceptCode(text: string): { handled: boolean; reply?: string } {
    const r = this.o.stepUp?.tryCode(text);
    return r ? { handled: r.handled, ...(r.reply ? { reply: r.reply } : {}) } : { handled: false };
  }

  startTurn(conversationKey: string): void {
    this.grounding.startTurn(conversationKey);
  }

  evidence(conversationKey: string, kind: "user" | "tool", text: string): void {
    this.grounding.add(conversationKey, kind === "tool" && this.o.broker ? this.o.broker.redact(text) : text);
  }

  assessTool(i: ToolAssessInput): ToolAssessResult {
    const stepUp = this.o.stepUp;
    const needsSecret = i.secretAccess || findSecretRefs(i.args).length > 0;
    if (needsSecret && i.principalKind === "owner" && stepUp?.enabled() && !stepUp.isElevated()) {
      if (stepUp.isLocked()) return { action: "block", reason: "step-up is locked after too many wrong codes; try again later" };
      stepUp.challenge();
      return { action: "block", reason: "a step-up code is needed first. Ask the owner to send the 6-digit code from their authenticator app as their next message, and tell them to ask again once it says Verified" };
    }
    return this.monitor.assess(i, this.isTainted(i.conversationKey));
  }

  inspectToolResult(conversationKey: string, _tool: string, text: string): FirewallFinding[] {
    if (text.length < 20) return [];
    const r = scanText(text);
    if (r.score < WARN_SCORE) return [];
    this.taint.set(conversationKey, this.now().getTime() + TAINT_MS);
    return r.findings;
  }

  grantSecrets(tool: string, args: unknown): void {
    if (this.o.broker && findSecretRefs(args).length > 0) this.o.broker.grant(hashArgs(args), tool);
  }

  toolRan(conversationKey: string, tool: string, capabilities: Capability[], ok: boolean): void {
    if (ok) this.monitor.noteRan(conversationKey, capabilities);
    this.grounding.toolRan(conversationKey, tool, capabilities, ok);
  }

  ground(conversationKey: string, reply: string): string {
    const mode = this.o.groundingMode ?? "note";
    if (mode === "off") return reply;
    return this.grounding.apply(conversationKey, reply, mode, [this.o.memoryText?.() ?? ""]).text;
  }

  reset(conversationKey: string): void {
    this.taint.delete(conversationKey);
    this.grounding.reset(conversationKey);
    this.monitor.reset(conversationKey);
  }
}
