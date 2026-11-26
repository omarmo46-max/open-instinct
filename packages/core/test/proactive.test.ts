import { describe, expect, it } from "vitest";
import { HabitStore } from "../src/habits.js";
import { MemoryStore } from "../src/memory.js";
import { MemorySearch, chunkMemory, normalizeText, openAIEmbedder, tokenize, type Embedder } from "../src/memory-search.js";
import { PlaceStore, distanceM } from "../src/places.js";
import { PreferenceStore, renderBrief } from "../src/preferences.js";
import { LocationService, proactiveTools } from "../src/proactive-tools.js";
import { Scheduler } from "../src/scheduler.js";
import { tempState } from "./helpers.js";

const TZ = "Africa/Cairo";

describe("B2 habits", () => {
  it("stays unsure until there is enough data", () => {
    const h = new HabitStore(tempState(), TZ);
    h.record(new Date("2026-11-20T10:00:00Z"));
    expect(h.sleepWindow().confident).toBe(false);
  });
  it("finds the quiet stretch from message hours", () => {
    const h = new HabitStore(tempState(), TZ);
    for (let d = 1; d <= 10; d++) {
      for (const hour of [8, 9, 11, 13, 15, 17, 19, 21, 22]) {
        for (let n = 0; n < 2; n++) h.record(new Date(Date.UTC(2026, 10, d, hour - 2, n * 5))); // local = hour
      }
    }
    const w = h.sleepWindow();
    expect(w.confident).toBe(true);
    // local hours 23..06 have no messages: the 7-hour window starts at 23:00 or 00:00
    expect(["23:00", "00:00"]).toContain(w.from);
    expect(h.summary().days).toBe(10);
  });
  it("stores hours and day counts only, never text", () => {
    const s = tempState();
    new HabitStore(s, TZ).record(new Date("2026-11-20T10:00:00Z"));
    expect(Object.keys(s.readJson<object>("habits.json", {})).sort()).toEqual(["days", "hours", "version"]);
  });
});

describe("B2 scheduler hold", () => {
  it("keeps a held job due and fires it after the hold ends", async () => {
    const s = new Scheduler(tempState(), { now: () => new Date("2026-11-25T10:00:00Z") });
    const e = s.create({ name: "brief", prompt: "p", enabled: true, tz: TZ, nextRunAt: "2026-11-25T09:00:00Z", waitForWake: true });
    const fired: string[] = [];
    let asleep = true;
    const stop = s.start(async (x) => void fired.push(x.id), 10, (x) => x.waitForWake === true && asleep);
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toEqual([]);
    asleep = false;
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(fired).toEqual([e.id]);
  });
});

describe("B3 memory search", () => {
  it("normalizes Arabic spelling and the article", () => {
    expect(normalizeText("الإيميل")).toBe(normalizeText("الايميل"));
    expect(tokenize("الفندق في القاهرة")).toEqual(expect.arrayContaining(["فندق", "قاهره"]));
  });
  it("chunks lines with their heading and journal bullets", () => {
    const c = chunkMemory("# Memory\n## Travel\n- likes aisle seats\n", [{ date: "2026-11-01", text: "# 2026-11-01\n\n- 09:00 booked Hotel Nile\n" }]);
    expect(c).toEqual([{ text: "Travel: likes aisle seats", source: "MEMORY.md" }, { text: "09:00 booked Hotel Nile", source: "2026-11-01" }]);
  });
  function setup(embedder?: Embedder) {
    const state = tempState();
    const memory = new MemoryStore(state);
    memory.replaceDurable("# Memory\n## People\n- Mona is my sister, lives in Alexandria\n- Dentist is Dr Hany, appointments on Sundays\n## Travel\n- prefers hotels near the metro\n");
    memory.appendJournal("booked a flight to Dubai for the conference", new Date("2026-11-20T09:00:00Z"));
    return { state, search: new MemorySearch(state, memory, embedder) };
  }
  it("finds by words when no embedder is set", async () => {
    const { search } = setup();
    const r = await search.search("my sister Mona", 3);
    expect(r.mode).toBe("lexical");
    expect(r.hits[0]?.text).toContain("Mona");
    expect((await search.search("zzzz nothing", 3)).hits).toEqual([]);
  });
  it("finds by meaning with an embedder, caches vectors, and falls back on failure", async () => {
    let calls = 0;
    // A tiny fake "meaning space": dentist/teeth share a dimension, sister/sibling another.
    const dims = (t: string): number[] => [/dentist|teeth|tooth|hany/i.test(t) ? 1 : 0, /sister|sibling|mona/i.test(t) ? 1 : 0, /flight|dubai|trip/i.test(t) ? 1 : 0, 0.01];
    const emb: Embedder = { model: "fake", embed: async (texts) => (calls++, texts.map(dims)) };
    const { search, state } = setup(emb);
    const r = await search.search("who fixes my teeth", 2);
    expect(r.mode).toBe("semantic");
    expect(r.hits[0]?.text).toContain("Dentist");
    const first = calls;
    await search.search("my sibling", 2);
    expect(calls).toBe(first + 1); // only the new query was embedded; chunk vectors came from the cache
    expect(Object.keys(state.readJson<{ items: object }>("memory/embeddings.json", { items: {} }).items).length).toBeGreaterThan(2);
    const broken = new MemorySearch(state, new MemoryStore(state), { model: "fake", embed: async () => { throw new Error("down"); } });
    const fb = await broken.search("sister", 2);
    expect(fb.mode).toBe("lexical");
    expect(fb.note).toContain("unavailable");
  });
  it("parses an OpenAI-style embeddings response and rejects a bad one", async () => {
    const ok = openAIEmbedder({ apiKey: "k", fetchImpl: (async () => new Response(JSON.stringify({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }))) as typeof fetch });
    expect(await ok.embed(["a", "b"])).toEqual([[1], [2]]);
    const bad = openAIEmbedder({ apiKey: "k", fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch });
    await expect(bad.embed(["a"])).rejects.toThrow("HTTP 500");
  });
});

describe("B4 preferences", () => {
  it("a stated preference wins at once; repeated choices become learned", () => {
    const p = new PreferenceStore(tempState());
    p.note("flight", "seat", "window", true);
    expect(p.brief("flight").apply).toEqual([{ key: "flight.seat", value: "window", how: "stated" }]);
    for (let i = 0; i < 3; i++) p.note("hotel", "area", "near metro", false);
    expect(p.brief("hotel").apply[0]).toMatchObject({ value: "near metro", how: "learned" });
  });
  it("mixed choices are undecided and the newest statement replaces an old one", () => {
    const p = new PreferenceStore(tempState());
    for (const v of ["aisle", "window", "aisle", "window"]) p.note("flight", "seat", v, false);
    expect(p.brief("flight")).toMatchObject({ apply: [], undecided: [{ key: "flight.seat", values: expect.arrayContaining(["aisle", "window"]) }] });
    p.note("flight", "seat", "aisle", true);
    p.note("flight", "seat", "window", true);
    expect(p.brief("flight").apply[0]?.value).toBe("window");
  });
  it("forgets, validates and renders", () => {
    const p = new PreferenceStore(tempState());
    expect(() => p.note("", "", "x", true)).toThrow();
    p.note("hotel", "wifi", "required", true);
    p.note("hotel", "view", "sea", true);
    expect(p.forget("hotel", "wifi")).toBe(1);
    expect(p.forget("hotel")).toBe(1);
    expect(renderBrief(p.brief("hotel"))).toContain("No saved preferences");
  });
});

describe("B5 places", () => {
  const CAIRO = { lat: 30.0444, lon: 31.2357 };
  it("computes distance and detects arrive and leave with hysteresis", () => {
    expect(Math.round(distanceM(30, 31, 30, 31.001))).toBeGreaterThan(90);
    const s = new PlaceStore(tempState());
    s.savePlace("Home", CAIRO.lat, CAIRO.lon, 100);
    expect(s.fix(CAIRO.lat + 0.01, CAIRO.lon)).toEqual([]);
    expect(s.fix(CAIRO.lat, CAIRO.lon, 20).map((e) => e.kind)).toEqual(["arrive"]);
    expect(s.fix(CAIRO.lat + 0.0011, CAIRO.lon)).toEqual([]); // 122 m: outside 100 m but inside the 130 m leave margin
    expect(s.fix(CAIRO.lat + 0.003, CAIRO.lon).map((e) => e.kind)).toEqual(["leave"]);
    expect(s.fix(CAIRO.lat, CAIRO.lon, 900)).toEqual([]); // poor accuracy ignored
  });
  it("fires an arrival reminder once and keeps it when the message fails", async () => {
    const s = new PlaceStore(tempState());
    s.savePlace("Pharmacy", 30.05, 31.24);
    s.addReminder("pharmacy", "buy vitamin D");
    let ok = false;
    const sent: string[] = [];
    const svc = new LocationService(s, async (t) => (ok ? (sent.push(t), true) : false));
    expect(await svc.ingest({ place: "Pharmacy", event: "arrive" })).toMatchObject({ ok: true, events: 1, fired: 0 });
    expect(s.listReminders()).toHaveLength(1); // kept
    await svc.ingest({ place: "Pharmacy", event: "leave" });
    ok = true;
    await svc.ingest({ place: "Pharmacy", event: "arrive" });
    expect(sent[0]).toContain("buy vitamin D");
    expect(s.listReminders()).toHaveLength(0);
  });
  it("rejects bad input and unknown places, and clears history", async () => {
    const s = new PlaceStore(tempState());
    const svc = new LocationService(s, async () => true);
    expect((await svc.ingest({ foo: 1 })).ok).toBe(false);
    expect((await svc.ingest({ place: "Nowhere", event: "arrive" })).error).toContain("unknown place");
    expect((await svc.ingest({ lat: 999, lon: 0 })).ok).toBe(false);
    s.savePlace("Home", 1, 1);
    s.fix(1, 1);
    s.clearHistory();
    expect(s.whereAmI().inside).toEqual([]);
    expect(s.removePlace("home")).toBe(true);
  });
});

describe("proactive tools", () => {
  it("registers owner-only tools; location tools only when places exist", () => {
    const state = tempState();
    const base = { search: new MemorySearch(state, new MemoryStore(state)), prefs: new PreferenceStore(state) };
    const names = (t: ReturnType<typeof proactiveTools>) => t.map((x) => x.spec.name);
    expect(names(proactiveTools(base))).toEqual(["memory_search", "preference_note", "booking_brief", "preference_forget"]);
    const all = proactiveTools({ ...base, places: new PlaceStore(state) });
    expect(names(all)).toContain("arrival_reminder");
    expect(all.every((t) => (t.spec.meta?.capabilities ?? []).join() === "memory.write")).toBe(true);
  });
});
