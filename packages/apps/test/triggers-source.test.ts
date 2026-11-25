import { describe, expect, it } from "vitest";
import { BIRTHDAY_CALENDAR_ID, ComposioTriggerSource, parseCalendarEvent, parseMailItem } from "../src/triggers-source.js";

const RANGE = { from: new Date("2026-11-24T00:00:00Z"), to: new Date("2026-12-10T00:00:00Z") };

function runner(script: (slug: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    execute: async (slug: string, args: Record<string, unknown> = {}) => {
      calls.push({ slug, args });
      return script(slug, args);
    },
  };
}

describe("parseCalendarEvent", () => {
  it("reads a timed invite the owner has not answered", () => {
    const e = parseCalendarEvent(
      { id: "e1", summary: "Sync", status: "confirmed", start: { dateTime: "2026-11-27T10:00:00Z" }, end: { dateTime: "2026-11-27T11:00:00Z" }, organizer: { email: "x@y.z" }, attendees: [{ email: "me@y.z", self: true, responseStatus: "needsAction" }] },
      "primary",
    );
    expect(e).toMatchObject({ id: "e1", allDay: false, selfResponse: "needsAction", status: "confirmed" });
    expect(e?.organizerSelf).toBeUndefined();
  });
  it("reads an all-day birthday and namespaces non-primary ids", () => {
    const e = parseCalendarEvent({ id: "b1", summary: "Mona", eventType: "birthday", start: { date: "2026-11-26" } }, BIRTHDAY_CALENDAR_ID);
    expect(e).toMatchObject({ allDay: true, start: "2026-11-26", eventType: "birthday", id: `${BIRTHDAY_CALENDAR_ID}:b1` });
  });
  it("marks owner-organized and cancelled events, drops junk", () => {
    expect(parseCalendarEvent({ id: "e2", status: "cancelled", start: { dateTime: "2026-11-27T10:00:00Z" }, organizer: { self: true } }, "primary")).toMatchObject({ status: "cancelled", organizerSelf: true });
    expect(parseCalendarEvent({ summary: "no id", start: { date: "2026-11-26" } }, "primary")).toBeUndefined();
    expect(parseCalendarEvent("nope", "primary")).toBeUndefined();
  });
});

describe("parseMailItem", () => {
  it("accepts the common field names", () => {
    expect(parseMailItem({ messageId: "m1", subject: "S", sender: "a@b.c", messageTimestamp: "2026-11-25T08:00:00Z" })).toEqual({ id: "m1", subject: "S", from: "a@b.c", at: "2026-11-25T08:00:00Z" });
    expect(parseMailItem({ id: "m2", subject: "T", from: "d@e.f" })?.id).toBe("m2");
    expect(parseMailItem({ subject: "no id" })).toBeUndefined();
  });
});

describe("ComposioTriggerSource", () => {
  const item = { id: "e1", summary: "Flight MS985", start: { dateTime: "2026-12-02T08:00:00Z" } };

  it("reads the primary and birthday calendars, wrapped or not", async () => {
    const r = runner((_slug, args) => (args.calendarId === "primary" ? { data: { items: [item] } } : { items: [{ id: "b1", summary: "Mona", eventType: "birthday", start: { date: "2026-11-26" } }] }));
    const read = await new ComposioTriggerSource(r).calendar(RANGE);
    expect(read.events.map((e) => e.id)).toEqual(["e1", `${BIRTHDAY_CALENDAR_ID}:b1`]);
    expect(read.complete).toBe(true);
    expect(r.calls[0]?.args).toMatchObject({ calendarId: "primary", singleEvents: true, showDeleted: true, timeMin: RANGE.from.toISOString() });
  });

  it("follows pages and reports an incomplete read when pages run out", async () => {
    const r = runner((_s, args) => (args.calendarId === "primary" ? { items: [item], nextPageToken: "more" } : { items: [] }));
    const read = await new ComposioTriggerSource(r).calendar(RANGE);
    expect(read.complete).toBe(false);
    expect(r.calls.filter((c) => c.args.calendarId === "primary")).toHaveLength(4);
  });

  it("does not fail when only the birthday calendar errors", async () => {
    const r = runner((_s, args) => {
      if (args.calendarId !== "primary") throw new Error("not found");
      return { items: [item] };
    });
    const read = await new ComposioTriggerSource(r).calendar(RANGE);
    expect(read.events).toHaveLength(1);
    expect(read.complete).toBe(true);
  });

  it("fails when the primary calendar errors, so the engine can audit it", async () => {
    const r = runner(() => {
      throw new Error("auth expired");
    });
    await expect(new ComposioTriggerSource(r).calendar(RANGE)).rejects.toThrow("auth expired");
  });

  it("reads recent mail headers only and can be switched off", async () => {
    const r = runner(() => ({ data: { messages: [{ messageId: "m1", subject: "Flight cancelled", sender: "air@x.y" }] } }));
    const src = new ComposioTriggerSource(r);
    const items = await src.mail!(new Date(Date.now() - 36 * 3600_000));
    expect(items).toHaveLength(1);
    expect(r.calls[0]?.args).toMatchObject({ query: "newer_than:2d", include_payload: false });
    expect(new ComposioTriggerSource(r, { mail: false }).mail).toBeUndefined();
  });
});
