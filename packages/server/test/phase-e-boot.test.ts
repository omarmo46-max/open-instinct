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
    dir = mkdtempSync(join(tmpdir(), "instinct-phase-e-"));
  });
  afterEach(async () => {
    await close?.();
    await app?.close();
    app = undefined;
    close = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(extra: NodeJS.ProcessEnv) {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const streamFn = models.streamSimple.bind(models) as unknown as StreamFn;
    app = await boot(
      { INSTINCT_DATA_DIR: dir, INSTINCT_OWNER_NAME: "Omar", INSTINCT_OWNER_PHONE: "+14155550000", INSTINCT_AGENT_NAME: "T", INSTINCT_MODEL: "faux/faux-1", INSTINCT_COMPUTER: "none", INSTINCT_SKILLS_DIR: join(dir, "none"), INSTINCT_PUBLIC_URL: "https://agent.example", ...extra } as NodeJS.ProcessEnv,
      { model: faux.getModel("faux-1"), streamFn, logger: () => {} },
    );
    const server = createHttpServer(app, { env: {} });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    close = () => new Promise((r) => server.close(() => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const names = () => (app!.runtime as any).deps.registry.all().map((t: any) => t.spec.name);

  it("E5: with INSTINCT_PAGES=1 the tools exist, a page is created and voted on over HTTP", async () => {
    const base = await start({ INSTINCT_PAGES: "1" });
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

  it("E5: without INSTINCT_PAGES=1 there are no page tools and /p/ is not served", async () => {
    const base = await start({});
    expect(names()).not.toContain("page_create");
    expect((await fetch(base + "/p/pg_abcdefabcdef")).status).not.toBe(200);
  });

  it("E6 and E1/E2 tools are registered by default; phone_call is still there", async () => {
    await start({ INKBOX_API_KEY: "ik", INKBOX_AGENT_HANDLE: "t-instinct", INKBOX_BASE_URL: "https://inkbox.test" }).catch(() => undefined);
    expect(names()).toEqual(expect.arrayContaining(["partner_list", "partner_request", "partner_confirm"]));
  });
});
