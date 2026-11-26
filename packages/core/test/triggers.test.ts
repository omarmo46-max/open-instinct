import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { TriggerPrefs } from "../src/trigger-prefs.js";
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

function setup(opts: { events?: CalendarEvent[]; complete?: boolean; mail?: MailItem[]; now?: Date; cfg?: Partial<TriggersConfig>; sendOk?: boolean; lang?: "en" | "ar"; welcomed?: boolean; wide?: CalendarEvent[] } = {}) {
  const state = tempState();
  if (opts.welcomed !== false) state.writeJson("trigger-state.json", { version: 1, fired: {}, flights: {}, welcomed: true });
  const prefs = new TriggerPrefs(state);
  const audit = new AuditLog(state);
  const box = { wide: opts.wide as CalendarEvent[] | undefined, now: opts.now ?? NOON, events: opts.events ?? [], complete: opts.complete ?? true, mail: opts.mail ?? [], sendOk: opts.sendOk ?? true, calendarThrows: false };
  const sent: string[] = [];
  const engine = new TriggerEngine({
    source: {
      calendar: async (range): Promise<CalendarRead> => {
        if (box.calendarThrows) throw new Error("composio down");
        const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
        if (days > 60 && box.wide) return { events: box.wide, complete: true }; // the wide read for a vanished flight
        return { events: box.events, complete: box.complete };
      },
      mail: async () => box.mail,
    },
    state,
    audit,
    prefs,
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
  return { engine, box, sent, audit, prefs, state };
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
  const timed = (summary: string, extra: Partial<CalendarEvent> = {}) => ev({ id: "1", summary, start: "2026-12-01T08:00:00Z", ...extra });
  it("spots flights and trips from title, place and calendar type", () => {
    expect(looksLikeFlight(timed("CAI → DXB"))).toBe(true);
    expect(looksLikeFlight(timed("Flight MS985"))).toBe(true);
    expect(looksLikeFlight(timed("رحلة طيران للأقصر"))).toBe(true);
    expect(looksLikeFlight(timed("Trip to Dubai"))).toBe(true);
    expect(looksLikeFlight(timed("Pick up Sara", { location: "Cairo International Airport (CAI)" }))).toBe(true);
    expect(looksLikeFlight(timed("MS 985", { eventType: "fromGmail", location: "Cairo Airport" }))).toBe(true);
    expect(looksLikeFlight(ev({ id: "t", summary: "Trip to Alexandria", start: "2026-12-01", allDay: true }))).toBe(true);
  });
  it("rejects look-alikes", () => {
    expect(looksLikeFlight(timed("Flight club meeting"))).toBe(false);
    expect(looksLikeFlight(timed("Flight school class"))).toBe(false);
    expect(looksLikeFlight(timed("Team lunch"))).toBe(false);
    expect(looksLikeFlight(timed("اجتماع نادي الطيران"))).toBe(false);
  });
  it("spots travel mail by subject", () => {
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
  it("catches a timed birthday event and one with only the word in the title", async () => {
    const { engine, sent } = setup({ events: [ev({ id: "b3", summary: "عيد ميلاد ماما", start: "2026-11-26T15:00:00Z" })] });
    await engine.run();
    expect(sent[0]).toContain("Tomorrow");
  });
  it("lets the owner mark an event as a birthday, or say it is not", async () => {
    const odd = ev({ id: "b4", summary: "Mona 30", start: "2026-11-26", allDay: true });
    const a = setup({ events: [odd] });
    expect((await a.engine.run()).detected).toBe(0);
    a.prefs.correct("birthday", "mona 30", true);
    expect((await a.engine.run()).sent).toBe(1);
    const b = setup({ events: [ev({ id: "b5", summary: "Birthday party planning", start: "2026-11-26", allDay: true })] });
    b.prefs.correct("birthday", "Birthday party planning", false);
    expect((await b.engine.run()).detected).toBe(0);
  });
  it("ignores a birthday a week away", async () => {
    const { engine } = setup({ events: [ev({ id: "b2", summary: "Ali birthday", start: "2026-12-03", allDay: true })] });
    expect((await engine.run()).detected).toBe(0);
  });
});

describe("flights", () => {
  const flight = ev({ id: "f1", summary: "Flight MS985 CAI → DXB", start: "2026-12-02T08:00:00Z" });
  it("takes a baseline first, then alerts on a real time change, once, with the size of the move", async () => {
    const { engine, box, sent } = setup({ events: [flight] });
    expect((await engine.run()).detected).toBe(0); // baseline
    box.events = [{ ...flight, start: "2026-12-02T11:30:00Z" }];
    expect((await engine.run()).sent).toBe(1);
    expect(sent[0]).toContain("moved");
    expect(sent[0]).toContain("3 h 30 min later");
    expect((await engine.run()).detected).toBe(0);
  });
  it("ignores a small shift and the same instant written in another zone, but lets drift add up", async () => {
    const { engine, box, sent } = setup({ events: [flight], cfg: { flightChangeMinutes: 30 } });
    await engine.run();
    box.events = [{ ...flight, start: "2026-12-02T10:00:00+02:00" }]; // the same instant as 08:00Z
    expect((await engine.run()).detected).toBe(0);
    box.events = [{ ...flight, start: "2026-12-02T08:10:00Z" }];
    expect((await engine.run()).detected).toBe(0);
    box.events = [{ ...flight, start: "2026-12-02T08:35:00Z" }]; // 35 min from the original baseline
    await engine.run();
    expect(sent[0]).toContain("35 min later");
  });
  it("watches an all-day trip by date", async () => {
    const trip = ev({ id: "t1", summary: "Trip to Dubai", start: "2026-12-05", allDay: true });
    const { engine, box, sent } = setup({ events: [trip] });
    await engine.run();
    box.events = [{ ...trip, start: "2026-12-07" }];
    await engine.run();
    expect(sent[0]).toContain("2 days later");
  });
  it("alerts when the event is cancelled", async () => {
    const { engine, box, sent } = setup({ events: [flight] });
    await engine.run();
    box.events = [{ ...flight, status: "cancelled" }];
    await engine.run();
    expect(sent[0]).toContain("cancelled");
  });
  it("says it moved when a vanished plan is found later in the wide read", async () => {
    const { engine, box, sent } = setup({ events: [flight] });
    await engine.run();
    box.events = [];
    box.wide = [{ ...flight, start: "2026-12-20T08:00:00Z" }];
    await engine.run();
    expect(sent[0]).toContain("moved");
    expect(sent[0]).not.toContain("could not find");
  });
  it("says it could not find it only after a complete wide read, and never claims more", async () => {
    const { engine, box, sent } = setup({ events: [flight] });
    await engine.run();
    box.events = [];
    box.wide = [];
    box.complete = false;
    expect((await engine.run()).detected).toBe(0); // the normal read was partial
    box.complete = true;
    await engine.run();
    expect(sent[0]).toContain("could not find");
    expect(sent[0]).toContain("worth a look");
  });
  it("keeps a held change until quiet hours end, even though the baseline moved", async () => {
    const { engine, box, sent } = setup({ events: [flight], now: new Date("2026-11-25T10:00:00Z") });
    await engine.run();
    box.events = [{ ...flight, start: "2026-12-02T11:30:00Z" }];
    box.now = new Date("2026-11-25T22:00:00Z"); // 00:00 Cairo, quiet, flight far away
    expect(await engine.run()).toMatchObject({ sent: 0, held: 1 });
    box.now = new Date("2026-11-26T06:00:00Z"); // 08:00 Cairo
    expect((await engine.run()).sent).toBe(1);
    expect(sent[0]).toContain("moved");
  });
  it("sends an urgent alert inside quiet hours, and the urgency window is configurable", async () => {
    const soon = ev({ id: "f2", summary: "Flight XY1", start: "2026-11-26T02:00:00Z" });
    const a = setup({ events: [soon], now: new Date("2026-11-25T22:00:00Z") });
    await a.engine.run();
    a.box.events = [{ ...soon, start: "2026-11-26T05:00:00Z" }];
    expect((await a.engine.run()).sent).toBe(1);
    const b = setup({ events: [soon], now: new Date("2026-11-25T22:00:00Z"), cfg: { urgentFlightHours: 2 } });
    await b.engine.run();
    b.box.events = [{ ...soon, start: "2026-11-26T05:00:00Z" }];
    expect(await b.engine.run()).toMatchObject({ sent: 0, held: 1 });
  });
  it("respects the owner's correction that an event is not a trip, and one that is", async () => {
    const odd = ev({ id: "f3", summary: "Flight night", start: "2026-12-02T18:00:00Z" });
    const a = setup({ events: [odd] });
    await a.engine.run();
    a.prefs.correct("flight", "flight night", false);
    a.box.events = [{ ...odd, start: "2026-12-02T20:00:00Z" }];
    expect((await a.engine.run()).detected).toBe(0);
    const plain = ev({ id: "f4", summary: "Cairo → home", start: "2026-12-02T18:00:00Z" });
    const b = setup({ events: [plain] });
    b.prefs.correct("flight", "cairo home", true);
    await b.engine.run();
    b.box.events = [{ ...plain, start: "2026-12-02T21:00:00Z" }];
    expect((await b.engine.run()).sent).toBe(1);
  });
});

describe("travel mail", () => {
  it("flags a suspicious-looking subject once and never echoes control characters", async () => {
    const { engine, sent } = setup({ mail: [{ id: "m1", subject: "Your flight was cancelled\u202E!", from: "Air <no-reply@air.example>", at: "2026-11-25T08:00:00Z" }, { id: "m2", subject: "Lunch?", from: "a@b.c", at: "2026-11-25T08:00:00Z" }] });
    await engine.run();
    await engine.run();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("\u202E");
    expect(sent[0]).toContain("only saw the subject");
    expect(sent[0]).toContain("not a confirmation");
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
  it("groups several ordinary alerts into one message", async () => {
    const events = [1, 2, 3].map((i) => ev({ id: `i${i}`, summary: `Meeting ${i}`, start: "2026-11-27T10:00:00Z", selfResponse: "needsAction" }));
    const { engine, sent, audit } = setup({ events });
    expect(await engine.run()).toMatchObject({ sent: 3, held: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("3 things worth a look");
    expect(sent[0]).toContain("Meeting 1");
    expect(sent[0]).toContain("Meeting 3");
    expect(audit.read({ kinds: ["trigger"] }).filter((e) => e.detail.digest === true)).toHaveLength(3);
  });
  it("caps one digest and sends the rest next time; urgent ones go on their own", async () => {
    const events = [1, 2, 3, 4].map((i) => ev({ id: `i${i}`, summary: `M${i}`, start: "2026-11-27T10:00:00Z", selfResponse: "needsAction" }));
    const { engine, sent } = setup({ events, cfg: { maxPerRun: 3 } });
    expect(await engine.run()).toMatchObject({ sent: 3, held: 1 });
    await engine.run();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[1]!.includes("M4") ? sent[1] : "M4");
  });
  it("never marks an alert sent that did not fit in the digest", async () => {
    const events = Array.from({ length: 20 }, (_, i) => ev({ id: `n${i}`, summary: `Meeting ${String(i).padStart(2, "0")} ${"x".repeat(100)}`, start: "2026-11-27T10:00:00Z", selfResponse: "needsAction" }));
    const { engine, sent } = setup({ events, cfg: { maxPerRun: 20 } });
    const first = await engine.run();
    expect(first.sent).toBeLessThan(20);
    expect(first.held).toBe(20 - first.sent);
    expect(sent[0]!.length).toBeLessThanOrEqual(3600);
    while ((await engine.run()).sent > 0);
    const all = sent.join("\n");
    for (let i = 0; i < 20; i++) expect(all.split(`Meeting ${String(i).padStart(2, "0")} `).length - 1).toBe(1); // each exactly once
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

describe("owner control", () => {
  const invite = ev({ id: "m1", summary: "Friday standup", start: "2026-11-27T10:00:00Z", selfResponse: "needsAction" });
  it("sends a welcome once, first, and never when the calendar cannot be read", async () => {
    const a = setup({ events: [invite], welcomed: false });
    expect(await a.engine.run()).toMatchObject({ welcome: true, sent: 1 });
    expect(a.sent).toHaveLength(2);
    expect(a.sent[0]).toContain("proactive alerts are on");
    await a.engine.run();
    expect(a.sent).toHaveLength(2);
    const b = setup({ welcomed: false });
    b.box.calendarThrows = true;
    expect((await b.engine.run()).welcome).toBeUndefined();
    expect(b.sent).toEqual([]);
  });
  it("holds the welcome during quiet hours and keeps trying after", async () => {
    const { engine, box, sent } = setup({ welcomed: false, now: new Date("2026-11-25T22:00:00Z") });
    expect((await engine.run()).welcome).toBeUndefined();
    box.now = new Date("2026-11-26T06:00:00Z");
    expect((await engine.run()).welcome).toBe(true);
    expect(sent).toHaveLength(1);
  });
  it("mutes a kind, one item, or everything, and resumes", async () => {
    const { engine, prefs, sent } = setup({ events: [invite, { ...invite, id: "m2", summary: "Design review" }] });
    prefs.mute("invite", "friday standup");
    await engine.run();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Design review");
    prefs.unmute("invite", "Friday Standup");
    await engine.run();
    expect(sent.at(-1)).toContain("Friday standup");
    prefs.setPaused(true);
    expect((await engine.run()).skipped).toBe("paused");
    prefs.setPaused(false);
    prefs.mute("invite");
    expect((await engine.run()).detected).toBe(0);
  });
  it("the soon-reminder window follows the setting", async () => {
    const { engine, sent } = setup({ events: [invite], cfg: { inviteSoonHours: 48 } });
    await engine.run();
    expect(sent[0]).toContain("Reminder"); // 24 h away is inside a 48 h window
  });
  it("records alerts under their own audit kind", async () => {
    const { engine, audit } = setup({ events: [invite] });
    await engine.run();
    expect(audit.read({ kinds: ["trigger"] })[0]?.detail).toMatchObject({ trigger: "invite" });
    expect(audit.read({ kinds: ["schedule"] })).toHaveLength(0);
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
