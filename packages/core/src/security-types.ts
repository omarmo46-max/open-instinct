/** The contract between the runtime and the security layer (Phase C). The runtime only knows this interface. */
import type { Capability } from "./types.js";

export interface InboundCheckInput {
  text: string;
  attachments?: Array<{ name?: string; mimeType?: string; url?: string; path?: string; size?: number }>;
  principalKind: string;
  conversationKey: string;
}

export interface FirewallFinding {
  rule: string;
  severity: "low" | "medium" | "high";
  /** A short, cleaned excerpt, never the whole message. */
  sample: string;
}

export interface InboundDecision {
  /** allow: nothing found. warn: handle as data and tighten tools. block: drop the message. */
  action: "allow" | "warn" | "block";
  /** The text to use from here on (invisible and direction-override characters removed for outsiders). */
  text: string;
  /** A line for the model when the message looks like an attack. */
  note?: string;
  findings: FirewallFinding[];
  score: number;
}

export interface ToolAssessInput {
  conversationKey: string;
  tool: string;
  args: unknown;
  capabilities: Capability[];
  principalKind: string;
  /** The tool returns or reveals a stored secret. */
  secretAccess: boolean;
  /** The tool may receive `{{secret:...}}` references and have them filled in at run time. */
  acceptsSecrets: boolean;
  describe: string;
}

export type ToolAssessResult = { action: "allow" } | { action: "ask"; prompt: string; reason: string } | { action: "block"; reason: string };

export interface SecurityHooks {
  /** C1: look at a message and its attachments before the model does. */
  inbound(input: InboundCheckInput): InboundDecision;
  /** C7: a one-time code from the owner settles a step-up challenge and never reaches the model. */
  interceptCode(text: string): { handled: boolean; reply?: string };
  /** Start of a model turn: forget which tools ran last turn. */
  startTurn(conversationKey: string): void;
  /** Text the model may legitimately repeat (what the user said, what tools returned). */
  evidence(conversationKey: string, kind: "user" | "tool", text: string): void;
  /** C2: judge a tool call after the policy said yes (or asked). */
  assessTool(input: ToolAssessInput): ToolAssessResult;
  /** Look at what a tool returned (a web page, an email) for hidden instructions. A flagged result taints the conversation, so risky tools need the owner's yes from then on. */
  inspectToolResult(conversationKey: string, tool: string, text: string): FirewallFinding[];
  /** The owner said yes to this exact call: let it fill in stored credentials once. */
  grantSecrets(tool: string, args: unknown): void;
  /** A tool finished. Feeds the claimed-action check and the rate limit. */
  toolRan(conversationKey: string, tool: string, capabilities: Capability[], ok: boolean): void;
  /** C3: check the final reply against what is actually known and what actually ran. */
  ground(conversationKey: string, reply: string): string;
  /** A new conversation: clear taint and evidence. */
  reset(conversationKey: string): void;
}
