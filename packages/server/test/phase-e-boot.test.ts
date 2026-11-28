import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { boot, type BootResult } from "../src/boot.js";
import { createHttpServer } from "../src/http.js";

/** The real boot with Phase E switched on: tools are registered and the public page is reachable over HTTP. */
describe("phase E boots and serves", () => {
  let dir: string;
  let app: BootResult | undefined;
  let close: (() => Promise<void>) | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orion-phase-e-"));
  });
  afterEach(async () => {
    await close?.();
    await app?.close();
    app = undefined;
    close = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(extra: NodeJS.ProcessEnv, httpEnv: NodeJS.ProcessEnv = {}) {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const streamFn = models.streamSimple.bind(models) as unknown as StreamFn;
    app = await boot(
      { ORION_DATA_DIR: dir, ORION_OWNER_NAME: "Omar", ORION_OWNER_PHONE: "+14155550000", ORION_AGENT_NAME: "T", ORION_MODEL: "faux/faux-1", ORION_COMPUTER: "none", ORION_SKILLS_DIR: join(dir, "none"), ORION_PUBLIC_URL: "https://agent.example", ...extra } as NodeJS.ProcessEnv,
      { model: faux.getModel("faux-1"), streamFn, logger: () => {} },
    );
    const server = createHttpServer(app, { env: httpEnv });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    close = () => new Promise((r) => server.close(() => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const names = () => (app!.runtime as any).deps.registry.all().map((t: any) => t.spec.name);

  it("E5: with ORION_PAGES=1 the tools exist, a page is created and voted on over HTTP", async () => {
    const base = await start({ ORION_PAGES: "1" });
    expect(names()).toEqual(expect.arrayContaining(["page_create", "page_results", "page_close"]));
    const create = (app!.runtime as any).deps.registry.all().find((t: any) => t.spec.name === "page_create")!.spec as any;
    const r = await create.execute({ kind: "poll", title: "Dinner?", options: ["Pizza", "Sushi"], lang: "en" }, { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Omar" }, conversationKey: "k", channel: "imessage" });
    const link = /https:\/\/agent\.example(\/p\/pg_[\w-]+)/.exec(r.content[0].text)![1]!;
    const page = await fetch(base + link);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Dinner?");
    const vote = await fetch(base + link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "choice=Pizza" });
    expect(vote.status).toBe(200);
    expect(await vote.text()).toContain("Pizza: 1");
    expect((await fetch(base + "/p/pg_doesnotexist1")).status).toBe(404);
  });

  it("E5: without ORION_PAGES=1 there are no page tools and /p/ is not served", async () => {
    const base = await start({});
    expect(names()).not.toContain("page_create");
    expect((await fetch(base + "/p/pg_abcdefabcdef")).status).not.toBe(200);
  });

  it("E6 and E1/E2 tools are registered by default; phone_call is still there", async () => {
    await start({ INKBOX_API_KEY: "ik", INKBOX_AGENT_HANDLE: "t-orion", INKBOX_BASE_URL: "https://inkbox.test" }).catch(() => undefined);
    expect(names()).toEqual(expect.arrayContaining(["partner_list", "partner_request", "partner_confirm"]));
  });

  it("custom model: PUT /model needs the owner token, stores the key privately and never returns it", async () => {
    const base = await start({}, { ORION_CHAT_TOKEN: "owner-token-123" });
    const body = JSON.stringify({ enabled: true, provider: "openai", model: "gpt-4.1", apiKey: "sk-private-key-123456" });
    expect((await fetch(base + "/model", { method: "PUT", body })).status).toBe(401);
    const ok = await fetch(base + "/model", { method: "PUT", body, headers: { "x-orion-token": "owner-token-123" } });
    expect(ok.status).toBe(200);
    const got = await fetch(base + "/model", { headers: { "x-orion-token": "owner-token-123" } });
    const text = await got.text();
    expect(JSON.parse(text)).toMatchObject({ enabled: true, provider: "openai", model: "gpt-4.1", status: "active" });
    expect(text).not.toContain("sk-private-key");
    const bad = await fetch(base + "/model", { method: "PUT", body: JSON.stringify({ provider: "nope", model: "m", apiKey: "sk-private-key-123456" }), headers: { "x-orion-token": "owner-token-123" } });
    expect(bad.status).toBe(400);
    const off = await fetch(base + "/model", { method: "PUT", body: JSON.stringify({ remove: true }), headers: { "x-orion-token": "owner-token-123" } });
    expect(off.status).toBe(200);
    expect(await (await fetch(base + "/model", { headers: { "x-orion-token": "owner-token-123" } })).json()).toEqual({ enabled: false });
  });

  it("owner API: needs the owner token and answers on the real boot", async () => {
    const base = await start({}, { ORION_CHAT_TOKEN: "owner-token-123" });
    expect((await fetch(base + "/owner/overview")).status).toBe(401);
    const h = { "x-orion-token": "owner-token-123" };
    for (const r of ["overview", "people", "approvals", "activity", "schedules", "memory", "skills", "pages", "apps", "channels", "payments", "security"]) {
      const res = await fetch(`${base}/owner/${r}`, { headers: h });
      expect(res.status, r).toBe(200);
    }
    expect((await fetch(base + "/owner/nope", { headers: h })).status).toBe(404);
    const ov = (await (await fetch(base + "/owner/overview", { headers: h })).json()) as { owner: string; auditChainOk: boolean };
    expect(ov.owner).toBe("Omar");
    expect(ov.auditChainOk).toBe(true);
  });
});
