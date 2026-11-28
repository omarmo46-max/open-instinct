/** Dashboard sections that show the assistant's own state. Reads come from GET /owner/*; every change is sent as a chat command. */
import { esc } from "./ui.js";

export interface SecCtx {
  csrf: string;
  path: string;
}
type Rec = Record<string, any>;

const hidden = (c: SecCtx) => `<input type="hidden" name="csrf" value="${esc(c.csrf)}">`;
export const BACK_PATHS = ["/app/apps", "/app/channels", "/app/people", "/app/approvals", "/app/payments", "/app/schedules", "/app/memory", "/app/pages", "/app/security", "/app/skills"];

/** A form that sends a command to the assistant, which applies it under the normal approval rules. */
export function act(c: SecCtx, message: string, label: string, o: { cls?: string; confirmText?: string } = {}): string {
  return `<form method="post" action="/app/act" class="inl">${hidden(c)}<input type="hidden" name="back" value="${esc(c.path)}"><input type="hidden" name="message" value="${esc(message)}"><button class="btn ${o.cls ?? "ghost"} sm" type="submit">${esc(label)}</button></form>`;
}

export const notConnected = `<div class="alert info">Connect your assistant first. <a href="/app/connection">Open Connection</a></div>`;
export const unavailable = (e: string) => `<div class="alert err">${esc(e)}</div>`;
const tag = (text: string, kind = "gray") => `<span class="tag ${kind}">${esc(text)}</span>`;
const panel = (title: string, body: string, right = "") => `<div class="panel"><div class="ph"><h3>${esc(title)}</h3>${right}</div><div class="pb">${body}</div></div>`;
const empty = (t: string) => `<p class="muted">${esc(t)}</p>`;
const table = (heads: string[], rows: string[][]) => (rows.length ? `<div class="tbl"><table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((x) => `<td>${x}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : "");
const when = (v: unknown) => (typeof v === "string" && v ? esc(v.replace("T", " ").slice(0, 16)) + " UTC" : "&ndash;");
const egp = (piasters: number) => `${(piasters / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP`;

export function appsPage(c: SecCtx, d: Rec): string {
  if (!d.configured) return panel("Connected apps", `<p>App connections are not set up on your assistant yet. Set <code>COMPOSIO_API_KEY</code> on it to connect Gmail, Calendar, GitHub, Notion, Slack and more.</p>`);
  const connected: Rec[] = Array.isArray(d.toolkits) ? d.toolkits : [];
  const slugOf = (t: Rec) => String(t.slug ?? t.toolkit ?? t.name ?? "").toLowerCase();
  const isOn = (t: Rec) => t.connected === true || t.status === "ACTIVE" || t.status === "connected";
  const have = new Set(connected.filter(isOn).map(slugOf));
  const rows = connected.filter(isOn).map((t) => [`<b>${esc(t.name ?? slugOf(t))}</b>`, tag("Connected", "ok"), act(c, `Disconnect my ${slugOf(t)} account.`, "Disconnect")]);
  const popular = ["gmail", "googlecalendar", "github", "notion", "slack", "linear", "hubspot", "googledrive", "outlook"];
  const avail: string[] = Array.isArray(d.available) ? d.available : [];
  const offer = [...popular.filter((p) => avail.includes(p)), ...avail.filter((a) => !popular.includes(a))].filter((a) => !have.has(a)).slice(0, 60);
  const grid = offer.map((slug) => `<form method="post" action="/app/apps/connect" class="chip">${hidden(c)}<input type="hidden" name="toolkit" value="${esc(slug)}"><button class="btn ghost sm" type="submit">${esc(slug)}</button></form>`).join("");
  return panel("Connected", rows.length ? table(["App", "Status", ""], rows) : empty("No apps connected yet.")) + panel("Connect an app", `<p class="muted" style="margin-bottom:14px">You sign in to each app on its own page. Your assistant never sees your password, and you can disconnect it at any time.</p><div class="chips">${grid || empty("No more apps are enabled on your assistant.")}</div>`);
}

export function channelsPage(_c: SecCtx, d: Rec): string {
  const card = (name: string, on: boolean, detail: string, how: string) => `<div class="card"><div class="row" style="justify-content:space-between"><h3>${esc(name)}</h3>${on ? tag("On", "ok") : tag("Off")}</div><p>${esc(detail)}</p>${on ? "" : `<p class="small muted" style="margin-top:10px">${how}</p>`}</div>`;
  const ink = d.inkbox as Rec | null;
  return `<div class="cols c2" style="margin-top:0">
${card("iMessage, SMS, email and calls", Boolean(ink), ink ? `Your assistant's handle is ${ink.handle}. Message it, email it or call it.` : "Reach it by iMessage, SMS, email and phone.", "Set <code>INKBOX_API_KEY</code> and <code>INKBOX_AGENT_HANDLE</code> on your assistant.")}
${card("Telegram", Boolean(d.telegram), "Message your assistant in Telegram.", "Set <code>TELEGRAM_BOT_TOKEN</code> on your assistant.")}
${card("WhatsApp", Boolean(d.whatsapp), "Message your assistant in WhatsApp.", "Turn on WhatsApp in your assistant's settings.")}
</div>${panel("Your contact details on file", `<dl class="kv"><dt>Phones</dt><dd>${esc((d.ownerPhones ?? []).join(", ") || "None")}</dd><dt>Emails</dt><dd>${esc((d.ownerEmails ?? []).join(", ") || "None")}</dd></dl>`)}`;
}

const TIER_HELP: Record<string, string> = { owner: "You. Full control.", staff: "People who work for you, with broad access.", partner: "Trusted partners, limited to shared tasks.", family: "Family members.", friend: "Friends. Can ask for simple things.", contact: "Known people with minimal access.", stranger: "Anyone else. Almost no access." };

export function peoplePage(c: SecCtx, d: Rec): string {
  const tiers: string[] = d.tiers ?? [];
  const rows = (d.people as Rec[]).map((p) => {
    const opts = tiers.filter((t) => t !== "owner").map((t) => `<option value="${t}"${p.tier === t ? " selected" : ""}>${t}</option>`).join("");
    const reach = [...(p.phones ?? []), ...(p.emails ?? []), p.telegram ? "Telegram" : ""].filter(Boolean).map(esc).join("<br>") || "&ndash;";
    const agent = p.agentHandle ? `${esc(p.agentHandle)} ${p.e2eePinned ? tag("Keys pinned", "ok") : tag("Keys not pinned")}` : "&ndash;";
    const change = `<form method="post" action="/app/act" class="inl">${hidden(c)}<input type="hidden" name="back" value="${esc(c.path)}"><input type="hidden" name="name" value="${esc(p.name)}"><select name="tier" aria-label="Trust level">${opts}</select><button class="btn ghost sm" type="submit" formaction="/app/people/tier">Change</button></form>`;
    return [`<b>${esc(p.name)}</b>${p.notes ? `<div class="small muted">${esc(p.notes)}</div>` : ""}`, tag(String(p.tier), p.tier === "stranger" ? "gray" : "") , reach, agent, change + act(c, `Remove ${p.name} from my contacts.`, "Remove")];
  });
  const add = `<form method="post" action="/app/people/add">${hidden(c)}<div class="row"><input type="text" name="name" placeholder="Name" required maxlength="80" style="flex:1;min-width:160px"><input type="text" name="contact" placeholder="Phone or email" required maxlength="120" style="flex:1;min-width:200px"><select name="tier">${tiers.filter((t) => t !== "owner").map((t) => `<option value="${t}"${t === "contact" ? " selected" : ""}>${t}</option>`).join("")}</select><button class="btn" type="submit">Add person</button></div></form>`;
  return panel("People", rows.length ? table(["Name", "Trust level", "Reach", "Assistant", ""], rows) : empty("No contacts yet. Add the people who may message your assistant.")) + panel("Add a person", add) + panel("Trust levels", `<dl class="kv">${tiers.map((t) => `<dt>${esc(t)}</dt><dd>${esc(TIER_HELP[t] ?? "")}</dd>`).join("")}</dl><p class="hint" style="margin-top:12px">Changes are sent to your assistant, which applies its normal permission and approval rules.</p>`);
}

export function approvalsPage(c: SecCtx, d: Rec): string {
  const rows = (d.pending as Rec[]).map((a) => [`<b>${esc(a.toolName)}</b>`, esc(a.summary || "&ndash;"), when(a.createdAt), when(a.expiresAt), act(c, `Approve the pending request: ${a.toolName}${a.summary ? ` (${a.summary})` : ""}.`, "Approve", { cls: "" }) + act(c, `Deny the pending request: ${a.toolName}${a.summary ? ` (${a.summary})` : ""}.`, "Deny")]);
  return panel("Waiting for you", rows.length ? table(["Action", "Details", "Asked", "Expires", ""], rows) : empty("Nothing is waiting for your approval.")) + `<p class="hint">Approving here sends your decision to your assistant. Some actions also ask for a verification code in your chat.</p>`;
}

export function activityPage(_c: SecCtx, d: Rec): string {
  const ch = d.chain as Rec;
  const status = ch?.ok ? tag("Log verified", "ok") : tag("Log chain broken", "bad");
  const rows = (d.entries as Rec[]).map((e) => [when(e.at), tag(String(e.kind)), esc(e.tool ?? e.principal ?? ""), `<span class="small muted">${esc(e.detail)}</span>`]);
  return panel("Recent activity", rows.length ? table(["When", "Type", "Who or what", "Details"], rows) : empty("No activity yet."), status) + `<p class="hint">${esc(String(ch?.entries ?? 0))} entries are chained so that any edit to the log can be detected.</p>`;
}

export function paymentsPage(c: SecCtx, d: Rec): string {
  const link = d.link as Rec;
  const e = d.egp as Rec | null;
  const m = d.concierge as Rec;
  const linkBox = panel("Card payments (US)", `<p>${link.configured ? (link.connected ? tag("Connected", "ok") : tag("Not connected", "warn")) : tag("Off")}</p><p class="muted" style="margin-top:8px">One-time cards for each purchase, paid from your own account. Spent today: $${Number(d.spentTodayUsd ?? 0).toFixed(2)}.</p>`);
  const egpBox = panel("Egyptian pound budget", e
    ? `<dl class="kv"><dt>Status</dt><dd>${e.enabled ? tag("On", "ok") : tag("Off")}</dd><dt>Budget</dt><dd>${egp(e.poolPiasters)}</dd><dt>Available</dt><dd>${egp(e.availablePiasters)}</dd><dt>Used today</dt><dd>${egp(e.usedTodayPiasters)}${e.dailyPiasters ? ` of ${egp(e.dailyPiasters)}` : ""}</dd><dt>Per purchase</dt><dd>${e.perPurchasePiasters ? egp(e.perPurchasePiasters) : "No cap"}</dd></dl>${(e.open as Rec[]).length ? table(["Request", "Amount", "Store", "State"], (e.open as Rec[]).map((r) => [esc(r.id), egp(r.piasters), esc(r.merchant), tag(String(r.status))])) : ""}
<form method="post" action="/app/payments/egp" style="margin-top:20px">${hidden(c)}<div class="row"><input type="number" name="budget" min="0" max="100000" step="1" placeholder="Budget (EGP)" required><input type="number" name="perPurchase" min="0" step="1" placeholder="Per purchase" required><input type="number" name="daily" min="0" step="1" placeholder="Per day" required><button class="btn" type="submit">Save budget</button></div><p class="hint">Keep your wallet balance at or above the budget. 0 means no cap. For each purchase you create a one-time card yourself and enter it on a private page.</p></form>`
    : `<p class="muted">The Egyptian pound rail is off on your assistant. Set <code>EGP_WALLET=1</code> to turn it on.</p>`);
  const callBox = panel("Concierge calls", m.enabled
    ? `<dl class="kv"><dt>Numbers</dt><dd>${(m.numbers as Rec[]).map((n) => `${esc(n.label)} ${esc(n.number)}`).join("<br>") || "None"}</dd><dt>Purposes</dt><dd>${esc((m.purposes as string[]).join(", "))}</dd><dt>Hours</dt><dd>${m.startHour}:00 to ${m.endHour}:00</dd><dt>Limits</dt><dd>${m.maxCallsPerDay} a day, ${m.maxCallsPerNumberPerDay} per number</dd><dt>Ends</dt><dd>${when(m.expiresAt)}</dd></dl><p style="margin-top:16px">${act(c, "Switch off my concierge call mandate.", "Switch off")}</p>`
    : `<p class="muted">No standing mandate. Each call asks for your approval.</p>`);
  return linkBox + egpBox + callBox;
}

export function schedulesPage(c: SecCtx, d: Rec): string {
  const rows = (d.schedules as Rec[]).map((s) => [`<b>${esc(s.name)}</b><div class="small muted">${esc(s.prompt)}</div>`, esc(s.cron ?? "One time"), esc(s.tz ?? ""), when(s.nextRunAt), s.system ? tag("Built in") : act(c, `Delete the schedule named "${s.name}".`, "Delete")]);
  return panel("Reminders and routines", rows.length ? table(["Name", "When", "Time zone", "Next run", ""], rows) : empty("No schedules yet."));
}

export function memoryPage(c: SecCtx, d: Rec): string {
  return panel("What your assistant remembers", d.durable ? `<pre class="pre">${esc(d.durable)}</pre>` : empty("Nothing saved yet.")) + panel("Preferences", d.preferences ? `<pre class="pre">${esc(d.preferences)}</pre>` : empty("No preferences saved yet."));
}

export function skillsPage(_c: SecCtx, d: Rec): string {
  const rows = (d.skills as Rec[]).map((s) => [`<b>${esc(s.name)}</b>`, esc(s.description)]);
  return panel("Skills", rows.length ? table(["Skill", "What it does"], rows) : empty("No skills are installed.")) + `<p class="hint">Skills are playbooks your assistant follows for jobs like booking, travel, purchases and claims.</p>`;
}

export function pagesPage(c: SecCtx, d: Rec): string {
  if (!d.enabled) return panel("Shareable pages", `<p>Polls, sign-ups and RSVPs are off on your assistant. Set <code>ORION_PAGES=1</code> to turn them on.</p>`);
  const rows = (d.pages as Rec[]).map((p) => [`<b>${esc(p.title)}</b>`, tag(String(p.kind)), String(p.responses), p.open ? tag("Open", "ok") : tag("Closed"), when(p.expiresAt), p.open ? act(c, `Close the page "${p.title}".`, "Close") : ""]);
  return panel("Your pages", rows.length ? table(["Title", "Type", "Responses", "State", "Ends", ""], rows) : empty("No pages yet."));
}

export function securityPage(_c: SecCtx, d: Rec): string {
  const ch = d.auditChain as Rec;
  return panel("Protection status", `<dl class="kv"><dt>Activity log</dt><dd>${ch.ok ? tag("Verified", "ok") : tag("Chain broken", "bad")} ${esc(String(ch.entries))} entries</dd><dt>Encrypted vault</dt><dd>${d.vaultConfigured ? tag("On", "ok") : tag("Off")}</dd><dt>Encryption fingerprint</dt><dd><code>${esc(d.e2eeFingerprint)}</code></dd><dt>Assistant handle</dt><dd>${esc(d.a2aHandle ?? "Not set")}</dd></dl>`) +
    panel("How you are protected", `<dl class="kv"><dt>Approvals</dt><dd>Payments, calls and other sensitive steps wait for your yes.</dd><dt>Trust levels</dt><dd>Seven levels decide who can ask for what.</dd><dt>Encrypted files</dt><dd>Files between assistants are encrypted end to end and signed by pinned keys.</dd><dt>Log</dt><dd>Every action is written to a chained log you can verify.</dd></dl>`);
}
