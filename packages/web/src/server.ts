import crypto from "node:crypto";
import http from "node:http";
import { AgentClient, checkAgentUrl } from "./agent.js";
import { accountPage, connectionPage, dataPage, modelPage, overview, PROVIDERS, shell, type AppCtx, type Flash } from "./app.js";
import type { WebConfig } from "./config.js";
import { code6, hashPassword, open, safeEqual, seal, sha256, token, verifyPassword } from "./crypto.js";
import type { Mailer } from "./mailer.js";
import { activityPage, appsPage, approvalsPage, BACK_PATHS, channelsPage, memoryPage, notConnected, pagesPage, paymentsPage, peoplePage, schedulesPage, securityPage, skillsPage, unavailable, type SecCtx } from "./sections.js";
import { authPage, faq, features, home, how, layout, legal, messagePage, pricing, security, type PageCtx } from "./site.js";
import type { CodePurpose, ModelConfig, Session, Store, User } from "./store.js";
import { CSS, JS } from "./ui.js";

export interface WebDeps {
  store: Store;
  mailer: Mailer;
  config: WebConfig;
  fetchImpl?: typeof fetch;
  lookup?: (host: string) => Promise<string[]>;
  now?: () => Date;
  log?: (m: string) => void;
}

const SESSION_DAYS = 14;
const CODE_MINUTES = 10;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const FLASH: Record<string, NonNullable<Flash>> = {
  saved: { kind: "ok", text: "Saved." },
  "model-ok": { kind: "ok", text: "Your model key works and is now active." },
  "model-synced": { kind: "ok", text: "Saved and applied to your assistant." },
  "model-unsynced": { kind: "info", text: "Saved. Your assistant could not be reached, so it will use it once it is connected." },
  "model-bad": { kind: "err", text: "The provider rejected this key, so it was saved as stopped. Check the key and try again." },
  "model-off": { kind: "ok", text: "You are now using the default model." },
  "model-removed": { kind: "ok", text: "Your key was removed." },
  "pw-ok": { kind: "ok", text: "Password updated. Other sessions were signed out." },
  "pw-bad": { kind: "err", text: "The current password is not correct." },
  "pw-short": { kind: "err", text: "The new password must be at least 10 characters." },
  "del-bad": { kind: "err", text: "Check your password and type DELETE to confirm." },
  disconnected: { kind: "ok", text: "Your assistant was disconnected." },
  "no-agent": { kind: "info", text: "Connect your assistant first." },
};

class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number) {}
  /** True when the action is allowed. */
  allow(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (list.length >= limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 20000) for (const [k, v] of this.hits) if (v.every((x) => t - x >= windowMs)) this.hits.delete(k);
    return true;
  }
}

function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function testProvider(provider: string, apiKey: string, baseUrl: string | undefined, fetchImpl: typeof fetch): Promise<{ ok: boolean; error?: string }> {
  const call = async (url: string, headers: Record<string, string>) => {
    try {
      const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(12000), redirect: "manual" });
      if (r.status === 401 || r.status === 403) return { ok: false, error: "The provider rejected this key." };
      if (r.status === 429) return { ok: true };
      if (r.status >= 200 && r.status < 300) return { ok: true };
      return { ok: false, error: `The provider answered with ${r.status}.` };
    } catch {
      return { ok: false, error: "The provider could not be reached." };
    }
  };
  if (provider === "anthropic") return call("https://api.anthropic.com/v1/models", { "x-api-key": apiKey, "anthropic-version": "2023-06-01" });
  if (provider === "openai") return call("https://api.openai.com/v1/models", { authorization: `Bearer ${apiKey}` });
  if (provider === "google") return call(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {});
  if (provider === "openrouter") return call("https://openrouter.ai/api/v1/auth/key", { authorization: `Bearer ${apiKey}` });
  if (provider === "compatible" && baseUrl) return call(`${baseUrl.replace(/\/+$/, "")}/models`, { authorization: `Bearer ${apiKey}` });
  return { ok: false, error: "Unknown provider." };
}

export function createWebServer(deps: WebDeps): http.Server {
  const { store, mailer, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const fetchImpl = deps.fetchImpl ?? fetch;
  const agent = new AgentClient(fetchImpl);
  const limiter = new RateLimiter(() => now().getTime());
  /** The assistant's last answer to a dashboard action, shown once on the next page load. */
  const replies = new Map<string, { text: string; at: number }>();
  const takeReply = (id: string): string | undefined => {
    const r = replies.get(id);
    replies.delete(id);
    return r && now().getTime() - r.at < 300_000 ? r.text : undefined;
  };
  const dummyHash = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");
  const ipOf = (req: http.IncomingMessage) => (config.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() : "") || req.socket.remoteAddress || "?";
  const hmac = (s: string) => crypto.createHmac("sha256", config.secretKey).update(s).digest("base64url");

  async function issueCode(user: User, purpose: CodePurpose): Promise<void> {
    const code = code6();
    await store.putCode({ userId: user.id, purpose, hash: sha256(`${user.id}:${code}`), expiresAt: new Date(now().getTime() + CODE_MINUTES * 60_000).toISOString(), attempts: 0 });
    await mailer.send(user.email, purpose === "verify" ? `${config.brand}: your verification code` : `${config.brand}: reset your password`, `Your code is ${code}. It expires in ${CODE_MINUTES} minutes. If you did not request it, ignore this email.`);
  }

  async function checkCode(user: User, purpose: CodePurpose, code: string): Promise<"ok" | "bad" | "locked" | "expired"> {
    const rec = await store.getCode(user.id, purpose);
    if (!rec) return "expired";
    if (Date.parse(rec.expiresAt) < now().getTime()) {
      await store.deleteCode(user.id, purpose);
      return "expired";
    }
    if (rec.attempts >= 5) {
      await store.deleteCode(user.id, purpose);
      return "locked";
    }
    if (!safeEqual(rec.hash, sha256(`${user.id}:${code.trim()}`))) {
      await store.putCode({ ...rec, attempts: rec.attempts + 1 });
      return "bad";
    }
    await store.deleteCode(user.id, purpose);
    return "ok";
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`web error: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", "Something went wrong.");
      else res.end();
    });
  });

  function send(res: http.ServerResponse, status: number, type: string, body: string, extra: Record<string, string | string[]> = {}): void {
    res.writeHead(status, {
      "content-type": type,
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; form-action 'self' https:; base-uri 'none'",
      ...(config.secureCookies ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
      ...extra,
    });
    res.end(body);
  }

  async function readBody(req: http.IncomingMessage, limit = 32 * 1024): Promise<string | undefined> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > limit) return undefined;
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", config.publicUrl);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    const cookies = parseCookies(req.headers.cookie);
    const setCookies: string[] = [];
    const cookie = (name: string, value: string, maxAge: number) => setCookies.push(`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookies ? "; Secure" : ""}`);
    const html = (status: number, body: string) => send(res, status, "text/html; charset=utf-8", body, { "cache-control": "no-store", ...(setCookies.length ? { "set-cookie": setCookies } : {}) });
    const json = (status: number, v: unknown) => send(res, status, "application/json; charset=utf-8", JSON.stringify(v), { "cache-control": "no-store", ...(setCookies.length ? { "set-cookie": setCookies } : {}) });
    const redirect = (to: string) => send(res, 303, "text/plain; charset=utf-8", "", { location: to, "cache-control": "no-store", ...(setCookies.length ? { "set-cookie": setCookies } : {}) });

    // static assets and health
    if (method === "GET" && path === "/assets/site.css") return send(res, 200, "text/css; charset=utf-8", CSS, { "cache-control": "public, max-age=3600" });
    if (method === "GET" && path === "/assets/site.js") return send(res, 200, "text/javascript; charset=utf-8", JS, { "cache-control": "public, max-age=3600" });
    if (method === "GET" && path === "/healthz") return json(200, { ok: true });

    // the agent reports model problems here
    if (method === "POST" && path === "/api/agent/model-event") {
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      if (!bearer || !limiter.allow(`ev:${ipOf(req)}`, 60, 60_000)) return json(401, { error: "unauthorized" });
      const user = await store.userBySecretHash(sha256(bearer));
      if (!user) return json(401, { error: "unauthorized" });
      let body: { status?: unknown; error?: unknown } = {};
      try {
        body = JSON.parse((await readBody(req, 4096)) ?? "{}");
      } catch {
        return json(400, { error: "bad json" });
      }
      const m = await store.getModel(user.id);
      if (m && (body.status === "failed" || body.status === "active")) {
        const { lastError: _drop, ...rest } = m;
        await store.putModel({ ...rest, status: body.status, ...(body.status === "failed" ? { lastError: String(body.error ?? "The model stopped.").slice(0, 300) } : {}), updatedAt: now().toISOString() });
      }
      return json(204 as number, {});
    }

    // session and csrf
    let session: Session | undefined;
    let user: User | undefined;
    const sid = cookies.sid;
    if (sid) {
      session = await store.getSession(sha256(sid));
      if (session && Date.parse(session.expiresAt) < now().getTime()) {
        await store.deleteSession(session.id);
        session = undefined;
      }
      if (session) user = await store.userById(session.userId);
    }
    let csrf = session?.csrf ?? cookies.pcsrf;
    if (!csrf) {
      csrf = token(24);
      cookie("pcsrf", csrf, 3600 * 8);
    }
    const pageCtx: PageCtx = { brand: config.brand, csrf, signedIn: Boolean(user), path };

    let form: URLSearchParams | undefined;
    let jsonBody: Record<string, unknown> | undefined;
    if (method === "POST") {
      const raw = await readBody(req);
      if (raw === undefined) return html(413, messagePage(pageCtx, "Request too large", "That request was too large."));
      const type = String(req.headers["content-type"] ?? "");
      if (type.includes("application/json")) {
        try {
          jsonBody = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return json(400, { error: "bad json" });
        }
      } else form = new URLSearchParams(raw);
      const sent = form?.get("csrf") ?? String(req.headers["x-csrf-token"] ?? "");
      if (!sent || !safeEqual(sent, csrf)) return html(403, messagePage(pageCtx, "Session expired", "Please go back, refresh the page and try again.", { href: "/", label: "Back to home" }));
    }
    const f = (k: string) => (form?.get(k) ?? "").trim();

    const startSession = async (u: User) => {
      const raw = token(32);
      const t = now();
      await store.putSession({ id: sha256(raw), userId: u.id, csrf: token(24), createdAt: t.toISOString(), expiresAt: new Date(t.getTime() + SESSION_DAYS * 86_400_000).toISOString() });
      cookie("sid", raw, SESSION_DAYS * 86_400);
      cookie("pend", "", 0);
    };
    const pending = async (): Promise<User | undefined> => {
      const v = cookies.pend;
      const i = v?.lastIndexOf(".") ?? -1;
      if (!v || i < 1) return undefined;
      const id = v.slice(0, i);
      if (!safeEqual(v.slice(i + 1), hmac(id))) return undefined;
      return store.userById(id);
    };
    const setPending = (u: User) => cookie("pend", `${u.id}.${hmac(u.id)}`, 1800);

    // public pages
    if (method === "GET") {
      const pages: Record<string, () => string> = {
        "/": () => home(pageCtx),
        "/features": () => features(pageCtx),
        "/how-it-works": () => how(pageCtx),
        "/security": () => security(pageCtx),
        "/pricing": () => pricing(pageCtx),
        "/faq": () => faq(pageCtx),
        "/terms": () => legal(pageCtx, "terms"),
        "/privacy": () => legal(pageCtx, "privacy"),
      };
      const p = pages[path];
      if (p) return html(200, p());
      if (path === "/login") return user ? redirect("/app") : html(200, authPage(pageCtx, "login"));
      if (path === "/signup") return user ? redirect("/app") : html(200, authPage(pageCtx, "signup"));
    }

    // account creation and sign-in
    if (method === "POST" && path === "/signup") {
      const email = f("email").toLowerCase();
      const name = f("name");
      const password = form?.get("password") ?? "";
      const fail = (error: string) => html(400, authPage(pageCtx, "signup", { error, email }));
      if (!limiter.allow(`su:${ipOf(req)}`, 10, 3600_000)) return fail("Too many attempts. Try again later.");
      if (!EMAIL_RE.test(email) || email.length > 254) return fail("Enter a valid email address.");
      if (!name || name.length > 80) return fail("Enter your name.");
      if (password.length < 10 || password.length > 200) return fail("Use a password of at least 10 characters.");
      const existing = await store.userByEmail(email);
      if (existing?.verified) return fail("An account with this email already exists. Sign in instead.");
      const passHash = await hashPassword(password);
      let target: User;
      if (existing) {
        await store.updateUser(existing.id, { name, passHash });
        target = { ...existing, name, passHash };
      } else {
        target = { id: token(12), email, name, passHash, verified: false, createdAt: now().toISOString() };
        await store.createUser(target);
      }
      await issueCode(target, "verify");
      setPending(target);
      return redirect("/verify");
    }

    if (path === "/verify") {
      const p = await pending();
      if (!p) return redirect("/signup");
      const masked = p.email.replace(/^(.).*(@.*)$/, "$1***$2");
      const page = (error?: string, info?: string) =>
        layout(pageCtx, { title: "Confirm your email", body: `<div class="wrap"><div class="authbox"><h1>Check your email</h1><p class="muted">We sent a 6-digit code to ${masked}. It expires in ${CODE_MINUTES} minutes.</p>${error ? `<div class="alert err" style="margin-top:16px">${error}</div>` : ""}${info ? `<div class="alert ok" style="margin-top:16px">${info}</div>` : ""}
<form method="post" action="/verify"><input type="hidden" name="csrf" value="${csrf}"><label for="c">Verification code</label><input id="c" type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required><button class="btn" type="submit">Confirm email</button></form>
<form method="post" action="/verify/resend"><input type="hidden" name="csrf" value="${csrf}"><p class="alt">Did not get it? <button class="link" type="submit" style="color:var(--accent)">Send a new code</button></p></form></div></div>` });
      if (method === "GET") return html(200, page());
      if (method === "POST") {
        if (!limiter.allow(`vf:${p.id}`, 15, 900_000)) return html(429, page("Too many attempts. Try again later."));
        const r = await checkCode(p, "verify", f("code"));
        if (r === "ok") {
          await store.updateUser(p.id, { verified: true });
          await startSession({ ...p, verified: true });
          return redirect("/app");
        }
        return html(400, page(r === "bad" ? "That code is not correct." : "That code has expired or was locked. Send a new one."));
      }
    }
    if (method === "POST" && path === "/verify/resend") {
      const p = await pending();
      if (!p) return redirect("/signup");
      if (limiter.allow(`rs:${p.id}`, 1, 60_000)) await issueCode(p, "verify");
      return redirect("/verify");
    }

    if (method === "POST" && path === "/login") {
      const email = f("email").toLowerCase();
      const ip = ipOf(req);
      const fail = (error: string, status = 400) => html(status, authPage(pageCtx, "login", { error, email }));
      if (!limiter.allow(`lg:${ip}`, 40, 900_000) || !limiter.allow(`lge:${email}`, 8, 900_000)) return fail("Too many attempts. Try again in a few minutes.", 429);
      const u = email ? await store.userByEmail(email) : undefined;
      const ok = await verifyPassword(form?.get("password") ?? "", u?.passHash ?? dummyHash);
      if (!u || !ok) return fail("The email or password is not correct.");
      if (!u.verified) {
        await issueCode(u, "verify");
        setPending(u);
        return redirect("/verify");
      }
      await startSession(u);
      return redirect("/app");
    }

    if (method === "POST" && path === "/logout") {
      if (session) await store.deleteSession(session.id);
      cookie("sid", "", 0);
      return redirect("/");
    }

    // password reset
    if (path === "/forgot") {
      const page = (msg?: string) => layout(pageCtx, { title: "Reset your password", body: `<div class="wrap"><div class="authbox"><h1>Reset your password</h1><p class="muted">Enter your email and we will send a code.</p>${msg ? `<div class="alert ok" style="margin-top:16px">${msg}</div>` : ""}<form method="post" action="/forgot"><input type="hidden" name="csrf" value="${csrf}"><label for="e">Email</label><input id="e" type="email" name="email" required><button class="btn" type="submit">Send code</button></form><p class="alt"><a href="/reset">I already have a code</a></p></div></div>` });
      if (method === "GET") return html(200, page());
      if (method === "POST") {
        const email = f("email").toLowerCase();
        if (limiter.allow(`fg:${ipOf(req)}`, 10, 3600_000) && limiter.allow(`fge:${email}`, 3, 3600_000)) {
          const u = await store.userByEmail(email);
          if (u?.verified) await issueCode(u, "reset");
        }
        return html(200, page("If an account exists for that email, we sent a code."));
      }
    }
    if (path === "/reset") {
      const page = (error?: string) => layout(pageCtx, { title: "Choose a new password", body: `<div class="wrap"><div class="authbox"><h1>Choose a new password</h1>${error ? `<div class="alert err" style="margin-top:16px">${error}</div>` : ""}<form method="post" action="/reset"><input type="hidden" name="csrf" value="${csrf}"><label for="e">Email</label><input id="e" type="email" name="email" required><label for="c">Code</label><input id="c" type="text" name="code" inputmode="numeric" maxlength="6" required><label for="p">New password</label><input id="p" type="password" name="password" minlength="10" maxlength="200" required autocomplete="new-password"><button class="btn" type="submit">Update password</button></form></div></div>` });
      if (method === "GET") return html(200, page());
      if (method === "POST") {
        const email = f("email").toLowerCase();
        const password = form?.get("password") ?? "";
        if (!limiter.allow(`rt:${ipOf(req)}`, 20, 900_000)) return html(429, page("Too many attempts. Try again later."));
        if (password.length < 10 || password.length > 200) return html(400, page("Use a password of at least 10 characters."));
        const u = await store.userByEmail(email);
        if (!u || (await checkCode(u, "reset", f("code"))) !== "ok") return html(400, page("That code is not correct or has expired."));
        await store.updateUser(u.id, { passHash: await hashPassword(password) });
        await store.deleteUserSessions(u.id);
        return html(200, messagePage(pageCtx, "Password updated", "You can now sign in with your new password.", { href: "/login", label: "Sign in" }));
      }
    }

    // dashboard
    if (path === "/app" || path.startsWith("/app/")) {
      if (!user || !session) return redirect("/login");
      const u = user;
      const ctx: AppCtx = { brand: config.brand, csrf: session.csrf, user: u, path, agentConnected: Boolean(u.agentUrl && u.agentTokenSealed) };
      const flashKey = url.searchParams.get("m") ?? "";
      const flash: Flash = FLASH[flashKey];
      const to = (p: string, m: string) => redirect(`${p}?m=${m}`);
      const agentToken = () => (u.agentTokenSealed ? open(config.secretKey, u.agentTokenSealed) : "");
      const pushModel = async (payload: unknown) => (u.agentUrl && u.agentTokenSealed ? agent.pushModel(u.agentUrl, agentToken(), payload) : false);

      if (method === "GET" && path === "/app") {
        const model = await store.getModel(u.id);
        const status = ctx.agentConnected ? await agent.status(u.agentUrl!, agentToken()) : undefined;
        const counts = ctx.agentConnected && status?.reachable ? (await agent.owner(u.agentUrl!, agentToken(), "overview")).data : undefined;
        return html(200, shell(ctx, "Overview", `Welcome, ${u.name.split(" ")[0] ?? u.name}.`, overview(ctx, model, status, counts), takeReply(u.id)));
      }
      if (method === "GET" && path === "/app/model") return html(200, shell(ctx, "AI model", "Use your own model key. The default model is the fallback.", modelPage(ctx, await store.getModel(u.id), flash)));
      if (method === "POST" && path === "/app/model") {
        const provider = f("provider");
        const model = f("model");
        const apiKey = f("apiKey");
        const baseRaw = f("baseUrl");
        const P = PROVIDERS[provider];
        const err = (text: string) => html(400, shell(ctx, "AI model", "Use your own model key. The default model is the fallback.", modelPage(ctx, undefined, { kind: "err", text })));
        if (!P) return err("Choose a provider.");
        if (!/^[\w.:/@+-]{1,120}$/.test(model)) return err("Enter the model name.");
        if (apiKey.length < 8 || apiKey.length > 400) return err("Enter your API key.");
        let baseUrl: string | undefined;
        if (P.needsBaseUrl) {
          const chk = await checkAgentUrl(baseRaw, config.allowPrivateAgents, deps.lookup);
          if (!chk.ok) return err(chk.error ?? "Enter a valid endpoint URL.");
          baseUrl = chk.url;
        }
        if (!limiter.allow(`mt:${u.id}`, 10, 600_000)) return err("Too many tests. Try again in a few minutes.");
        const tested = await testProvider(provider, apiKey, baseUrl, fetchImpl);
        const cfg: ModelConfig = { userId: u.id, provider, model, ...(baseUrl ? { baseUrl } : {}), keySealed: seal(config.secretKey, apiKey), keyLast4: apiKey.slice(-4), enabled: tested.ok, status: tested.ok ? "active" : "failed", ...(tested.ok ? {} : { lastError: tested.error ?? "The key was rejected." }), updatedAt: now().toISOString() };
        await store.putModel(cfg);
        if (!tested.ok) return to("/app/model", "model-bad");
        const synced = await pushModel({ enabled: true, provider, model, ...(baseUrl ? { baseUrl } : {}), apiKey });
        return to("/app/model", synced ? "model-synced" : ctx.agentConnected ? "model-unsynced" : "model-ok");
      }
      if (method === "POST" && path === "/app/model/test") {
        const m = await store.getModel(u.id);
        if (!m) return to("/app/model", "saved");
        const tested = await testProvider(m.provider, open(config.secretKey, m.keySealed), m.baseUrl, fetchImpl);
        const { lastError: _x, ...rest } = m;
        await store.putModel({ ...rest, status: tested.ok ? "active" : "failed", ...(tested.ok ? {} : { lastError: tested.error ?? "The key was rejected." }), updatedAt: now().toISOString() });
        return to("/app/model", tested.ok ? "model-ok" : "model-bad");
      }
      if (method === "POST" && (path === "/app/model/disable" || path === "/app/model/enable")) {
        const m = await store.getModel(u.id);
        if (!m) return to("/app/model", "saved");
        const enable = path.endsWith("enable") && !path.endsWith("disable");
        await store.putModel({ ...m, enabled: enable, updatedAt: now().toISOString() });
        await pushModel(enable ? { enabled: true, provider: m.provider, model: m.model, ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}), apiKey: open(config.secretKey, m.keySealed) } : { enabled: false });
        return to("/app/model", enable ? "saved" : "model-off");
      }
      if (method === "POST" && path === "/app/model/remove") {
        await store.deleteModel(u.id);
        await pushModel({ enabled: false, remove: true });
        return to("/app/model", "model-removed");
      }

      if (method === "GET" && path === "/app/connection") return html(200, shell(ctx, "Connection", "Link the dashboard to your assistant.", connectionPage(ctx, u, flash)));
      if (method === "POST" && path === "/app/connection") {
        const page = (fl: Flash, secret?: string, usr: User = u) => shell(ctx, "Connection", "Link the dashboard to your assistant.", connectionPage(ctx, usr, fl, secret, config.publicUrl));
        const chk = await checkAgentUrl(f("url"), config.allowPrivateAgents, deps.lookup);
        if (!chk.ok) return html(400, page({ kind: "err", text: chk.error ?? "Check the address." }));
        const tok = f("token") || agentToken();
        if (!tok) return html(400, page({ kind: "err", text: "Enter the access token." }));
        if (!limiter.allow(`cn:${u.id}`, 10, 600_000)) return html(429, page({ kind: "err", text: "Too many attempts. Try again in a few minutes." }));
        const st = await agent.status(chk.url!, tok);
        if (!st.reachable) return html(400, page({ kind: "err", text: st.error ?? "The assistant did not answer." }));
        const changed = chk.url !== u.agentUrl || !u.agentSecretHash;
        const secret = changed ? token(24) : undefined;
        await store.updateUser(u.id, { agentUrl: chk.url!, agentTokenSealed: seal(config.secretKey, tok), ...(secret ? { agentSecretHash: sha256(secret) } : {}) });
        const fresh = (await store.userById(u.id)) ?? u;
        const m = await store.getModel(u.id);
        if (m?.enabled) await agent.pushModel(chk.url!, tok, { enabled: true, provider: m.provider, model: m.model, ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}), apiKey: open(config.secretKey, m.keySealed) });
        return html(200, page({ kind: "ok", text: "Connected. Your assistant answered." }, secret, fresh));
      }
      if (method === "POST" && path === "/app/connection/disconnect") {
        await store.updateUser(u.id, { agentUrl: undefined, agentTokenSealed: undefined, agentSecretHash: undefined });
        return to("/app/connection", "disconnected");
      }

      if (method === "GET" && path === "/app/account") return html(200, shell(ctx, "Account", "Your profile and password.", accountPage(ctx, flash)));
      if (method === "POST" && path === "/app/account/profile") {
        const name = f("name");
        if (name && name.length <= 80) await store.updateUser(u.id, { name });
        return to("/app/account", "saved");
      }
      if (method === "POST" && path === "/app/account/password") {
        const pw = form?.get("password") ?? "";
        if (!limiter.allow(`pw:${u.id}`, 5, 900_000)) return to("/app/account", "pw-bad");
        if (!(await verifyPassword(form?.get("current") ?? "", u.passHash))) return to("/app/account", "pw-bad");
        if (pw.length < 10 || pw.length > 200) return to("/app/account", "pw-short");
        await store.updateUser(u.id, { passHash: await hashPassword(pw) });
        await store.deleteUserSessions(u.id, session.id);
        return to("/app/account", "pw-ok");
      }

      if (method === "GET" && path === "/app/data") return html(200, shell(ctx, "Data and privacy", "Export or delete what we hold about you.", dataPage(ctx, flash)));
      if (method === "GET" && path === "/app/data/export") {
        const m = await store.getModel(u.id);
        const out = { exportedAt: now().toISOString(), account: { email: u.email, name: u.name, createdAt: u.createdAt }, assistant: { address: u.agentUrl ?? null }, model: m ? { provider: m.provider, model: m.model, endpoint: m.baseUrl ?? null, enabled: m.enabled, status: m.status, keyEnding: m.keyLast4 } : null };
        return send(res, 200, "application/json; charset=utf-8", JSON.stringify(out, null, 2), { "content-disposition": 'attachment; filename="my-data.json"', "cache-control": "no-store" });
      }
      if (method === "POST" && path === "/app/data/delete") {
        if (f("confirm") !== "DELETE" || !limiter.allow(`dl:${u.id}`, 5, 900_000) || !(await verifyPassword(form?.get("password") ?? "", u.passHash))) return to("/app/data", "del-bad");
        await store.deleteUser(u.id);
        cookie("sid", "", 0);
        return html(200, messagePage({ ...pageCtx, signedIn: false }, "Account deleted", "Your account and saved settings were deleted.", { href: "/", label: "Back to home" }));
      }

      // sections that show the assistant's own state (read-only), plus actions sent to it as chat commands
      const sc: SecCtx = { csrf: session.csrf, path };
      const SECTIONS: Record<string, { title: string; desc: string; resource: string; query?: string; render: (c: SecCtx, d: any) => string }> = {
        "/app/approvals": { title: "Approvals", desc: "Actions that are waiting for your decision.", resource: "approvals", render: approvalsPage },
        "/app/activity": { title: "Activity", desc: "What your assistant has done, newest first.", resource: "activity", query: "?limit=150", render: activityPage },
        "/app/apps": { title: "Apps", desc: "Connect the tools your assistant works in.", resource: "apps", render: appsPage },
        "/app/channels": { title: "Channels", desc: "Where you and others can reach your assistant.", resource: "channels", render: channelsPage },
        "/app/people": { title: "People", desc: "Who may message your assistant, and what they may ask for.", resource: "people", render: peoplePage },
        "/app/schedules": { title: "Schedules", desc: "Reminders and routines your assistant runs.", resource: "schedules", render: schedulesPage },
        "/app/memory": { title: "Memory", desc: "What your assistant remembers about you.", resource: "memory", render: memoryPage },
        "/app/skills": { title: "Skills", desc: "Playbooks your assistant follows.", resource: "skills", render: skillsPage },
        "/app/pages": { title: "Pages", desc: "Polls, sign-ups and RSVPs you can share.", resource: "pages", render: pagesPage },
        "/app/payments": { title: "Payments", desc: "Budgets, cards and calls your assistant may use.", resource: "payments", render: paymentsPage },
        "/app/security": { title: "Security", desc: "How your assistant and your data are protected.", resource: "security", render: securityPage },
      };
      const section = SECTIONS[path];
      if (method === "GET" && section) {
        if (!ctx.agentConnected) return html(200, shell(ctx, section.title, section.desc, notConnected));
        const r = await agent.owner(u.agentUrl!, agentToken(), section.resource, section.query ?? "");
        return html(200, shell(ctx, section.title, section.desc, r.ok ? section.render(sc, r.data) : unavailable(r.error ?? "Unavailable."), takeReply(u.id)));
      }
      const oneLine = (v: string, n = 200) => v.replace(/[\r\n\u0000-\u001f]+/g, " ").trim().slice(0, n);
      const sendAct = async (message: string, back: string) => {
        const target = BACK_PATHS.includes(back) ? back : "/app";
        if (!ctx.agentConnected) return to(target, "no-agent");
        if (!limiter.allow(`act:${u.id}`, 20, 60_000)) {
          replies.set(u.id, { text: "You are sending commands too quickly. Try again in a minute.", at: now().getTime() });
          return redirect(target);
        }
        const r = await agent.chat(u.agentUrl!, agentToken(), message, `web:${u.id}`);
        replies.set(u.id, { text: r.reply.slice(0, 800), at: now().getTime() });
        return redirect(target);
      };
      if (method === "POST" && path === "/app/act") {
        const message = oneLine(f("message"), 1000);
        return message ? sendAct(message, f("back")) : redirect("/app");
      }
      if (method === "POST" && path === "/app/people/tier") {
        const tier = f("tier");
        if (!["staff", "partner", "family", "friend", "contact", "stranger"].includes(tier)) return redirect("/app/people");
        return sendAct(`Set ${oneLine(f("name"), 80)}'s trust level to ${tier}.`, "/app/people");
      }
      if (method === "POST" && path === "/app/people/add") {
        const tier = f("tier");
        if (!["staff", "partner", "family", "friend", "contact", "stranger"].includes(tier)) return redirect("/app/people");
        return sendAct(`Add ${oneLine(f("name"), 80)} (${oneLine(f("contact"), 120)}) to my contacts as ${tier}.`, "/app/people");
      }
      if (method === "POST" && path === "/app/payments/egp") {
        const n = (k: string) => Math.max(0, Math.min(100000, Math.round(Number(f(k)) || 0)));
        return sendAct(`Turn on my Egyptian pound budget: set the total to ${n("budget")} EGP, ${n("perPurchase")} EGP per purchase and ${n("daily")} EGP per day (0 means no cap).`, "/app/payments");
      }
      if (method === "POST" && path === "/app/apps/connect") {
        const toolkit = f("toolkit");
        if (!ctx.agentConnected || !/^[a-z0-9_-]{2,60}$/i.test(toolkit)) return to("/app/apps", "no-agent");
        const r = await agent.owner(u.agentUrl!, agentToken(), "apps/connect", `?toolkit=${encodeURIComponent(toolkit)}`);
        const link = typeof r.data?.url === "string" ? r.data.url : "";
        if (r.ok && /^https:\/\//.test(link)) return redirect(link);
        replies.set(u.id, { text: r.error ?? "No sign-in link is available for that app.", at: now().getTime() });
        return redirect("/app/apps");
      }
      return html(404, shell(ctx, "Not found", "That page does not exist.", '<p><a href="/app">Back to overview</a></p>'));
    }

    return html(404, messagePage(pageCtx, "Page not found", "That page does not exist.", { href: "/", label: "Back to home" }));
  }

  return server;
}
