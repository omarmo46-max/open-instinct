/** Public pages. Every page is its own route; the sign-in dialog is available on all of them. */
import { esc, icon } from "./ui.js";

export interface PageCtx {
  brand: string;
  csrf: string;
  signedIn: boolean;
  path: string;
}

const NAV: Array<[string, string]> = [["/features", "Features"], ["/security", "Security"], ["/pricing", "Pricing"], ["/faq", "FAQ"]];

function authForms(c: PageCtx, o: { error?: string; email?: string } = {}, active: "signup" | "login" = "signup"): string {
  const err = o.error ? `<div class="alert err">${esc(o.error)}</div>` : "";
  const email = o.email ? ` value="${esc(o.email)}"` : "";
  return `
  <div class="pane" data-pane="signup"${active === "signup" ? "" : " hidden"}>${active === "signup" ? err : ""}
    <form method="post" action="/signup" autocomplete="on">
      <input type="hidden" name="csrf" value="${esc(c.csrf)}">
      <label for="s-name">Full name</label><input id="s-name" type="text" name="name" autocomplete="name" required maxlength="80">
      <label for="s-email">Work or personal email</label><input id="s-email" type="email" name="email" autocomplete="email" required maxlength="200"${email}>
      <label for="s-pass">Password</label><input id="s-pass" type="password" name="password" autocomplete="new-password" required minlength="10" maxlength="200">
      <p class="hint">At least 10 characters. We email a 6-digit code to confirm your address.</p>
      <button class="btn" type="submit">Create account</button>
      <p class="hint" style="margin-top:14px">By creating an account you agree to the <a href="/terms">Terms</a> and the <a href="/privacy">Privacy Policy</a>.</p>
    </form></div>
  <div class="pane" data-pane="login"${active === "login" ? "" : " hidden"}>${active === "login" ? err : ""}
    <form method="post" action="/login" autocomplete="on">
      <input type="hidden" name="csrf" value="${esc(c.csrf)}">
      <label for="l-email">Email</label><input id="l-email" type="email" name="email" autocomplete="email" required${email}>
      <label for="l-pass">Password</label><input id="l-pass" type="password" name="password" autocomplete="current-password" required>
      <p class="hint"><a href="/forgot">Forgot your password?</a></p>
      <button class="btn" type="submit">Sign in</button>
    </form></div>`;
}

export function layout(c: PageCtx, o: { title: string; desc?: string; body: string }): string {
  const nav = NAV.map(([h, t]) => `<a href="${h}"${c.path === h ? ' class="on"' : ""}>${t}</a>`).join("");
  const left = c.signedIn
    ? `<a class="btn sm" href="/app">Open dashboard</a>`
    : `<a class="btn sm" href="/signup" data-auth="signup">Sign up now</a><a class="link" href="/login" data-auth="login">Log in</a>`;
  const dialog = c.signedIn
    ? ""
    : `<dialog id="auth-dialog"><div class="dlg"><button class="x" data-close aria-label="Close">&times;</button>
      <div class="tabs"><button type="button" data-tab="signup" class="on">Create account</button><button type="button" data-tab="login">Sign in</button></div>${authForms(c)}</div></dialog>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} | ${esc(c.brand)}</title><meta name="description" content="${esc(o.desc ?? "A personal assistant you text or call, on your own terms.")}">
<link rel="stylesheet" href="/assets/site.css"></head><body>
<header class="hdr"><div class="wrap"><div class="left">${left}</div><a class="brand" href="/">${esc(c.brand)}</a><div class="right"><nav class="nav">${nav}</nav></div></div></header>
<main>${o.body}</main>
<footer class="ftr"><div class="wrap"><div class="grid">
<div><a class="brand" href="/">${esc(c.brand)}</a><p class="small muted" style="margin-top:10px;max-width:280px">A personal assistant you text or call. It works through your apps, with your approval.</p></div>
<div><h4>Product</h4><a href="/features">Features</a><a href="/how-it-works">How it works</a><a href="/pricing">Pricing</a></div>
<div><h4>Trust</h4><a href="/security">Security</a><a href="/faq">FAQ</a></div>
<div><h4>Legal</h4><a href="/terms">Terms of Service</a><a href="/privacy">Privacy Policy</a></div>
</div><div class="base"><span>&copy; ${new Date().getFullYear()} ${esc(c.brand)}</span><span>All rights reserved.</span></div></div></footer>
${dialog}<script src="/assets/site.js" defer></script></body></html>`;
}

export function authPage(c: PageCtx, mode: "login" | "signup", o: { error?: string; email?: string } = {}): string {
  const login = mode === "login";
  const form = authForms(c, o, mode);
  return layout(c, {
    title: login ? "Sign in" : "Create your account",
    body: `<div class="wrap"><div class="authbox"><h1>${login ? "Welcome back" : "Create your account"}</h1><p class="muted">${login ? "Sign in to your dashboard." : "Set up your assistant in a few minutes."}</p><div style="margin-top:18px">${form}</div>
    <p class="alt">${login ? 'New here? <a href="/signup">Create an account</a>' : 'Already have an account? <a href="/login">Sign in</a>'}</p></div></div>`,
  });
}

export function messagePage(c: PageCtx, title: string, text: string, action?: { href: string; label: string }): string {
  return layout(c, { title, body: `<div class="wrap"><div class="authbox"><h1>${esc(title)}</h1><p class="muted" style="margin-top:8px">${esc(text)}</p>${action ? `<a class="btn" href="${esc(action.href)}">${esc(action.label)}</a>` : ""}</div></div>` });
}

const card = (ic: string, h: string, p: string) => `<div class="card"><span class="ico">${icon(ic)}</span><h3>${h}</h3><p>${p}</p></div>`;

export function home(c: PageCtx): string {
  return layout(c, {
    title: "Your personal assistant, one message away",
    body: `
<section class="hero"><div class="wrap grid"><div>
  <div class="eyebrow">Personal assistant</div>
  <h1>Text it. It gets things done.</h1>
  <p class="lead">${esc(c.brand)} is an assistant you reach by message or phone call. It reads your email, manages your calendar, books, searches the web and follows up, and it asks before anything sensitive.</p>
  <div class="cta"><a class="btn lg" href="/signup" data-auth="signup">Sign up now</a><a class="btn lg ghost" href="/how-it-works">See how it works</a></div>
  <p class="small muted" style="margin-top:18px">Works over iMessage, SMS, email, Telegram, WhatsApp and the web.</p>
</div>
<div class="phone" aria-label="Example conversation"><div class="bar"><span class="dot"></span>Your assistant<span class="tag gray" style="margin-left:auto">Example</span></div>
  <div class="msg me">Move my dentist appointment to next week and tell Sam I'm running late Friday.</div>
  <div class="msg ag">I found two openings: Tue 10:30 or Thu 15:00. Which do you prefer?</div>
  <div class="msg me">Thursday.</div>
  <div class="msg ag">Booked for Thursday at 15:00 and your calendar is updated. I texted Sam.</div></div></div></section>

<section class="sec"><div class="wrap"><h2>Everything you would hand to a human assistant</h2>
<p class="sub">Connect the tools you already use. The assistant works inside them, with limits you set.</p>
<div class="cols c3">
${card("chat", "Talk the way you already do", "Message it on iMessage, SMS, Telegram or WhatsApp, email it or call it.")}
${card("apps", "Works across your apps", "Gmail, Calendar, GitHub, Notion, Slack and hundreds more. You connect each one and can disconnect it at any time.")}
${card("phone", "Makes calls for you", "It can phone a restaurant or a clinic and report back. Each call needs your approval, or you can pre-approve specific numbers.")}
${card("card", "Pays within limits", "One-time cards with a budget you control, so a purchase never exceeds what you allowed.")}
${card("globe", "Uses the web and a computer", "It searches, reads pages and fills forms in a real browser when a task needs it.")}
${card("clock", "Remembers and follows up", "It keeps context, sets reminders, runs scheduled tasks and sends you a daily summary.")}
</div><p style="margin-top:28px"><a href="/features">Explore all features &rarr;</a></p></div></section>

<section class="sec soft"><div class="wrap"><h2>Up and running in three steps</h2>
<div class="cols c3">
<div class="step"><span class="n">1</span><div><h3>Create your account</h3><p>Sign up with your email and confirm it with a 6-digit code.</p></div></div>
<div class="step"><span class="n">2</span><div><h3>Connect your assistant</h3><p>Link your channels and apps from the dashboard. Add your own AI model key if you prefer.</p></div></div>
<div class="step"><span class="n">3</span><div><h3>Send your first message</h3><p>Ask for something in plain words. It asks before anything sensitive.</p></div></div>
</div><p style="margin-top:28px"><a href="/how-it-works">Read the full walkthrough &rarr;</a></p></div></section>

<section class="sec"><div class="wrap"><div class="cols c2" style="margin-top:0;align-items:center"><div><div class="eyebrow">Security</div><h2>You stay in control</h2>
<p class="sub">Sensitive actions wait for your approval. Permissions are explicit, secrets are encrypted, and every action is recorded so you can review it.</p><p style="margin-top:22px"><a class="btn ghost" href="/security">How we protect you</a></p></div>
<div class="card"><ul style="list-style:none;margin:0;padding:0">${["Approval before payments, calls and sensitive actions", "Seven trust levels for the people who can message it", "Encrypted vault for logins and cards", "Verification codes for high-risk steps", "An activity log you can review"].map((t) => `<li style="display:flex;gap:12px;padding:9px 0">${icon("check")}<span>${t}</span></li>`).join("")}</ul></div></div></div></section>

<section class="band"><div class="wrap"><h2>Ready to hand off the small stuff?</h2><p>Create an account and connect your first channel in minutes.</p><a class="btn" href="/signup" data-auth="signup">Sign up now</a></div></section>`,
  });
}

const FEATURES: Array<{ id: string; ic: string; h: string; p: string; items: string[] }> = [
  { id: "channels", ic: "chat", h: "Channels", p: "Reach your assistant where you already are.", items: ["iMessage, SMS, email and phone calls", "Telegram and WhatsApp", "Several people can reach it, each with their own permissions"] },
  { id: "apps", ic: "apps", h: "Connected apps", p: "It acts inside the tools you use.", items: ["Gmail, Google Calendar, GitHub, Notion, Slack and many more", "You sign in to each app yourself; the assistant never sees your password", "Disconnect any app whenever you like", "Its own email address for tasks that need one"] },
  { id: "calls", ic: "phone", h: "Phone calls", p: "Let it make the calls you do not want to make.", items: ["A voice assistant phones a business and reports back", "Each call asks for your approval", "Or pre-approve exact numbers, purposes and hours with a standing mandate", "A summary arrives when the call ends"] },
  { id: "payments", ic: "card", h: "Payments", p: "Buy things without handing over your card.", items: ["One-time cards for each purchase", "A budget with per-purchase and daily limits", "You approve what goes beyond your rules", "Available methods depend on your country"] },
  { id: "web", ic: "globe", h: "Web and computer use", p: "It can do the clicking.", items: ["Searches the web and reads pages", "Fills forms and completes tasks in a real browser", "Builds and publishes simple pages and polls you can share"] },
  { id: "people", ic: "users", h: "People and permissions", p: "Decide who can ask for what.", items: ["Seven trust levels, from owner to stranger", "Temporary permissions that expire", "Your assistant can coordinate with other people's assistants", "Encrypted file sharing between assistants"] },
  { id: "memory", ic: "clock", h: "Memory and routines", p: "It remembers and follows through.", items: ["Remembers preferences and context", "Reminders and scheduled tasks", "A daily summary of what matters", "Reusable skills for travel, dining, purchases and claims"] },
  { id: "model", ic: "cpu", h: "Your own AI model", p: "Bring the model you already pay for.", items: ["Add your own API key from the dashboard", "Your model is used while it works", "If it stops, the default model takes over and you are told"] },
];

export function features(c: PageCtx): string {
  const nav = FEATURES.map((f) => `<a href="#${f.id}">${f.h}</a>`).join("");
  const rows = FEATURES.map((f) => `<div class="feat" id="${f.id}"><div><span class="ico" style="display:inline-flex;width:42px;height:42px;align-items:center;justify-content:center;border-radius:10px;background:var(--accent-soft);color:var(--accent);margin-bottom:14px">${icon(f.ic)}</span><h2 style="font-size:26px">${f.h}</h2><p class="muted" style="margin-top:8px">${f.p}</p></div><ul>${f.items.map((i) => `<li>${icon("check", 18)}<span>${i}</span></li>`).join("")}</ul></div>`).join("");
  return layout(c, { title: "Features", desc: "Channels, apps, calls, payments, web use, permissions and memory.", body: `<section class="phead"><div class="wrap"><div class="eyebrow">Features</div><h1>What your assistant can do</h1><p class="lead">A complete assistant, with controls on every part of it.</p><div class="sub-nav">${nav}</div></div></section><div class="wrap">${rows}</div>
<section class="band"><div class="wrap"><h2>See it for yourself</h2><p>Create an account and connect your first channel.</p><a class="btn" href="/signup" data-auth="signup">Sign up now</a></div></section>` });
}

export function how(c: PageCtx): string {
  const steps: Array<[string, string]> = [["Create an account", "Sign up with your email address and confirm it with the 6-digit code we send."], ["Connect your assistant", "In the dashboard, add your assistant's address and access token under Connection. Your assistant runs on infrastructure you choose."], ["Link your channels and apps", "Choose how you want to reach it and connect Gmail, Calendar and other apps. You sign in to each one yourself."], ["Set your rules", "Decide who can message it, what it may do alone, and what needs your approval. Set spending limits if you use payments."], ["Start asking", "Message it. It does the work, asks when it needs a decision, and reports back."]];
  return layout(c, { title: "How it works", body: `<section class="phead"><div class="wrap"><div class="eyebrow">How it works</div><h1>From sign-up to first task</h1><p class="lead">Setup takes a few minutes. You decide how much it can do on its own.</p></div></section>
<section class="sec"><div class="wrap narrow"><div class="stack" style="--x:0">${steps.map(([h, p], i) => `<div class="step" style="margin-bottom:32px"><span class="n">${i + 1}</span><div><h3>${h}</h3><p>${p}</p></div></div>`).join("")}</div><p style="margin-top:12px"><a class="btn" href="/signup" data-auth="signup">Sign up now</a></p></div></section>` });
}

export function security(c: PageCtx): string {
  const items: Array<[string, string, string]> = [
    ["shield", "Approval before sensitive actions", "Payments, calls and other high-impact steps wait for your yes. A separate monitor checks each action before it runs."],
    ["users", "Explicit permissions", "Seven trust levels control who can ask for what. Temporary permissions expire on their own."],
    ["lock", "Encrypted vault", "Logins, cards and addresses are stored encrypted. The assistant uses them without displaying them."],
    ["key", "Verification for risky steps", "Time-based codes confirm high-risk changes, so a stray message cannot approve them."],
    ["file", "Encrypted file sharing", "Files between assistants are end-to-end encrypted and signed by pinned keys."],
    ["data", "A record you can review", "Actions are written to an activity log you can check and verify."],
  ];
  return layout(c, { title: "Security", body: `<section class="phead"><div class="wrap"><div class="eyebrow">Security</div><h1>Built so you stay in charge</h1><p class="lead">An assistant that acts for you needs strong limits. These are ours.</p></div></section>
<section class="sec"><div class="wrap"><div class="cols c3" style="margin-top:0">${items.map(([i, h, p]) => card(i, h, p)).join("")}</div>
<div class="card" style="margin-top:32px"><h3>Your account and your model key</h3><p>Passwords are hashed with scrypt. API keys and tokens you add are encrypted at rest and are never shown again after you save them. You can delete your account and data at any time from the dashboard.</p></div></div></section>` });
}

export function pricing(c: PageCtx): string {
  return layout(c, { title: "Pricing", body: `<section class="phead"><div class="wrap"><div class="eyebrow">Pricing</div><h1>Pricing</h1><p class="lead">Plans have not been published yet.</p></div></section>
<section class="sec"><div class="wrap narrow"><div class="card"><h3>Early access</h3><p>Create an account to get started. You can bring your own AI model key, so you pay your model provider directly for usage. We will announce plans before any charge and you will be able to review them first.</p><p style="margin-top:20px"><a class="btn" href="/signup" data-auth="signup">Sign up now</a></p></div></div></section>` });
}

export function faq(c: PageCtx): string {
  const q: Array<[string, string]> = [
    ["What is it?", "An assistant you message or call. It uses your apps and the web to complete tasks for you."],
    ["How do I reach it?", "By iMessage, SMS, email, Telegram, WhatsApp, or phone, depending on what you connect."],
    ["Can it use my Gmail or GitHub?", "Yes. You connect each app by signing in to it yourself, and you can disconnect it at any time."],
    ["Will it spend my money without asking?", "No. Payments follow a budget you set, and anything outside your rules asks for approval."],
    ["Can I use my own AI model?", "Yes. Add your API key in the dashboard. Your model is used while it works. If it stops, the default model takes over and you are told."],
    ["Is my data private?", "Secrets are encrypted and you can export or delete your data at any time. Read the Privacy Policy for details."],
    ["How do I delete my account?", "Open Data in the dashboard and follow the steps."],
  ];
  return layout(c, { title: "FAQ", body: `<section class="phead"><div class="wrap"><div class="eyebrow">FAQ</div><h1>Frequently asked questions</h1></div></section><section class="sec"><div class="wrap narrow">${q.map(([a, b]) => `<details><summary>${a}</summary><p>${b}</p></details>`).join("")}</div></section>` });
}

export function legal(c: PageCtx, kind: "terms" | "privacy"): string {
  const t = kind === "terms";
  const body = t
    ? `<h2>Using the service</h2><p>You must be at least 18 years old. You are responsible for what you ask your assistant to do and for keeping your account secure.</p><h2>Your content and connections</h2><p>You decide which apps to connect. You can disconnect them at any time.</p><h2>Acceptable use</h2><p>Do not use the service to break the law, to harm others or to attack other systems.</p><h2>Changes</h2><p>We will post changes here before they take effect.</p>`
    : `<h2>What we store</h2><p>Your email address, name, a hashed password, and the settings you save. API keys and tokens you add are encrypted.</p><h2>What we do not do</h2><p>We do not sell your data.</p><h2>Your choices</h2><p>You can export your data and delete your account from the dashboard.</p><h2>Contact</h2><p>Questions about this policy can be sent to the address shown in your dashboard.</p>`;
  return layout(c, { title: t ? "Terms of Service" : "Privacy Policy", body: `<section class="phead"><div class="wrap"><h1>${t ? "Terms of Service" : "Privacy Policy"}</h1></div></section><section class="sec"><div class="wrap narrow prose"><div class="alert info">Draft summary. These terms are pending legal review and will be replaced by the full document before launch.</div>${body}</div></section>` });
}
