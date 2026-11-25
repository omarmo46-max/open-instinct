import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { Scheduler } from "../src/scheduler.js";
import {
  DEFAULT_TRIGGERS,
  TriggerEngine,
  inQuietHours,
  looksLikeFlight,
  looksLikeTravelChange,
  resolveTriggers,
  sanitizeExternal,
  scanCron,
  type CalendarEvent,
  type CalendarRead,
  type MailItem,
} from "../src/triggers.js";
import type { TriggersConfig } from "../src/types.js";
import { tempState } from "./helpers.js";

const TZ = "Africa/Cairo"; // UTC+2 in winter
const NOON = new Date("2026-11-25T10:00:00Z"); // 12:00 Cairo

function ev(p: Partial<CalendarEvent> & { id: string; summary: string; start: string }): CalendarEvent {
  return { allDay: false, status: "confirmed", ...p };
}

function setup(opts: { events?: CalendarEvent[]; complete?: boolean; mail?: MailItem[]; now?: Date; cfg?: Partial<TriggersConfig>; sendOk?: boolean; lang?: "en" | "ar" } = {}) {
  const state = tempState();
  const audit = new AuditLog(state);
  const box = { now: opts.now ?? NOON, events: opts.events ?? [], complete: opts.complete ?? true, mail: opts.mail ?? [], sendOk: opts.sendOk ?? true, calendarThrows: false };
  const sent: string[] = [];
  const engine = new TriggerEngine({
    source: {
      calendar: async (): Promise<CalendarRead> => {
        if (box.calendarThrows) throw new Error("composio down");
        return { events: box.events, complete: box.complete };
      },
      mail: async () => box.mail,
    },
    state,
    audit,
    config: { ...DEFAULT_TRIGGERS, enabled: true, ...(opts.cfg ?? {}) },
    timezone: TZ,
    language: () => opts.lang ?? "en",
    send: async (text) => {
      if (!box.sendOk) return false;
      sent.push(text);
      return true;
    },
    now: () => box.now,
  });
  return { engine, box, sent, audit };
}

describe("config", () => {
  it("is off by default and clamps bad values", () => {
    expect(resolveTriggers(undefined).enabled).toBe(false);
    const c = resolveTriggers({ enabled: true, intervalMinutes: 1, maxPerRun: 999, quietFrom: "25:99" });
    expect(c).toMatchObject({ enabled: true, intervalMinutes: 5, maxPerRun: 20, quietFrom: "23:00" });
  });
  it("lets env win", () => {
    expect(resolveTriggers({ enabled: true }, { INSTINCT_TRIGGERS: "0" }).enabled).toBe(false);
    expect(resolveTriggers({}, { INSTINCT_TRIGGERS: "yes", INSTINCT_QUIET_HOURS: "22:30-06:15" })).toMatchObject({ enabled: true, quietFrom: "22:30", quietTo: "06:15" });
  });
  it("builds a valid cron", () => {
    expect(scanCron(30)).toBe("*/30 * * * *");
    expect(scanCron(7)).toBe("*/30 * * * *");
    expect(scanCron(120)).toBe("0 */2 * * *");
  });
});

describe("quiet hours", () => {
  it("wraps midnight in the owner's zone", () => {
    expect(inQuietHours(new Date("2026-11-25T21:30:00Z"), TZ, "23:00", "07:00")).toBe(true); // 23:30 Cairo
    expect(inQuietHours(new Date("2026-11-25T10:00:00Z"), TZ, "23:00", "07:00")).toBe(false);
    expect(inQuietHours(new Date("2026-11-25T04:00:00Z"), TZ, "23:00", "07:00")).toBe(true); // 06:00 Cairo
    expect(inQuietHours(NOON, TZ, "08:00", "08:00")).toBe(false);
  });
});

describe("heuristics and text hygiene", () => {
  it("spots flights and travel mail", () => {
    expect(looksLikeFlight(ev({ id: "1", summary: "CAI → DXB", start: "2026-12-01T08:00:00Z" }))).toBe(true);
    expect(looksLikeFlight(ev({ id: "1", summary: "Flight MS985", start: "2026-12-01T08:00:00Z" }))).toBe(true);
    expect(looksLikeFlight(ev({ id: "1", summary: "رحلة طيران للأقصر", start: "2026-12-01T08:00:00Z" }))).toBe(true);
    expect(looksLikeFlight(ev({ id: "1", summary: "Flight", start: "2026-12-01", allDay: true }))).toBe(false);
    expect(looksLikeFlight(ev({ id: "1", summary: "Team lunch", start: "2026-12-01T08:00:00Z" }))).toBe(false);
    expect(looksLikeTravelChange("Your flight has been cancelled")).toBe(true);
    expect(looksLikeTravelChange("Schedule change for booking X1")).toBe(true);
    expect(looksLikeTravelChange("تم تأجيل رحلتك")).toBe(true);
    expect(looksLikeTravelChange("Weekly newsletter")).toBe(false);
  });
  it("cleans outside text", () => {
    expect(sanitizeExternal("Hi\u202Eevil\n\tline\u0000 «x»")).toBe('Hi evil line "x"');
    expect(sanitizeExternal("a".repeat(300)).length).toBe(120);
  });
});

describe("invites", () => {
  const invite = ev({ id: "i1", summary: "Design review", start: "2026-11-27T10:00:00Z", selfResponse: "needsAction" });
  it("alerts once for an unanswered invite and again when it is close", async () => {
    const { engine, box, sent } = setup({ events: [invite] });
    expect((await engine.run()).sent).toBe(1);
    expect(sent[0]).toContain("Design review");
    expect((await engine.run()).sent).toBe(0); // deduped
    box.now = new Date("2026-11-26T12:00:00Z"); // 22h before
    expect((await engine.run()).sent).toBe(1);
    expect(sent[1]).toContain("Reminder");
  });
  it("ignores answered, own, cancelled, far and all-day events", async () => {
    const { engine, sent } = setup({
      events: [
        { ...invite, id: "a", selfResponse: "accepted" },
        { ...invite, id: "b", organizerSelf: true },
        { ...invite, id: "c", status: "cancelled" },
        { ...invite, id: "d", start: "2026-12-20T10:00:00Z" },
        { ...invite, id: "e", allDay: true, start: "2026-11-27" },
      ],
    });
    expect((await engine.run()).detected).toBe(0);
    expect(sent).toEqual([]);
  });
  it("writes Arabic when asked", async () => {
    const { engine, sent } = setup({ events: [invite], lang: "ar" });
    await engine.run();
    expect(sent[0]).toContain("عندك دعوة مستنية ردك");
  });
});

describe("birthdays", () => {
  it("alerts the day before and the day of, once each", async () => {
    const b = ev({ id: "b1", summary: "Mona's birthday", start: "2026-11-26", allDay: true, eventType: "birthday" });
    const { engine, box, sent } = setup({ events: [b] });
    await engine.run();
    expect(sent[0]).toContain("Tomorrow");
    await engine.run();
    expect(sent).toHaveLength(1);
    box.now = new Date("2026-11-26T08:00:00Z");
    await engine.run();
    expect(sent[1]).toContain("Today");
  });
  it("ignores a birthday a week away", async () => {
    const { engine } = setup({ events: [ev({ id: "b2", summary: "Ali birthday", start: "2026-12-03", allDay: true })] });
    expect((await engine.run()).detected).toBe(0);
  });
});

describe("flights", () => {
  const flight = ev({ id: "f1", summary: "Flight MS985 CAI → DXB", start: "2026-12-02T08:00:00Z" });
  it("takes a baseline first, then alerts on a time change, once", async () => {
    const { engine, box, sent } = setup({ events: [flight] });
    expect((await engine.run()).detected).toBe(0); // baseline
    box.events = [{ ...flight, start: "2026-12-02T11:30:00Z" }];
    expect((await engine.run()).sent).toBe(1);
    expect(sent[0]).toContain("changed");
    expect((await engine.run()).detected).toBe(0); // new baseline, nothing repeats
  });
  it("alerts when the event is cancelled", async () => {
    const { engine, box, sent } = setup({ events: [flight] });
    await engine.run();
    box.events = [{ ...flight, status: "cancelled" }];
    await engine.run();
    expect(sent[0]).toContain("cancelled");
  });
  it("claims a missing flight only after a complete read", async () => {
    const { engine, box, sent } = setup({ events: [flight] });
    await engine.run();
    box.events = [];
    box.complete = false;
    expect((await engine.run()).detected).toBe(0);
    box.complete = true;
    await engine.run();
    expect(sent[0]).toContain("can no longer find");
  });
  it("keeps a held change until quiet hours end, even though the baseline moved", async () => {
    const { engine, box, sent } = setup({ events: [flight], now: new Date("2026-11-25T10:00:00Z") });
    await engine.run();
    box.events = [{ ...flight, start: "2026-12-02T11:30:00Z" }];
    box.now = new Date("2026-11-25T22:00:00Z"); // 00:00 Cairo, quiet, flight far away
    const held = await engine.run();
    expect(held).toMatchObject({ sent: 0, held: 1 });
    box.now = new Date("2026-11-26T06:00:00Z"); // 08:00 Cairo
    expect((await engine.run()).sent).toBe(1);
    expect(sent[0]).toContain("changed");
  });
  it("sends an urgent flight alert inside quiet hours", async () => {
    const soon = ev({ id: "f2", summary: "Flight XY1", start: "2026-11-26T02:00:00Z" });
    const { engine, box, sent } = setup({ events: [soon], now: new Date("2026-11-25T22:00:00Z") });
    await engine.run();
    box.events = [{ ...soon, start: "2026-11-26T05:00:00Z" }];
    expect((await engine.run()).sent).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe("travel mail", () => {
  it("flags a suspicious-looking subject once and never echoes control characters", async () => {
    const { engine, sent } = setup({ mail: [{ id: "m1", subject: "Your flight was cancelled\u202E!", from: "Air <no-reply@air.example>", at: "2026-11-25T08:00:00Z" }, { id: "m2", subject: "Lunch?", from: "a@b.c", at: "2026-11-25T08:00:00Z" }] });
    await engine.run();
    await engine.run();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("\u202E");
    expect(sent[0]).toContain("did not open it");
  });
});

describe("delivery", () => {
  it("keeps an alert when sending fails and retries it", async () => {
    const { engine, box, sent } = setup({ events: [ev({ id: "i1", summary: "Sync", start: "2026-11-27T10:00:00Z", selfResponse: "needsAction" })], sendOk: false });
    expect(await engine.run()).toMatchObject({ sent: 0, failed: true });
    box.sendOk = true;
    expect((await engine.run()).sent).toBe(1);
    expect(sent).toHaveLength(1);
  });
  it("caps one scan and sends the rest next time", async () => {
    const events = [1, 2, 3, 4].map((i) => ev({ id: `i${i}`, summary: `M${i}`, start: "2026-11-27T10:00:00Z", selfResponse: "needsAction" }));
    const { engine, sent } = setup({ events, cfg: { maxPerRun: 3 } });
    expect(await engine.run()).toMatchObject({ sent: 3, held: 1 });
    await engine.run();
    expect(sent).toHaveLength(4);
  });
  it("survives a failing source and says so in the audit log", async () => {
    const { engine, box, audit } = setup();
    box.calendarThrows = true;
    expect(await engine.run()).toMatchObject({ sent: 0, failed: false });
    expect(audit.read({ kinds: ["error"] }).some((e) => String(e.detail.message).includes("calendar read failed"))).toBe(true);
  });
  it("ignores a second scan that starts while one runs", async () => {
    const { engine } = setup();
    const [a, b] = await Promise.all([engine.run(), engine.run()]);
    expect([a.skipped, b.skipped].filter(Boolean)).toEqual(["busy"]);
  });
});

describe("scheduler.ensureSystem", () => {
  it("creates once, refreshes on change, keeps the id", () => {
    const s = new Scheduler(tempState(), { now: () => NOON });
    const a = s.ensureSystem({ id: "s_triggers", name: "Triggers", cron: "*/30 * * * *", tz: TZ, prompt: "(internal)", task: "triggers.scan" });
    const b = s.ensureSystem({ id: "s_triggers", name: "Triggers", cron: "*/30 * * * *", tz: TZ, prompt: "(internal)", task: "triggers.scan" });
    expect(b).toEqual(a);
    const c = s.ensureSystem({ id: "s_triggers", name: "Triggers", cron: "0 * * * *", tz: TZ, prompt: "(internal)", task: "triggers.scan" });
    expect(c.cron).toBe("0 * * * *");
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]?.task).toBe("triggers.scan");
  });
});
