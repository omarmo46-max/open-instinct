import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CustomModelStore, createFailoverStreamFn } from "../src/custom-model.js";

const KEY = "sk-secret-key-123456";
const msg = (text: string, errorMessage?: string) => ({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: {}, stopReason: errorMessage ? "error" : "stop", timestamp: 0, ...(errorMessage ? { errorMessage } : {}) }) as never;

/** A fake provider: the default model always answers "default"; the custom model answers or fails as told. */
function fakeBase(mode: { custom: "ok" | "error" | "throw" | "late-error" }, seen: Array<{ model: string; apiKey?: string }>) {
  return ((model: { id: string }, _ctx: unknown, options?: { apiKey?: string }) => {
    seen.push({ model: model.id, ...(options?.apiKey ? { apiKey: options.apiKey } : {}) });
    if (model.id === "gpt-custom" && mode.custom === "throw") throw new Error(`network down for ${KEY}`);
    const s = createAssistantMessageEventStream();
    const text = model.id === "gpt-custom" ? "custom" : "default";
    queueMicrotask(() => {
      if (model.id === "gpt-custom" && mode.custom === "error") return s.push({ type: "error", reason: "error", error: msg("", `401 invalid key ${KEY}`) } as AssistantMessageEvent);
      s.push({ type: "start", partial: msg("") } as AssistantMessageEvent);
      if (model.id === "gpt-custom" && mode.custom === "late-error") return s.push({ type: "error", reason: "error", error: msg("", "late failure") } as AssistantMessageEvent) as never;
      s.push({ type: "text_start", contentIndex: 0, partial: msg(text) } as AssistantMessageEvent);
      s.push({ type: "done", reason: "stop", message: msg(text) } as AssistantMessageEvent);
    });
    return s;
  }) as never;
}

async function run(fn: any, model = { id: "default-model" }) {
  const events: AssistantMessageEvent[] = [];
  for await (const e of (await fn(model, {}, {})) as AsyncIterable<AssistantMessageEvent>) events.push(e);
  const done = events.find((e) => e.type === "done") as { message: { content: Array<{ text: string }> } } | undefined;
  return { events, text: done?.message.content[0]?.text };
}

function setup(mode: Parameters<typeof fakeBase>[0], clock = { t: new Date("2026-11-28T10:00:00Z") }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-model-"));
  const store = new CustomModelStore(dir);
  const seen: Array<{ model: string; apiKey?: string }> = [];
  const said: string[] = [];
  const reports: string[] = [];
  const fn = createFailoverStreamFn(fakeBase(mode, seen), store, { notifyOwner: (t) => void said.push(t), report: (s) => void reports.push(s) }, { now: () => clock.t, cooldownMs: 600_000 });
  return { store, fn, seen, said, reports, clock, dir };
}
const give = (store: CustomModelStore) => store.apply({ enabled: true, provider: "openai", model: "gpt-custom", apiKey: KEY });

describe("custom model with automatic fallback", () => {
  it("uses the default model when no custom model is set", async () => {
    const t = setup({ custom: "ok" });
    expect((await run(t.fn)).text).toBe("default");
    expect(t.seen.map((s) => s.model)).toEqual(["default-model"]);
  });

  it("uses the custom model with the custom key while it works", async () => {
    const t = setup({ custom: "ok" });
    expect(give(t.store).ok).toBe(true);
    expect((await run(t.fn)).text).toBe("custom");
    expect(t.seen[0]).toMatchObject({ model: "gpt-custom", apiKey: KEY });
    expect(t.said).toEqual([]);
  });

  it("when the custom model errors before any output, the default answers the same turn, the owner is told once and the key never leaks", async () => {
    const t = setup({ custom: "error" });
    give(t.store);
    const r = await run(t.fn);
    expect(r.text).toBe("default");
    expect(t.said).toHaveLength(1);
    expect(t.said[0]).toContain("stopped");
    expect(t.said[0]).toContain("default model");
    expect(JSON.stringify([t.said, t.reports, t.store.publicStatus()])).not.toContain(KEY);
    expect(t.store.get()?.status).toBe("failed");
    expect(t.reports).toEqual(["failed"]);
  });

  it("a provider that throws also falls back; during the cooldown the custom model is not retried and the owner is not told again", async () => {
    const t = setup({ custom: "throw" });
    give(t.store);
    expect((await run(t.fn)).text).toBe("default");
    const calls = t.seen.length;
    expect((await run(t.fn)).text).toBe("default");
    expect(t.seen.slice(calls).map((s) => s.model)).toEqual(["default-model"]); // custom skipped
    expect(t.said).toHaveLength(1);
  });

  it("after the cooldown it tries again; if it works the owner is told it is back", async () => {
    const mode = { custom: "error" as "ok" | "error" };
    const t = setup(mode as never);
    give(t.store);
    await run(t.fn);
    mode.custom = "ok";
    t.clock.t = new Date(t.clock.t.getTime() + 11 * 60_000);
    expect((await run(t.fn)).text).toBe("custom");
    expect(t.store.get()?.status).toBe("active");
    expect(t.said).toHaveLength(2);
    expect(t.said[1]).toContain("working again");
    expect(t.reports).toEqual(["failed", "active"]);
  });

  it("a still-broken model after the cooldown stays on default without telling the owner again", async () => {
    const t = setup({ custom: "error" });
    give(t.store);
    await run(t.fn);
    t.clock.t = new Date(t.clock.t.getTime() + 11 * 60_000);
    expect((await run(t.fn)).text).toBe("default");
    expect(t.said).toHaveLength(1);
  });

  it("switching to the default, or removing the key, stops using it", async () => {
    const t = setup({ custom: "ok" });
    give(t.store);
    t.store.apply({ enabled: false });
    expect((await run(t.fn)).text).toBe("default");
    give(t.store);
    t.store.apply({ remove: true });
    expect(t.store.get()).toBeUndefined();
  });

  it("validates what the dashboard sends and keeps the file private; the status never shows the key", () => {
    const t = setup({ custom: "ok" });
    expect(t.store.apply({ provider: "nope", model: "m", apiKey: KEY }).ok).toBe(false);
    expect(t.store.apply({ provider: "openai", model: "bad model!", apiKey: KEY }).ok).toBe(false);
    expect(t.store.apply({ provider: "openai", model: "m", apiKey: "short" }).ok).toBe(false);
    expect(t.store.apply({ provider: "compatible", model: "m", apiKey: KEY }).ok).toBe(false); // needs an endpoint
    give(t.store);
    expect(JSON.stringify(t.store.publicStatus())).not.toContain(KEY);
    expect(fs.statSync(path.join(t.dir, "custom-model.json")).mode & 0o777).toBe(0o600);
  });
});
