/**
 * Shareable interactive pages (E5): polls, sign-up lists and RSVPs the owner's agent makes and shares by link.
 * Served by the agent's own server. No scripts, no external assets; every value is escaped; sizes and response
 * counts are capped. The link is the capability (random id). Only the owner reads the full results.
 */
import crypto from "node:crypto";
import { Type } from "typebox";
import { defineTool, textResult } from "@open-instinct/core";
import type { Principal, RegisteredTool, StateDir, ToolResultLike } from "@open-instinct/core";

export const PAGES_PREFIX = "/p/";
const FILE = "pages.json";
const MAX_PAGES = 200;
const MAX_RESPONSES = 500;
const PER_CLIENT_PER_HOUR = 5;

export type PageKind = "poll" | "signup" | "rsvp";
export interface PageResponse {
  at: string;
  name?: string;
  choices?: string[];
  note?: string;
}
export interface Page {
  id: string;
  kind: PageKind;
  title: string;
  description?: string;
  options: string[];
  multi: boolean;
  lang: "ar" | "en";
  maxResponses: number;
  closed: boolean;
  createdAt: string;
  expiresAt: string;
  responses: PageResponse[];
}

type Store = Pick<StateDir, "readJson" | "writeJson">;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const fail = (text: string): ToolResultLike => ({ content: [{ type: "text", text }], isError: true });
const clip = (s: string | undefined, n: number) => (s ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n);

export class PageStore {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly state: Store, private readonly now: () => Date = () => new Date()) {}

  private all(): Page[] {
    const raw = this.state.readJson<{ pages?: Page[] }>(FILE, {});
    return Array.isArray(raw.pages) ? raw.pages : [];
  }
  private save(p: Page[]): void {
    this.state.writeJson(FILE, { version: 1, pages: p.slice(-MAX_PAGES) });
  }
  get(id: string): Page | undefined {
    return this.all().find((p) => p.id === id);
  }
  list(): Page[] {
    return this.all();
  }

  create(p: { kind: PageKind; title: string; description?: string; options?: string[]; multi?: boolean; lang?: "ar" | "en"; maxResponses?: number; days?: number }): Page | string {
    const title = clip(p.title, 120);
    if (!title) return "A page needs a title.";
    const options = (p.options ?? []).map((o) => clip(o, 80)).filter(Boolean);
    if (p.kind === "poll" && (options.length < 2 || options.length > 10)) return "A poll needs 2 to 10 options.";
    const days = Math.min(Math.max(Math.round(p.days ?? 14), 1), 90);
    const page: Page = {
      id: `pg_${crypto.randomBytes(9).toString("base64url")}`,
      kind: p.kind,
      title,
      ...(p.description ? { description: clip(p.description, 600) } : {}),
      options: p.kind === "poll" ? options : [],
      multi: Boolean(p.multi) && p.kind === "poll",
      lang: p.lang ?? "ar",
      maxResponses: Math.min(Math.max(Math.round(p.maxResponses ?? 200), 1), MAX_RESPONSES),
      closed: false,
      createdAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + days * 86_400_000).toISOString(),
      responses: [],
    };
    this.save([...this.all(), page]);
    return page;
  }

  isOpen(p: Page): boolean {
    return !p.closed && Date.parse(p.expiresAt) > this.now().getTime() && p.responses.length < p.maxResponses;
  }

  close(id: string): boolean {
    const all = this.all();
    const p = all.find((x) => x.id === id);
    if (!p) return false;
    p.closed = true;
    this.save(all);
    return true;
  }

  respond(id: string, r: { name?: string; choices?: string[]; note?: string }, client = "?"): string | undefined {
    const all = this.all();
    const p = all.find((x) => x.id === id);
    if (!p) return "not found";
    if (!this.isOpen(p)) return "closed";
    const t = this.now().getTime();
    const key = `${id}|${client}`;
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < 3_600_000);
    if (recent.length >= PER_CLIENT_PER_HOUR) return "too many";
    const name = clip(r.name, 60);
    if (p.kind !== "poll" && !name) return "name required";
    if (p.kind !== "poll" && p.responses.some((x) => x.name?.toLowerCase() === name.toLowerCase())) return "already in";
    let choices: string[] | undefined;
    if (p.kind === "poll") {
      choices = (r.choices ?? []).filter((c) => p.options.includes(c));
      if (choices.length === 0 || (!p.multi && choices.length > 1)) return "pick a valid option";
    }
    p.responses.push({ at: new Date(t).toISOString(), ...(name ? { name } : {}), ...(choices ? { choices } : {}), ...(r.note ? { note: clip(r.note, 300) } : {}) });
    recent.push(t);
    this.hits.set(key, recent);
    this.save(all);
    return undefined;
  }

  tally(p: Page): Array<{ option: string; votes: number }> {
    return p.options.map((option) => ({ option, votes: p.responses.filter((r) => r.choices?.includes(option)).length }));
  }
}

const TEXT = {
  ar: { send: "إرسال", name: "الاسم", note: "ملاحظة (اختياري)", thanks: "تم، شكرًا.", closed: "الصفحة دي اتقفلت.", full: "العدد اكتمل.", rsvp: "هاجي", count: "عدد الردود", bad: "في مشكلة في البيانات، جرّب تاني.", dup: "الاسم ده مسجّل قبل كده.", many: "محاولات كتير، جرّب بعد شوية." },
  en: { send: "Send", name: "Name", note: "Note (optional)", thanks: "Done, thank you.", closed: "This page is closed.", full: "This page is full.", rsvp: "I'm coming", count: "Responses", bad: "Something was wrong, try again.", dup: "That name is already in.", many: "Too many attempts, try later." },
} as const;

function shell(lang: "ar" | "en", title: string, body: string): string {
  const dir = lang === "ar" ? "rtl" : "ltr";
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:460px;margin:2rem auto;padding:0 1rem;line-height:1.7}label{display:block;margin:.4rem 0}input[type=text],button{width:100%;font-size:1.05rem;padding:.65rem;box-sizing:border-box;margin:.3rem 0}button{background:#0a7;color:#fff;border:0;border-radius:8px}.bar{background:#0a74;height:.7rem;border-radius:4px}</style></head><body>${body}</body></html>`;
}

export function handlePagesHttp(store: PageStore, method: string, path: string, body: string, client: string): { status: number; html: string } | undefined {
  if (!path.startsWith(PAGES_PREFIX)) return undefined;
  const m = /^\/p\/(pg_[A-Za-z0-9_-]{12})$/.exec(path);
  const page = m ? store.get(m[1] as string) : undefined;
  if (!page) return { status: 404, html: shell("en", "Not found", "<p>Not found.</p>") };
  const t = TEXT[page.lang];
  const head = `<h2>${esc(page.title)}</h2>${page.description ? `<p>${esc(page.description)}</p>` : ""}`;

  if (method === "POST") {
    const f = new URLSearchParams(body);
    const err = store.respond(page.id, { name: f.get("name") ?? "", choices: f.getAll("choice"), note: f.get("note") ?? "" }, client);
    const msg = err === undefined ? t.thanks : err === "closed" ? t.closed : err === "already in" ? t.dup : err === "too many" ? t.many : t.bad;
    const after = err === undefined && page.kind === "poll" ? results(store.get(page.id) as Page, t) : "";
    return { status: err === undefined ? 200 : err === "closed" ? 410 : 400, html: shell(page.lang, page.title, `${head}<p>${esc(msg)}</p>${after}`) };
  }
  if (!store.isOpen(page)) return { status: 410, html: shell(page.lang, page.title, `${head}<p>${page.responses.length >= page.maxResponses ? t.full : t.closed}</p>${page.kind === "poll" ? results(page, t) : ""}`) };
  let fields = "";
  if (page.kind === "poll") {
    const type = page.multi ? "checkbox" : "radio";
    fields = page.options.map((o) => `<label><input type="${type}" name="choice" value="${esc(o)}" ${page.multi ? "" : "required"}> ${esc(o)}</label>`).join("");
  } else {
    fields = `<input type="text" name="name" placeholder="${t.name}" maxlength="60" required>${page.kind === "rsvp" ? `<p>${t.rsvp}</p>` : ""}<input type="text" name="note" placeholder="${t.note}" maxlength="300">`;
  }
  return { status: 200, html: shell(page.lang, page.title, `${head}<form method="post" autocomplete="off">${fields}<button>${t.send}</button></form>`) };
}

function results(p: Page, t: (typeof TEXT)["ar" | "en"]): string {
  const rows = new PageStore({ readJson: (_n, f) => f, writeJson() {} }).tally(p);
  const total = Math.max(1, ...rows.map((r) => r.votes));
  return `<h3>${t.count}: ${p.responses.length}</h3>` + rows.map((r) => `<div>${esc(r.option)}: ${r.votes}<div class="bar" style="width:${Math.round((r.votes / total) * 100)}%"></div></div>`).join("");
}

export interface PagesRail {
  tools: RegisteredTool[];
  /** For the dashboard: no responses, only counts. */
  summary(): Array<{ id: string; kind: string; title: string; responses: number; open: boolean; expiresAt: string }>;
  handleHttp(method: string, path: string, body: string, client: string): { status: number; html: string } | undefined;
}

export function createPages(o: { state: StateDir; publicUrl: string; now?: () => Date }): PagesRail {
  const store = new PageStore(o.state, o.now);
  const base = o.publicUrl.replace(/\/+$/, "");
  const isOwner = (p: Principal) => p.kind === "owner";
  const meta = (cap: "files.write" | "files.read", what: string) => ({ capabilities: [cap], group: "apps" as const, describe: () => what });

  const create = defineTool({
    name: "page_create",
    label: "Create a shareable page",
    description: "Create a poll, a sign-up list or an RSVP page and get a public link to share. Owner only. Pages have no scripts and keep responses on the agent. Default language Arabic.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("poll"), Type.Literal("signup"), Type.Literal("rsvp")]),
      title: Type.String(),
      description: Type.Optional(Type.String()),
      options: Type.Optional(Type.Array(Type.String(), { description: "Poll options, 2 to 10" })),
      multi: Type.Optional(Type.Boolean({ description: "Poll: allow several choices" })),
      lang: Type.Optional(Type.Union([Type.Literal("ar"), Type.Literal("en")])),
      maxResponses: Type.Optional(Type.Number()),
      days: Type.Optional(Type.Number({ description: "Open for this many days (default 14)" })),
    }),
    meta: meta("files.write", "create a shareable page"),
    execute: async (a, ctx) => {
      if (!isOwner(ctx.principal)) return fail("Only the owner can create pages.");
      const page = store.create(a);
      if (typeof page === "string") return fail(page);
      return textResult(`Page ${page.id} created. Share this link: ${base}${PAGES_PREFIX}${page.id}\nOpen until ${page.expiresAt}, up to ${page.maxResponses} responses.`);
    },
  });
  const results_ = defineTool({
    name: "page_results",
    label: "Page results",
    description: "Read the responses to one of the owner's pages, or list the pages. Owner only.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    meta: meta("files.read", "read page results"),
    execute: async ({ id }, ctx) => {
      if (!isOwner(ctx.principal)) return fail("Only the owner can read results.");
      if (!id) return textResult(store.list().map((p) => `${p.id} ${p.kind} "${p.title}" ${p.responses.length} responses${store.isOpen(p) ? "" : " [closed]"}`).join("\n") || "No pages yet.");
      const p = store.get(id);
      if (!p) return fail("Unknown page.");
      const lines = p.kind === "poll" ? store.tally(p).map((r) => `${r.option}: ${r.votes}`) : p.responses.map((r) => `${r.name}${r.note ? ` (${r.note})` : ""}`);
      return textResult(`${p.title}: ${p.responses.length} responses${store.isOpen(p) ? "" : " [closed]"}\n${lines.join("\n")}`);
    },
  });
  const close = defineTool({
    name: "page_close",
    label: "Close a page",
    description: "Stop taking responses on a page. Owner only.",
    parameters: Type.Object({ id: Type.String() }),
    meta: meta("files.write", "close a page"),
    execute: async ({ id }, ctx) => (!isOwner(ctx.principal) ? fail("Only the owner can close pages.") : store.close(id) ? textResult("Closed.") : fail("Unknown page.")),
  });

  return { tools: [create, results_, close], summary: () => store.list().map((p) => ({ id: p.id, kind: p.kind, title: p.title, responses: p.responses.length, open: store.isOpen(p), expiresAt: p.expiresAt })), handleHttp: (m, p, b, c) => handlePagesHttp(store, m, p, b, c) };
}
