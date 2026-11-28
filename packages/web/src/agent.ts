/** Talks to a person's own agent over its HTTP surface: GET /status and POST /chat, with the owner token. */
import dns from "node:dns/promises";
import net from "node:net";

export const AGENT_TOKEN_HEADER = "x-orion-token";

function privateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
}

export interface UrlCheck {
  ok: boolean;
  url?: string;
  error?: string;
}

/** The URL is typed by a user and then fetched by this server, so it must not reach private networks. */
export async function checkAgentUrl(input: string, allowPrivate: boolean, lookup: (h: string) => Promise<string[]> = async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address)): Promise<UrlCheck> {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, error: "Enter a full address such as https://my-agent.example.com" };
  }
  if (u.username || u.password) return { ok: false, error: "The address cannot contain a username or password." };
  if (!allowPrivate && u.protocol !== "https:") return { ok: false, error: "The address must start with https://" };
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "The address must start with https://" };
  if (!allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return { ok: false, error: "That address points to a private network." };
    let addrs: string[];
    try {
      addrs = net.isIP(host) ? [host] : await lookup(host);
    } catch {
      return { ok: false, error: "That address could not be found." };
    }
    if (addrs.length === 0 || addrs.some(privateAddress)) return { ok: false, error: "That address points to a private network." };
  }
  return { ok: true, url: u.origin + u.pathname.replace(/\/+$/, "") };
}

export interface AgentStatus {
  reachable: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

export class AgentClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 15000) {}

  private async call(base: string, path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: unknown }> {
    const res = await this.fetchImpl(base + path, {
      method: init.method ?? "GET",
      headers: { [AGENT_TOKEN_HEADER]: token, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "manual",
    });
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    return { status: res.status, json };
  }

  async status(base: string, token: string): Promise<AgentStatus> {
    try {
      const r = await this.call(base, "/status", token);
      if (r.status === 401 || r.status === 403) return { reachable: false, error: "The agent rejected the token." };
      if (r.status >= 400) return { reachable: false, error: `The agent answered with ${r.status}.` };
      return { reachable: true, data: r.json as Record<string, unknown> };
    } catch {
      return { reachable: false, error: "The agent did not answer." };
    }
  }

  async chat(base: string, token: string, message: string, conversationId = "web"): Promise<{ ok: boolean; reply: string }> {
    try {
      const r = await this.call(base, "/chat", token, { method: "POST", body: { message, source: "web", conversation_id: conversationId } });
      if (r.status >= 400) return { ok: false, reply: "The agent could not answer right now." };
      const reply = (r.json as { response?: unknown }).response;
      return { ok: true, reply: typeof reply === "string" && reply ? reply : "(no reply)" };
    } catch {
      return { ok: false, reply: "The agent did not answer." };
    }
  }

  /** Read-only owner state (GET /owner/<resource>). */
  async owner(base: string, token: string, resource: string, query = ""): Promise<{ ok: boolean; data?: any; error?: string }> {
    try {
      const r = await this.call(base, `/owner/${resource}${query}`, token);
      if (r.status === 404) return { ok: false, error: "Your assistant needs to be updated to show this page." };
      if (r.status === 401 || r.status === 403) return { ok: false, error: "The assistant rejected the token." };
      if (r.status >= 400) return { ok: false, error: `The assistant answered with ${r.status}.` };
      return { ok: true, data: r.json };
    } catch {
      return { ok: false, error: "The assistant did not answer." };
    }
  }

  /** Hand the agent a custom model config. The agent keeps it in its own state. */
  async pushModel(base: string, token: string, payload: unknown): Promise<boolean> {
    try {
      const r = await this.call(base, "/model", token, { method: "PUT", body: payload });
      return r.status < 300;
    } catch {
      return false;
    }
  }
}
