/**
 * Read-only owner API for the website dashboard: GET /owner/<resource>. It sits behind the same owner token as /chat.
 * It shows state; it never changes it. Every change goes through the assistant as a chat command, so approvals,
 * step-up codes and the permission policy apply exactly as they do in a text message.
 * Phone numbers and emails are masked. Secrets, tokens and card data are never included.
 */
import fs from "node:fs";
import path from "node:path";
import type { ApprovalStore, AuditLog, ContactStore, OrionConfig, MemoryStore, Scheduler } from "@orion-ai/core";
import { readMandate } from "@orion-ai/inkbox";

export interface OwnerApiDeps {
  config: OrionConfig;
  env: NodeJS.ProcessEnv;
  state: { readJson<T>(name: string, fallback: T): T; path(...p: string[]): string };
  contacts: ContactStore;
  approvals: ApprovalStore;
  audit: AuditLog;
  scheduler: Scheduler;
  memory: MemoryStore;
  apps?: { connectedToolkits(): Promise<unknown[]>; connectLink(toolkit: string): Promise<string | undefined>; toolkitSlugs: string[] } | undefined;
  wallet?: { isConnected(): boolean } | undefined;
  egpStatus?: (() => unknown) | undefined;
  pagesSummary?: (() => unknown[]) | undefined;
  keyring: { bundle(): { fingerprint: string }; peer(id: string): unknown };
  vaultConfigured: boolean;
  skillsDir?: string | undefined;
  channels: { inkboxHandle?: string | undefined; telegram: boolean; whatsapp: boolean };
  customModel?: { publicStatus(): unknown } | undefined;
}

const mask = (s: string) => (s.length <= 4 ? "••••" : `••••${s.slice(-4)}`);
const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, "$1•••$2");
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

function skills(dir: string | undefined): Array<{ name: string; description: string }> {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => {
        try {
          const text = fs.readFileSync(path.join(dir, d.name, "SKILL.md"), "utf8");
          const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
          const name = /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? d.name;
          const at = head.search(/^description:/m);
          const rest = at >= 0 ? head.slice(at + "description:".length) : "";
          const description = rest.split(/\n(?=[A-Za-z-]+:)/)[0]?.replace(/\s+/g, " ").trim() ?? "";
          return [{ name, description: clip(description, 400) }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export interface OwnerApi {
  handle(resource: string, query: URLSearchParams): Promise<{ status: number; body: unknown }>;
}

export function createOwnerApi(d: OwnerApiDeps): OwnerApi {
  const people = () =>
    d.contacts.all().map((c) => ({
      id: c.id,
      name: c.name,
      tier: c.tier,
      phones: c.phones.map(mask),
      emails: c.emails.map(maskEmail),
      telegram: (c.telegramIds?.length ?? 0) > 0,
      agentHandle: c.agentHandle ?? null,
      e2eePinned: c.agentHandle ? Boolean(d.keyring.peer(c.agentHandle.replace(/^@+/, ""))) : false,
      notes: clip(c.notes, 200),
      updatedAt: c.updatedAt,
    }));
  const approvals = () =>
    d.approvals.pending().map((a) => {
      const r = a as unknown as Record<string, unknown>;
      return { id: clip(r.token, 6), toolName: clip(r.toolName, 80), summary: clip(r.summary ?? r.description ?? r.title ?? "", 300), conversationKey: clip(r.conversationKey, 80), createdAt: r.createdAt, expiresAt: r.expiresAt };
    });
  const schedules = () => d.scheduler.list().map((s) => { const r = s as unknown as Record<string, unknown>; return { id: r.id, name: clip(r.name ?? r.id, 120), cron: r.cron ?? null, tz: r.tz ?? null, nextRunAt: r.nextRunAt ?? null, lastRunAt: r.lastRunAt ?? null, system: Boolean(r.system), prompt: clip(r.prompt, 240) }; });

  return {
    async handle(resource, query) {
      const ok = (body: unknown) => ({ status: 200, body });
      switch (resource) {
        case "overview": {
          const chain = d.audit.verify();
          return ok({ agent: d.config.agent.name, owner: d.config.owner.name, timezone: d.config.owner.timezone, people: d.contacts.all().length, pendingApprovals: d.approvals.pending().length, schedules: d.scheduler.list().length, skills: skills(d.skillsDir).length, auditChainOk: chain.ok, customModel: d.customModel?.publicStatus() ?? null });
        }
        case "people":
          return ok({ tiers: ["owner", "staff", "partner", "family", "friend", "contact", "stranger"], people: people() });
        case "approvals":
          return ok({ pending: approvals() });
        case "activity": {
          const limit = Math.min(Math.max(Number(query.get("limit") ?? 100) || 100, 1), 300);
          const entries = d.audit.read({ limit }).map((e) => ({ at: e.at, kind: e.kind, principal: (e as unknown as { principal?: string }).principal ?? null, tool: (e as unknown as { toolName?: string }).toolName ?? null, detail: clip(JSON.stringify((e as unknown as { detail?: unknown }).detail ?? ""), 240) }));
          return ok({ entries: entries.reverse(), chain: d.audit.verify() });
        }
        case "schedules":
          return ok({ schedules: schedules() });
        case "memory":
          return ok({ durable: clip(d.memory.readDurable(), 20000), preferences: clip(d.memory.preferencesDigest(), 4000) });
        case "skills":
          return ok({ skills: skills(d.skillsDir) });
        case "pages":
          return ok({ enabled: Boolean(d.pagesSummary), pages: d.pagesSummary?.() ?? [] });
        case "apps": {
          if (!d.apps) return ok({ configured: false, toolkits: [], available: [] });
          let toolkits: unknown[] = [];
          try {
            toolkits = await d.apps.connectedToolkits();
          } catch {}
          return ok({ configured: true, toolkits, available: d.apps.toolkitSlugs.slice(0, 200) });
        }
        case "apps/connect": {
          const toolkit = query.get("toolkit") ?? "";
          if (!d.apps || !/^[a-z0-9_-]{2,60}$/i.test(toolkit)) return { status: 400, body: { error: "bad request" } };
          const url = await d.apps.connectLink(toolkit);
          return url ? ok({ url }) : { status: 404, body: { error: "no link for that app" } };
        }
        case "channels":
          return ok({
            inkbox: d.channels.inkboxHandle ? { handle: d.channels.inkboxHandle, imessage: true, sms: true, email: true, voice: Boolean(d.env.INKBOX_VOICE ?? true) } : null,
            telegram: d.channels.telegram,
            whatsapp: d.channels.whatsapp,
            ownerPhones: d.config.owner.phones.map(mask),
            ownerEmails: d.config.owner.emails.map(maskEmail),
          });
        case "payments": {
          const mandate = readMandate(d.state as never);
          const spent = d.audit.spentTodayUsd(d.config.owner.timezone);
          return ok({
            link: { configured: Boolean(d.wallet), connected: d.wallet?.isConnected() ?? false },
            egp: d.egpStatus ? d.egpStatus() : null,
            spentTodayUsd: spent,
            concierge: { enabled: mandate.enabled, numbers: mandate.numbers.map((n) => ({ label: n.label, number: mask(n.number) })), purposes: mandate.purposes, maxCallsPerDay: mandate.maxCallsPerDay, maxCallsPerNumberPerDay: mandate.maxCallsPerNumberPerDay, startHour: mandate.startHour, endHour: mandate.endHour, expiresAt: mandate.expiresAt ?? null },
          });
        }
        case "security": {
          const chain = d.audit.verify();
          return ok({ auditChain: chain, vaultConfigured: d.vaultConfigured, e2eeFingerprint: d.keyring.bundle().fingerprint, a2aHandle: d.channels.inkboxHandle ?? null });
        }
        default:
          return { status: 404, body: { error: "unknown resource" } };
      }
    },
  };
}
