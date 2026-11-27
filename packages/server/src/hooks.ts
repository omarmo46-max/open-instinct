/**
 * Runtime hooks the server hands to core. Core cannot import the network package
 * (it would be a cycle), so the server bridges the two: the OIP describer renders
 * a typed A2A data part for the model, and the prompt hook adds the network
 * guidance for the principal the agent is talking to.
 */
import type { Channel, Principal } from "@open-instinct/core";
import type { AgentKeyring } from "@open-instinct/core";
import { decodeE2ee, decodeOip, describeE2ee, describeOip, networkGuidance } from "@open-instinct/network";

/** One paragraph for a valid OIP/1 part; undefined for anything else so core falls back to JSON. */
export function describeDataPart(data: Record<string, unknown>): string | undefined {
  const oip = decodeOip(data);
  return oip ? describeOip(oip) : undefined;
}

/** Same, plus encrypted files and key exchange (C5): decrypts a verified file from a pinned peer into the workspace. */
export function makeDescribeDataPart(opts: { keyring?: AgentKeyring | undefined; workspace: string }): (data: Record<string, unknown>) => string | undefined {
  return (data) => {
    const e2ee = decodeE2ee(data);
    if (e2ee) return describeE2ee(e2ee, opts.keyring, opts.workspace);
    return describeDataPart(data);
  };
}

/** Extra system prompt sections for a principal. Only the network guidance for now. */
export function promptExtraFor(principal: Principal, _channel: Channel): string[] {
  return [networkGuidance(principal)];
}
