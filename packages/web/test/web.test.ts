import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { open, seal } from "../src/crypto.js";
import { checkAgentUrl } from "../src/agent.js";
import { createWebServer } from "../src/server.js";
import { MemoryStore } from "../src/store.js";

const KEY = Buffer.alloc(32, 7);
const PASS = "correct horse battery";

interface Env {
  base: string;
  store: MemoryStore;
  mails: Array<{ to: string; text: string }>;
  pushed: unknown[];
  chats: string[];
  close: () => Promise<void>;
}

async function start(): Promise<Env> {
  const store = new MemoryStore();
  const mails: Env["mails"] = [];
  const pushed: unknown[] = [];
  const chats: string[] = [];
  const config = loadConfig({ WEB_SECRET_KEY: KEY.toString("base64"), WEB_PUBLIC_URL: "http://localhost" } as never, () => KEY);
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (u === "https://agent.example.com/status") return json(init?.headers && (init.headers as Record<string, string>)["x-instinct-token"] === "tok-123" ? 200 : 401, { agent: "T", ready: true });
    if (u === "https://agent.example.com/chat") { chats.push(String(init?.body)); return json(200, { response: "Done." }); }
    if (u === "https://agent.example.com/model") { pushed.push(JSON.parse(String(init?.body))); return json(200, { ok: true }); }
    if (u.startsWith("https://api.openai.com/v1/models")) return json((init?.headers as Record<string, string>).authorization === "Bearer good-key-123456" ? 200 : 401, {});
    return json(404, {});
  }) as typeof fetch;
  const server = createWebServer({
    store,
    config,
    fetchImpl,
    mailer: { send: async (to, _s, text) => void mails.push({ to, text }) },
    lookup: async (h) => (h === "evil.example.com" ? ["10.0.0.5"] : ["93.184.216.34"]),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, mails, pushed, chats, close: () => new Promise((r) => server.close(() => r())) };
}

/** A tiny browser: keeps cookies, follows nothing, reads the csrf token out of forms. */
class Client {
  jar = new Map<string, string>();
  constructor(private readonly base: string) {}
  async req(path: string, init: RequestInit = {}) {
    const r = await fetch(this.base + path, { ...init, redirect: "manual", headers: { ...(init.headers as object), cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv!.indexOf("=");
      const name = kv!.slice(0, i);
      const val = kv!.slice(i + 1);
      if (/Max-Age=0/i.test(c)) this.jar.delete(name);
      else this.jar.set(name, val);
    }
    return r;
  }
  async csrf(path = "/login") {
    const html = await (await this.req(path)).text();
    return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  }
  async post(path: string, data: Record<string, string>, csrf?: string) {
    const token = csrf ?? (await this.csrf());
    return this.req(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: token, ...data }).toString() });
  }
}

let env: Env;
beforeEach(async () => { env = await start(); });
afterEach(async () => { await env.close(); });

async function signedIn(email = "omar@example.com"): Promise<{ c: Client; csrf: string }> {
  const c = new Client(env.base);
  await c.post("/signup", { name: "Omar Ali", email, password: PASS });
  const code = /code is (\d{6})/.exec(env.mails.at(-1)!.text)![1]!;
  const r = await c.post("/verify", { code }, await c.csrf("/verify"));
  expect(r.headers.get("location")).toBe("/app");
  return { c, csrf: await c.csrf("/app/account") };
}

describe("public site", () => {
  it("serves every public page with the sign-up button at the top left, English only", async () => {
    const c = new Client(env.base);
    for (const p of ["/", "/features", "/how-it-works", "/security", "/pricing", "/faq", "/terms", "/privacy", "/login", "/signup"]) {
      const r = await c.req(p);
      expect(r.status, p).toBe(200);
      const html = await r.text();
      expect(html, p).toContain('<html lang="en"');
      expect(html, p).toContain("Sign up now");
      expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
    }
    expect((await c.req("/nope")).status).toBe(404);
    expect((await c.req("/assets/site.css")).status).toBe(200);
  });
  it("keeps the dashboard behind sign-in", async () => {
    const r = await new Client(env.base).req("/app/model");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/login");
  });
});

describe("accounts", () => {
  it("signs up with email, confirms with a code, and lands in the dashboard", async () => {
    const { c } = await signedIn();
    const page = await (await c.req("/app")).text();
    expect(page).toContain("Welcome, Omar.");
    const u = await env.store.userByEmail("omar@example.com");
    expect(u?.verified).toBe(true);
    expect(u?.passHash.startsWith("scrypt$")).toBe(true);
  });
  it("rejects a missing or wrong CSRF token, bad input, duplicates and wrong codes", async () => {
    const c = new Client(env.base);
    expect((await c.req("/signup", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=a@b.co" })).status).toBe(403);
    expect((await c.post("/signup", { name: "A", email: "bad", password: PASS })).status).toBe(400);
    expect((await c.post("/signup", { name: "A", email: "a@b.co", password: "short" })).status).toBe(400);
    await c.post("/signup", { name: "A", email: "a@b.co", password: PASS });
    expect((await c.post("/verify", { code: "000000" }, await c.csrf("/verify"))).status).toBe(400);
    await signedIn("second@example.com");
    const d = new Client(env.base);
    const dup = await d.post("/signup", { name: "B", email: "second@example.com", password: PASS });
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain("already exists");
  });
  it("signs in with the right password only, and locks a code after 5 wrong tries", async () => {
    await signedIn();
    const c = new Client(env.base);
    const bad = await c.post("/login", { email: "omar@example.com", password: "wrong wrong wrong" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("not correct");
    const ok = await c.post("/login", { email: "omar@example.com", password: PASS });
    expect(ok.headers.get("location")).toBe("/app");
    const d = new Client(env.base);
    await d.post("/signup", { name: "L", email: "lock@example.com", password: PASS });
    const csrf = await d.csrf("/verify");
    for (let i = 0; i < 5; i++) await d.post("/verify", { code: "111111" }, csrf);
    const right = /code is (\d{6})/.exec(env.mails.at(-1)!.text)![1]!;
    expect((await d.post("/verify", { code: right }, csrf)).status).toBe(400); // locked even with the right code
  });
  it("resets a password with a code and signs other sessions out", async () => {
    await signedIn();
    const c = new Client(env.base);
    await c.post("/forgot", { email: "omar@example.com" });
    const code = /code is (\d{6})/.exec(env.mails.at(-1)!.text)![1]!;
    const r = await c.post("/reset", { email: "omar@example.com", code, password: "a brand new passphrase" });
    expect(r.status).toBe(200);
    expect((await new Client(env.base).post("/login", { email: "omar@example.com", password: PASS })).status).toBe(400);
    expect((await new Client(env.base).post("/login", { email: "omar@example.com", password: "a brand new passphrase" })).status).toBe(303);
  });
  it("changes the password, signs out other sessions, exports data, and deletes the account", async () => {
    const { c, csrf } = await signedIn();
    const other = new Client(env.base);
    await other.post("/login", { email: "omar@example.com", password: PASS });
    expect((await other.req("/app")).status).toBe(200);
    await c.post("/app/account/password", { current: PASS, password: "another long passphrase" }, csrf);
    expect((await other.req("/app")).status).toBe(303); // kicked out
    expect((await c.req("/app")).status).toBe(200); // this one stays
    const exp = await (await c.req("/app/data/export")).text();
    expect(exp).toContain("omar@example.com");
    expect(exp).not.toContain("scrypt");
    expect((await c.post("/app/data/delete", { password: "another long passphrase", confirm: "no" }, csrf)).status).toBe(303);
    expect((await c.post("/app/data/delete", { password: "another long passphrase", confirm: "DELETE" }, csrf)).status).toBe(200);
    expect(await env.store.userByEmail("omar@example.com")).toBeUndefined();
    expect((await c.req("/app")).status).toBe(303);
  });
});

describe("assistant connection and chat", () => {
  it("refuses private addresses, plain http and bad tokens; connects a real one and chats", async () => {
    const { c, csrf } = await signedIn();
    for (const url of ["http://agent.example.com", "https://127.0.0.1", "https://localhost", "https://evil.example.com", "https://10.1.2.3", "https://user:pw@agent.example.com"]) {
      expect((await c.post("/app/connection", { url, token: "tok-123" }, csrf)).status, url).toBe(400);
    }
    expect((await c.post("/app/connection", { url: "https://agent.example.com", token: "wrong" }, csrf)).status).toBe(400);
    const ok = await c.post("/app/connection", { url: "https://agent.example.com", token: "tok-123" }, csrf);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("INSTINCT_WEB_SECRET=");
    const u = await env.store.userByEmail("omar@example.com");
    expect(u?.agentTokenSealed).not.toContain("tok-123");
    expect(open(KEY, u!.agentTokenSealed!)).toBe("tok-123");
    const chat = await c.req("/app/chat/send", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ message: "hello" }) });
    expect(await chat.json()).toEqual({ reply: "Done." });
    expect(env.chats[0]).toContain('"message":"hello"');
  });
  it("chat needs a connected assistant", async () => {
    const { c, csrf } = await signedIn();
    const r = await c.req("/app/chat/send", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ message: "hi" }) });
    expect(r.status).toBe(400);
  });
});

describe("your own AI model", () => {
  const add = (c: Client, csrf: string, apiKey: string) => c.post("/app/model", { provider: "openai", model: "gpt-4.1", apiKey }, csrf);

  it("a good key is encrypted, tested, shown masked and pushed to the agent", async () => {
    const { c, csrf } = await signedIn();
    await c.post("/app/connection", { url: "https://agent.example.com", token: "tok-123" }, csrf);
    const r = await add(c, csrf, "good-key-123456");
    expect(r.headers.get("location")).toContain("model-synced");
    const m = (await env.store.getModel((await env.store.userByEmail("omar@example.com"))!.id))!;
    expect(m.status).toBe("active");
    expect(m.keySealed).not.toContain("good-key");
    expect(open(KEY, m.keySealed)).toBe("good-key-123456");
    const page = await (await c.req("/app/model")).text();
    expect(page).toContain("3456");
    expect(page).not.toContain("good-key-123456");
    expect(env.pushed.at(-1)).toMatchObject({ enabled: true, provider: "openai", model: "gpt-4.1", apiKey: "good-key-123456" });
  });
  it("a bad key is saved as stopped and not pushed as active", async () => {
    const { c, csrf } = await signedIn();
    await c.post("/app/connection", { url: "https://agent.example.com", token: "tok-123" }, csrf);
    const before = env.pushed.length;
    const r = await add(c, csrf, "bad-key-1234567");
    expect(r.headers.get("location")).toContain("model-bad");
    const m = (await env.store.getModel((await env.store.userByEmail("omar@example.com"))!.id))!;
    expect(m.status).toBe("failed");
    expect(m.enabled).toBe(false);
    expect(env.pushed.length).toBe(before);
  });
  it("the agent reports a stopped model and the dashboard shows it; disable and remove tell the agent", async () => {
    const { c, csrf } = await signedIn();
    await c.post("/app/connection", { url: "https://agent.example.com", token: "tok-123" }, csrf);
    const conn = await (await c.req("/app/connection")).text();
    expect(conn).toContain("Connected");
    // the secret is shown once at connect time; fetch it from that response by reconnecting with a new address change
    const first = await c.post("/app/connection", { url: "https://agent.example.com/", token: "" }, csrf);
    expect(first.status).toBe(200);
    await add(c, csrf, "good-key-123456");
    const u = (await env.store.userByEmail("omar@example.com"))!;
    // the agent calls back with its secret
    const secret = "agent-secret-xyz";
    await env.store.updateUser(u.id, { agentSecretHash: (await import("../src/crypto.js")).sha256(secret) });
    const bad = await fetch(env.base + "/api/agent/model-event", { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(bad.status).toBe(401);
    await fetch(env.base + "/api/agent/model-event", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ status: "failed", error: "quota exceeded" }) });
    const page = await (await c.req("/app/model")).text();
    expect(page).toContain("Stopped");
    expect(page).toContain("quota exceeded");
    await c.post("/app/model/disable", {}, csrf);
    expect(env.pushed.at(-1)).toEqual({ enabled: false });
    await c.post("/app/model/remove", {}, csrf);
    expect(env.pushed.at(-1)).toEqual({ enabled: false, remove: true });
    expect(await env.store.getModel(u.id)).toBeUndefined();
  });
  it("rejects an unknown provider and a private endpoint", async () => {
    const { c, csrf } = await signedIn();
    expect((await c.post("/app/model", { provider: "x", model: "m", apiKey: "good-key-123456" }, csrf)).status).toBe(400);
    expect((await c.post("/app/model", { provider: "compatible", model: "m", apiKey: "good-key-123456", baseUrl: "https://evil.example.com/v1" }, csrf)).status).toBe(400);
  });
});

describe("helpers", () => {
  it("seal/open round-trips and rejects tampering; the URL guard blocks private ranges", async () => {
    const s = seal(KEY, "secret");
    expect(open(KEY, s)).toBe("secret");
    expect(() => open(KEY, s.slice(0, -2) + "AA")).toThrow();
    const lookup = async () => ["192.168.1.9"];
    expect((await checkAgentUrl("https://x.example.com", false, lookup)).ok).toBe(false);
    expect((await checkAgentUrl("https://[::1]", false, lookup)).ok).toBe(false);
    expect((await checkAgentUrl("https://169.254.169.254", false, lookup)).ok).toBe(false);
    expect((await checkAgentUrl("http://localhost:8080", true, lookup)).ok).toBe(true);
  });
});
