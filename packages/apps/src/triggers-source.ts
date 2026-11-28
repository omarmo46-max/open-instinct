import type { CalendarEvent, CalendarRead, MailItem, TriggerSource } from "@orion-ai/core";

/** The one thing the source needs from ComposioApps. Narrow so tests can stub it. */
export interface AppRunner {
  execute(toolSlug: string, args?: Record<string, unknown>): Promise<unknown>;
}

export const CALENDAR_LIST_SLUG = "GOOGLECALENDAR_EVENTS_LIST";
export const MAIL_FETCH_SLUG = "GMAIL_FETCH_EMAILS";
/** Google keeps contact birthdays in this built-in calendar, not in the primary one. */
export const BIRTHDAY_CALENDAR_ID = "addressbook#contacts@group.v.calendar.google.com";

const PAGE_SIZE = 250;
const MAX_PAGES = 4;
const MAIL_MAX = 50;

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** First array found under any of `keys`, looking one level into `data`/`response_data` wrappers. */
function findArray(data: unknown, keys: string[]): unknown[] {
  const layers = [rec(data), rec(rec(data).data), rec(rec(data).response_data)];
  for (const layer of layers) {
    for (const k of keys) {
      const v = layer[k];
      if (Array.isArray(v)) return v;
      // Some responses nest again: { event_data: { items: [...] } }.
      const inner = rec(v);
      for (const k2 of keys) if (Array.isArray(inner[k2])) return inner[k2] as unknown[];
    }
  }
  return [];
}

function nextToken(data: unknown): string | undefined {
  for (const layer of [rec(data), rec(rec(data).data), rec(rec(data).response_data)]) {
    const t = layer.nextPageToken ?? layer.next_page_token;
    if (typeof t === "string" && t) return t;
  }
  return undefined;
}

const RESPONSES = new Set(["needsAction", "accepted", "declined", "tentative"]);

/** One Google Calendar event object to our shape. Undefined when it has no id or start. */
export function parseCalendarEvent(raw: unknown, calendarId: string): CalendarEvent | undefined {
  const e = rec(raw);
  const id = str(e.id);
  const startObj = rec(e.start);
  const date = str(startObj.date);
  const dateTime = str(startObj.dateTime);
  const start = dateTime || date;
  if (!id || !start) return undefined;
  const status = str(e.status);
  const attendees = Array.isArray(e.attendees) ? e.attendees.map(rec) : [];
  const me = attendees.find((a) => a.self === true);
  const response = str(me?.responseStatus);
  const out: CalendarEvent = {
    id: calendarId === "primary" ? id : `${calendarId}:${id}`,
    calendarId,
    summary: str(e.summary) || "(no title)",
    start,
    allDay: !dateTime,
    status: status === "cancelled" ? "cancelled" : status === "tentative" ? "tentative" : "confirmed",
  };
  const end = str(rec(e.end).dateTime) || str(rec(e.end).date);
  if (end) out.end = end;
  if (str(e.eventType)) out.eventType = str(e.eventType);
  if (str(e.location)) out.location = str(e.location).slice(0, 200);
  if (RESPONSES.has(response)) out.selfResponse = response as CalendarEvent["selfResponse"];
  if (rec(e.organizer).self === true) out.organizerSelf = true;
  return out;
}

export function parseMailItem(raw: unknown): MailItem | undefined {
  const m = rec(raw);
  const id = str(m.messageId) || str(m.message_id) || str(m.id);
  if (!id) return undefined;
  const at = str(m.messageTimestamp) || str(m.date) || str(m.internalDate);
  return { id, subject: str(m.subject), from: str(m.sender) || str(m.from), at };
}

/** Reads Gmail and Google Calendar through the owner's connected Composio accounts. */
export class ComposioTriggerSource implements TriggerSource {
  private readonly apps: AppRunner;
  private readonly withMail: boolean;

  constructor(apps: AppRunner, opts: { mail?: boolean } = {}) {
    this.apps = apps;
    this.withMail = opts.mail !== false;
  }

  get mail(): TriggerSource["mail"] {
    return this.withMail ? (since: Date) => this.readMail(since) : undefined;
  }

  async calendar(range: { from: Date; to: Date }): Promise<CalendarRead> {
    const primary = await this.readCalendar("primary", range);
    let events = primary.events;
    // Birthdays are a bonus: the calendar may be hidden or the account may lack the scope. Never fail the scan for it.
    try {
      const birthdays = await this.readCalendar(BIRTHDAY_CALENDAR_ID, range);
      events = events.concat(birthdays.events);
    } catch {
      // ignored on purpose
    }
    return { events, complete: primary.complete };
  }

  private async readCalendar(calendarId: string, range: { from: Date; to: Date }): Promise<CalendarRead> {
    const events: CalendarEvent[] = [];
    let token: string | undefined;
    let complete = true;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await this.apps.execute(CALENDAR_LIST_SLUG, {
        calendarId,
        timeMin: range.from.toISOString(),
        timeMax: range.to.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: true,
        maxResults: PAGE_SIZE,
        ...(token ? { pageToken: token } : {}),
      });
      for (const raw of findArray(data, ["items", "events", "event_data"])) {
        const e = parseCalendarEvent(raw, calendarId);
        if (e) events.push(e);
      }
      token = nextToken(data);
      if (!token) return { events, complete };
    }
    complete = false; // more pages exist than we read
    return { events, complete };
  }

  private async readMail(since: Date): Promise<MailItem[]> {
    const day = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86_400_000));
    const data = await this.apps.execute(MAIL_FETCH_SLUG, { query: `newer_than:${day}d`, max_results: MAIL_MAX, include_payload: false });
    const out: MailItem[] = [];
    for (const raw of findArray(data, ["messages", "emails"])) {
      const m = parseMailItem(raw);
      if (m) out.push(m);
    }
    return out;
  }
}
