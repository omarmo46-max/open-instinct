/** The signed-in dashboard. Each section is its own page. */
import type { ModelConfig, User } from "./store.js";
import { esc, icon } from "./ui.js";

export interface AppCtx {
  brand: string;
  csrf: string;
  user: User;
  path: string;
  agentConnected: boolean;
}

export const PROVIDERS: Record<string, { label: string; needsBaseUrl?: boolean; sample: string }> = {
  anthropic: { label: "Anthropic", sample: "claude-sonnet-4-5" },
  openai: { label: "OpenAI", sample: "gpt-4.1" },
  google: { label: "Google Gemini", sample: "gemini-2.5-pro" },
  openrouter: { label: "OpenRouter", sample: "anthropic/claude-sonnet-4.5" },
  compatible: { label: "OpenAI-compatible endpoint", needsBaseUrl: true, sample: "model-name" },
};

const NAV: Array<{ group: string; items: Array<{ href: string; label: string; ic: string }> }> = [
  { group: "Workspace", items: [{ href: "/app", label: "Overview", ic: "home" }, { href: "/app/chat", label: "Chat", ic: "chat" }, { href: "/app/approvals", label: "Approvals", ic: "check" }, { href: "/app/activity", label: "Activity", ic: "clock" }] },
  { group: "Assistant", items: [{ href: "/app/apps", label: "Apps", ic: "apps" }, { href: "/app/channels", label: "Channels", ic: "phone" }, { href: "/app/people", label: "People", ic: "users" }, { href: "/app/schedules", label: "Schedules", ic: "clock" }, { href: "/app/memory", label: "Memory", ic: "data" }, { href: "/app/skills", label: "Skills", ic: "file" }, { href: "/app/pages", label: "Pages", ic: "globe" }] },
  { group: "Settings", items: [{ href: "/app/model", label: "AI model", ic: "cpu" }, { href: "/app/payments", label: "Payments", ic: "card" }, { href: "/app/security", label: "Security", ic: "shield" }, { href: "/app/connection", label: "Connection", ic: "link" }] },
  { group: "Account", items: [{ href: "/app/account", label: "Account", ic: "user" }, { href: "/app/data", label: "Data and privacy", ic: "lock" }] },
];

export function shell(c: AppCtx, title: string, desc: string, body: string, notice?: string): string {
  const side = NAV.map((g) => `<div class="grp">${g.group}</div>${g.items.map((i) => `<a href="${i.href}"${c.path === i.href ? ' class="on"' : ""}>${icon(i.ic, 18)}${i.label}</a>`).join("")}`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} | ${esc(c.brand)}</title><link rel="stylesheet" href="/assets/site.css"></head><body>
<div class="app"><aside class="side"><a class="brand" href="/">${esc(c.brand)}</a>${side}</aside>
<div class="main"><div class="top"><span class="muted small">Dashboard</span><div class="who"><span>${esc(c.user.email)}</span>
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(c.csrf)}"><button class="btn ghost sm" type="submit">Sign out</button></form></div></div>
<div class="content"><h1>${esc(title)}</h1><p class="desc">${esc(desc)}</p>${notice ? `<div class="alert info"><b>Assistant:</b> ${esc(notice)}</div>` : ""}${body}</div></div></div><script src="/assets/site.js" defer></script></body></html>`;
}

const alertBox = (kind: "err" | "ok" | "info", text?: string) => (text ? `<div class="alert ${kind}">${esc(text)}</div>` : "");
const hidden = (c: AppCtx) => `<input type="hidden" name="csrf" value="${esc(c.csrf)}">`;
export type Flash = { kind: "err" | "ok" | "info"; text: string } | undefined;
const flashBox = (f: Flash) => (f ? alertBox(f.kind, f.text) : "");

function modelTag(m?: ModelConfig): string {
  if (!m) return '<span class="tag gray">Default</span>';
  if (!m.enabled) return '<span class="tag gray">Off</span>';
  if (m.status === "failed") return '<span class="tag bad">Stopped</span>';
  if (m.status === "active") return '<span class="tag ok">Active</span>';
  return '<span class="tag warn">Not tested</span>';
}

export function overview(c: AppCtx, model: ModelConfig | undefined, status: { reachable: boolean; error?: string; data?: Record<string, unknown> } | undefined, counts?: Record<string, any>): string {
  const steps: Array<[boolean, string, string, string]> = [
    [c.agentConnected, "Connect your assistant", "Add its address and access token.", "/app/connection"],
    [Boolean(model), "Add your own AI model (optional)", "Use your API key instead of the default model.", "/app/model"],
    [Boolean(status?.reachable), "Send your first message", "Open the chat and ask for something.", "/app/chat"],
  ];
  const scalars = status?.data ? Object.entries(status.data).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 8) : [];
  return `<div class="stat">
<div class="s"><div class="l">Assistant</div><div class="v">${c.agentConnected ? (status?.reachable ? '<span class="tag ok">Online</span>' : '<span class="tag bad">Unreachable</span>') : '<span class="tag gray">Not connected</span>'}</div></div>
<div class="s"><div class="l">AI model</div><div class="v">${model ? `${esc(PROVIDERS[model.provider]?.label ?? model.provider)} ${modelTag(model)}` : modelTag()}</div></div>
<div class="s"><div class="l">Account</div><div class="v"><span class="tag ok">Verified</span></div></div></div>
${counts ? `<div class="stat"><a class="s" href="/app/approvals"><div class="l">Waiting for approval</div><div class="v">${esc(counts.pendingApprovals)}</div></a><a class="s" href="/app/people"><div class="l">People</div><div class="v">${esc(counts.people)}</div></a><a class="s" href="/app/schedules"><div class="l">Schedules</div><div class="v">${esc(counts.schedules)}</div></a><a class="s" href="/app/skills"><div class="l">Skills</div><div class="v">${esc(counts.skills)}</div></a><a class="s" href="/app/activity"><div class="l">Activity log</div><div class="v">${counts.auditChainOk ? '<span class="tag ok">Verified</span>' : '<span class="tag bad">Broken</span>'}</div></a></div>` : ""}
<div class="panel"><div class="ph"><h3>Getting started</h3></div><div class="pb">${steps.map(([done, h, p, href]) => `<div class="step" style="margin-bottom:18px"><span class="n" style="${done ? "" : "background:#fff;color:var(--muted);border:1px solid var(--line2)"}">${done ? "&#10003;" : ""}</span><div><h3>${h}</h3><p>${p} <a href="${href}">${done ? "Review" : "Open"}</a></p></div></div>`).join("")}</div></div>
${c.agentConnected ? `<div class="panel"><div class="ph"><h3>Assistant status</h3></div><div class="pb">${status?.reachable ? (scalars.length ? `<dl class="kv">${scalars.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : '<p class="muted">The assistant is online.</p>') : alertBox("err", status?.error ?? "The assistant did not answer.")}</div></div>` : ""}`;
}

export function chatPage(c: AppCtx): string {
  if (!c.agentConnected) return `<div class="alert info">Connect your assistant first. <a href="/app/connection">Open Connection</a></div>`;
  return `<div class="chat"><div class="log" id="chat-log"><div class="msg ag">Hi. Ask me for something.</div></div>
<form id="chat-form" data-csrf="${esc(c.csrf)}"><input type="text" name="message" placeholder="Message your assistant" autocomplete="off" maxlength="4000" required><button class="btn" type="submit">Send</button></form></div>
<p class="hint">This conversation is not saved in the dashboard. Your assistant keeps its own memory.</p>`;
}

export function modelPage(c: AppCtx, m: ModelConfig | undefined, flash: Flash): string {
  const opts = Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}"${m?.provider === k ? " selected" : ""}>${v.label}</option>`).join("");
  const status = m
    ? `<dl class="kv"><dt>Provider</dt><dd>${esc(PROVIDERS[m.provider]?.label ?? m.provider)}</dd><dt>Model</dt><dd>${esc(m.model)}</dd>${m.baseUrl ? `<dt>Endpoint</dt><dd>${esc(m.baseUrl)}</dd>` : ""}<dt>API key</dt><dd>&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull; ${esc(m.keyLast4)}</dd><dt>Status</dt><dd>${modelTag(m)}${m.lastError ? ` <span class="muted small">${esc(m.lastError)}</span>` : ""}</dd><dt>Updated</dt><dd>${esc(m.updatedAt.slice(0, 16).replace("T", " "))} UTC</dd></dl>
<div class="row" style="margin-top:22px"><form method="post" action="/app/model/test">${hidden(c)}<button class="btn ghost sm" type="submit">Test key</button></form>
<form method="post" action="/app/model/${m.enabled ? "disable" : "enable"}">${hidden(c)}<button class="btn ghost sm" type="submit">${m.enabled ? "Switch to default model" : "Use my model"}</button></form>
<form method="post" action="/app/model/remove">${hidden(c)}<button class="btn ghost sm" type="submit">Remove key</button></form></div>`
    : '<p class="muted">You are using the default model. Add your own key below to use your model instead.</p>';
  return `${flashBox(flash)}
<div class="panel"><div class="ph"><h3>Current model</h3>${modelTag(m)}</div><div class="pb">${status}</div></div>
<div class="panel"><div class="ph"><h3>${m ? "Replace" : "Add"} your model</h3></div><div class="pb">
<form method="post" action="/app/model" autocomplete="off">${hidden(c)}
<label for="provider">Provider</label><select id="provider" name="provider">${opts}</select>
<label for="model">Model name</label><input id="model" type="text" name="model" required maxlength="120" placeholder="e.g. claude-sonnet-4-5" value="${esc(m?.model ?? "")}">
<label for="baseUrl">Endpoint URL <span class="muted">(OpenAI-compatible only)</span></label><input id="baseUrl" type="url" name="baseUrl" placeholder="https://api.example.com/v1" value="${esc(m?.baseUrl ?? "")}">
<label for="apiKey">API key</label><input id="apiKey" type="password" name="apiKey" required autocomplete="off" maxlength="400">
<p class="hint">Your key is encrypted before it is stored and cannot be shown again.</p>
<div style="margin-top:22px"><button class="btn" type="submit">Save and test</button></div></form></div></div>
<div class="panel"><div class="ph"><h3>How it works</h3></div><div class="pb"><p>While your model works, your assistant uses it instead of the default one. If it stops, for example because the key is invalid or the quota is used up, the default model takes over automatically and your assistant tells you that your model stopped. Fix the key here and switch back whenever you like.</p></div></div>`;
}

export function connectionPage(c: AppCtx, user: User, flash: Flash, newSecret?: string, publicUrl?: string): string {
  const secretBox = newSecret
    ? `<div class="alert ok"><b>Callback secret (shown once)</b><br>Add these to your assistant's environment so it can report model problems here:<br><code>INSTINCT_WEB_URL=${esc(publicUrl ?? "")}</code><br><code>INSTINCT_WEB_SECRET=${esc(newSecret)}</code></div>`
    : "";
  return `${flashBox(flash)}${secretBox}
<div class="panel"><div class="ph"><h3>Your assistant</h3>${user.agentUrl ? '<span class="tag ok">Connected</span>' : '<span class="tag gray">Not connected</span>'}</div><div class="pb">
<form method="post" action="/app/connection" autocomplete="off">${hidden(c)}
<label for="url">Address</label><input id="url" type="url" name="url" required placeholder="https://your-assistant.example.com" value="${esc(user.agentUrl ?? "")}">
<label for="tok">Access token</label><input id="tok" type="password" name="token" ${user.agentUrl ? "" : "required"} autocomplete="off" placeholder="${user.agentUrl ? "Leave empty to keep the saved token" : ""}">
<p class="hint">This is the <code>INSTINCT_CHAT_TOKEN</code> of your assistant. It is encrypted before it is stored. The address must be public and use https.</p>
<div class="row" style="margin-top:22px"><button class="btn" type="submit">Save and check</button></div></form>
${user.agentUrl ? `<form method="post" action="/app/connection/disconnect" style="margin-top:14px">${hidden(c)}<button class="btn ghost sm" type="submit">Disconnect</button></form>` : ""}</div></div>`;
}

export function accountPage(c: AppCtx, flash: Flash): string {
  return `${flashBox(flash)}
<div class="panel"><div class="ph"><h3>Profile</h3></div><div class="pb"><form method="post" action="/app/account/profile">${hidden(c)}
<label for="n">Full name</label><input id="n" type="text" name="name" required maxlength="80" value="${esc(c.user.name)}">
<label>Email</label><input type="email" value="${esc(c.user.email)}" disabled><div style="margin-top:22px"><button class="btn" type="submit">Save</button></div></form></div></div>
<div class="panel"><div class="ph"><h3>Change password</h3></div><div class="pb"><form method="post" action="/app/account/password">${hidden(c)}
<label for="cp">Current password</label><input id="cp" type="password" name="current" required autocomplete="current-password">
<label for="np">New password</label><input id="np" type="password" name="password" required minlength="10" maxlength="200" autocomplete="new-password">
<p class="hint">Changing your password signs you out everywhere else.</p><div style="margin-top:22px"><button class="btn" type="submit">Update password</button></div></form></div></div>`;
}

export function dataPage(c: AppCtx, flash: Flash): string {
  return `${flashBox(flash)}
<div class="panel"><div class="ph"><h3>Export your data</h3></div><div class="pb"><p>Download your profile and settings as a JSON file. Secrets such as API keys are never included.</p><p style="margin-top:18px"><a class="btn ghost" href="/app/data/export">Download export</a></p></div></div>
<div class="panel"><div class="ph"><h3>Delete your account</h3></div><div class="pb"><p>This permanently deletes your account, your saved model key and your connection. It does not delete data held by your own assistant.</p>
<form method="post" action="/app/data/delete">${hidden(c)}<label for="dp">Your password</label><input id="dp" type="password" name="password" required autocomplete="current-password">
<label for="dc">Type DELETE to confirm</label><input id="dc" type="text" name="confirm" required autocomplete="off"><div style="margin-top:22px"><button class="btn danger" type="submit">Delete my account</button></div></form></div></div>`;
}
