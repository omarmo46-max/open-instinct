/**
 * Proactive triggers (Phase B1). The agent looks at the owner's calendar and mail on a
 * schedule and texts the owner first when something deserves it: an invite nobody
 * answered, a birthday today or tomorrow, a flight that moved or vanished.
 *
 * Design rules:
 * - Detection is plain code, not a model call. It costs no tokens, it is the same every
 *   run, and a message from an email can never steer it (no prompt injection surface).
 * - Text that came from outside (an event title, a subject line) is cleaned and shown in
 *   quotes; the agent never opens, replies to or acts on it.
 * - An alert is recorded as sent only after the channel took it, so a failed send or a
 *   quiet-hours hold is retried at the next scan and nothing is lost or repeated.
 * - Quiet hours hold everything except an urgent flight alert (departure within 12 hours).
 * - It reads data through a `TriggerSource`; the Composio-backed one lives in the apps
 *   package, and tests use a fake.
 */
import type { AuditLog } from "./audit.js";
import type { Lang } from "./i18n.js";
import { localParts } from "./scheduler.js";
import type { StateDir } from "./state.js";
import type { TriggersConfig } from "./types.js";

const STATE_FILE = "trigger-state.json";
export const TRIGGERS_SCAN_TASK = "triggers.scan";
export const TRIGGERS_SCHEDULE_ID = "s_triggers";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIRED_KEEP_MS = 60 * DAY;
const URGENT_FLIGHT_MS = 12 * HOUR;
const SOON_INVITE_MS = 24 * HOUR;
const MAIL_LOOKBACK_MS = 2 * DAY;
const TITLE_MAX = 120;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const DEFAULT_TRIGGERS: TriggersConfig = {
  enabled: false,
  intervalMinutes: 30,
  quietFrom: "23:00",
  quietTo: "07:00",
  inviteHorizonHours: 72,
  flightHorizonDays: 14,
  maxPerRun: 5,
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function validClock(value: unknown, fallback: string): string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim()) ? value.trim() : fallback;
}

/** File config plus env, with every field checked. Env wins when it is set. Off unless asked for. */
export function resolveTriggers(file: Partial<TriggersConfig> | undefined, env: { INSTINCT_TRIGGERS?: string | undefined; INSTINCT_QUIET_HOURS?: string | undefined } = {}): TriggersConfig {
  const d = DEFAULT_TRIGGERS;
  const switchRaw = env.INSTINCT_TRIGGERS?.trim().toLowerCase();
  const enabled = switchRaw ? /^(1|true|yes|on)$/.test(switchRaw) : file?.enabled === true;
  let quietFrom = validClock(file?.quietFrom, d.quietFrom);
  let quietTo = validClock(file?.quietTo, d.quietTo);
  const quiet = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(env.INSTINCT_QUIET_HOURS?.trim() ?? "");
  if (quiet) {
    quietFrom = validClock(quiet[1], quietFrom);
    quietTo = validClock(quiet[2], quietTo);
  }
  return {
    enabled,
    intervalMinutes: clampInt(file?.intervalMinutes, 5, 240, d.intervalMinutes),
    quietFrom,
    quietTo,
    inviteHorizonHours: clampInt(file?.inviteHorizonHours, 1, 24 * 14, d.inviteHorizonHours),
    flightHorizonDays: clampInt(file?.flightHorizonDays, 1, 60, d.flightHorizonDays),
    maxPerRun: clampInt(file?.maxPerRun, 1, 20, d.maxPerRun),
  };
}

/** The 5-field cron for a scan every `intervalMinutes`. Intervals above 30 that do not divide the hour run hourly, which is safe. */
export function scanCron(intervalMinutes: number): string {
  const n = clampInt(intervalMinutes, 5, 240, 30);
  if (n < 60) return 60 % n === 0 ? `*/${n} * * * *` : "*/30 * * * *";
  const hours = Math.round(n / 60);
  return hours <= 1 ? "0 * * * *" : `0 */${hours} * * *`;
}

// ---------------------------------------------------------------------------
// Data the detectors read
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  id: string;
  calendarId?: string;
  summary: string;
  /** ISO instant for a timed event, `YYYY-MM-DD` for an all-day one. */
  start: string;
  allDay: boolean;
  end?: string;
  status: "confirmed" | "tentative" | "cancelled";
  /** Google's `eventType` ("birthday", "default", ...). */
  eventType?: string;
  /** The owner's own answer to the invite, when the owner is an attendee. */
  selfResponse?: "needsAction" | "accepted" | "declined" | "tentative";
  /** True when the owner organizes the event, so there is nobody to answer. */
  organizerSelf?: boolean;
}

export interface MailItem {
  id: string;
  subject: string;
  from: string;
  at: string;
}

export interface CalendarRead {
  events: CalendarEvent[];
  /** True only when every page of the main calendar was read. Without it, "this event disappeared" is never claimed. */
  complete: boolean;
}

export interface TriggerSource {
  calendar(range: { from: Date; to: Date }): Promise<CalendarRead>;
  mail?(since: Date): Promise<MailItem[]>;
}

// ---------------------------------------------------------------------------
// Alerts and state
// ---------------------------------------------------------------------------

export type TriggerKind = "invite" | "birthday" | "flight" | "travel_mail";

export interface TriggerAlert {
  /** Stable id of this fact. An alert with the same key is sent once. */
  key: string;
  kind: TriggerKind;
  urgent: boolean;
  text: string;
}

interface FlightSnapshot {
  start: string;
  summary: string;
  seenAt: string;
}

interface TriggerState {
  version: 1;
  fired: Record<string, string>;
  flights: Record<string, FlightSnapshot>;
}

interface PendingAlert extends TriggerAlert {
  /** Runs after the alert was delivered, to move the baseline it was measured against. */
  commit?: (state: TriggerState) => void;
}

export interface TriggerRunResult {
  detected: number;
  sent: number;
  held: number;
  failed: boolean;
  skipped?: "busy";
}

export interface TriggerEngineDeps {
  source: TriggerSource;
  state: StateDir;
  audit: AuditLog;
  config: TriggersConfig;
  timezone: string;
  /** Language for the alert text; read at every run so a changed owner preference applies. */
  language: () => Lang;
  /** The quiet window to use right now (learned from habits, B2). Defaults to the configured one. */
  quiet?: () => { from: string; to: string };
  /** Deliver to the owner. True when the message left. */
  send: (text: string) => Promise<boolean>;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const TEXT = {
  en: {
    inviteEarly: "You have an invite waiting for your reply: “{title}”, {when}.",
    inviteSoon: "Reminder: you have not replied to “{title}” yet. It starts {when}.",
    birthdayToday: "Today is a birthday: {title}.",
    birthdayTomorrow: "Tomorrow is a birthday: {title}.",
    flightChanged: "Your flight “{title}” changed on the calendar. Before: {old}. Now: {now}.",
    flightCancelled: "Your flight “{title}” ({when}) is cancelled on the calendar.",
    flightMissing: "I can no longer find your flight “{title}” ({when}) in the next {days} days on your calendar. It may have been moved or cancelled.",
    travelMail: "An email that looks like a flight change: “{subject}”, from {from}. I did not open it or act on it.",
  },
  ar: {
    inviteEarly: "عندك دعوة مستنية ردك: «{title}»، {when}.",
    inviteSoon: "تذكير: لسه ماردّتش على «{title}». بتبدأ {when}.",
    birthdayToday: "النهاردة عيد ميلاد: {title}.",
    birthdayTomorrow: "بكرة عيد ميلاد: {title}.",
    flightChanged: "رحلتك «{title}» اتغيرت في التقويم. كانت: {old}. بقت: {now}.",
    flightCancelled: "رحلتك «{title}» ({when}) اتلغت في التقويم.",
    flightMissing: "مش لاقي رحلتك «{title}» ({when}) في التقويم خلال الـ {days} يوم الجايين. ممكن تكون اتأجلت أو اتلغت.",
    travelMail: "إيميل شكله بيخص تغيير في رحلة: «{subject}»، من {from}. مافتحتوش وماعملتش حاجة بيه.",
  },
} as const;

type TextKey = keyof (typeof TEXT)["en"];

function render(lang: Lang, key: TextKey, vars: Record<string, string | number>): string {
  let out: string = TEXT[lang][key];
  for (const [name, value] of Object.entries(vars)) out = out.split(`{${name}}`).join(String(value));
  return out;
}

/** Outside text (an event title, a subject) made safe to print: no control or bidi-override characters, one line, bounded. */
export function sanitizeExternal(text: string, max = TITLE_MAX): string {
  const clean = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/[“”«»]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function formatWhen(start: string, allDay: boolean, tz: string, lang: Lang): string {
  const locale = lang === "ar" ? "ar-EG-u-nu-latn" : "en-US";
  try {
    if (allDay) {
      const d = new Date(`${start}T12:00:00Z`);
      return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(d);
    }
    return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(start));
  } catch {
    return start;
  }
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

const FLIGHT_WORDS = /\bflight\b|\bairlines?\b|✈|🛫|🛬|رحلة\s*(?:طيران|جوية|جويّة)|طيران/i;
const FLIGHT_ROUTE = /\b[A-Z]{3}\s*(?:→|->|–|—|-|to)\s*[A-Z]{3}\b/;
const BIRTHDAY_WORDS = /birthday|b-?day|عيد\s*ميلاد/i;

/** A timed event whose title says flight, airline or an airport pair like "CAI → DXB". A heuristic: it can miss a flight titled "Trip" and can catch "Flight club". */
export function looksLikeFlight(event: CalendarEvent): boolean {
  if (event.allDay) return false;
  return FLIGHT_WORDS.test(event.summary) || FLIGHT_ROUTE.test(event.summary);
}

export function looksLikeBirthday(event: CalendarEvent): boolean {
  if (!event.allDay) return false;
  return event.eventType === "birthday" || BIRTHDAY_WORDS.test(event.summary);
}

const TRAVEL_MAIL_PATTERNS: readonly RegExp[] = [
  /\b(?:flight|booking|reservation|itinerary)\b.{0,60}\b(?:chang|cancel|delay|reschedul|updat)/i,
  /\b(?:chang|cancel|delay|reschedul)\w*\b.{0,60}\bflight\b/i,
  /\bschedule change\b|\bgate change\b/i,
  /(?:تغيير|تعديل|إلغاء|الغاء|تأخير|تأجيل).{0,40}(?:رحلة|رحلتك)/,
  /(?:رحلة|رحلتك).{0,40}(?:تغيير|تعديل|إلغاء|الغاء|تأخير|تأجيل|اتأجلت|اتلغت)/,
];

export function looksLikeTravelChange(subject: string): boolean {
  return TRAVEL_MAIL_PATTERNS.some((re) => re.test(subject));
}

function minutesOf(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when `now` falls inside the quiet window in `tz`. The window may wrap midnight; equal ends mean no quiet hours. */
export function inQuietHours(now: Date, tz: string, from: string, to: string): boolean {
  const a = minutesOf(from);
  const b = minutesOf(to);
  if (a === b) return false;
  const p = localParts(now, tz);
  const cur = p.hour * 60 + p.minute;
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((b - a) / DAY);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class TriggerEngine {
  private readonly deps: TriggerEngineDeps;
  private readonly now: () => Date;
  private running = false;

  constructor(deps: TriggerEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** One scan: read, detect, deliver what is due. Safe to call concurrently; the second call returns at once. */
  async run(): Promise<TriggerRunResult> {
    if (this.running) return { detected: 0, sent: 0, held: 0, failed: false, skipped: "busy" };
    this.running = true;
    const state = this.loadState();
    try {
      const now = this.now();
      const pending = (await this.detect(now, state)).filter((a) => state.fired[a.key] === undefined);
      pending.sort((a, b) => Number(b.urgent) - Number(a.urgent));
      const cfg = this.deps.config;
      const window = this.deps.quiet?.() ?? { from: cfg.quietFrom, to: cfg.quietTo };
      const quiet = inQuietHours(now, this.deps.timezone, window.from, window.to);
      const due = quiet ? pending.filter((a) => a.urgent) : pending;
      let held = pending.length - due.length;
      const batch = due.slice(0, cfg.maxPerRun);
      held += due.length - batch.length;
      let sent = 0;
      let failed = false;
      for (const alert of batch) {
        let ok = false;
        try {
          ok = await this.deps.send(alert.text);
        } catch {
          ok = false;
        }
        if (!ok) {
          failed = true;
          held += batch.length - sent; // the rest wait for the next scan
          break;
        }
        sent++;
        state.fired[alert.key] = now.toISOString();
        alert.commit?.(state);
        this.deps.audit.append({ kind: "schedule", conversationKey: "triggers", principal: "owner", detail: { trigger: alert.kind, key: alert.key, urgent: alert.urgent } });
      }
      return { detected: pending.length, sent, held, failed };
    } finally {
      this.pruneFired(state, this.now());
      this.saveState(state);
      this.running = false;
    }
  }

  /** All facts worth an alert right now, deduplicated against `fired` by the caller. Never throws: a failing source is audited and skipped. */
  private async detect(now: Date, state: TriggerState): Promise<PendingAlert[]> {
    const cfg = this.deps.config;
    const alerts: PendingAlert[] = [];
    const horizon = Math.max(cfg.inviteHorizonHours * HOUR, cfg.flightHorizonDays * DAY);
    const to = new Date(now.getTime() + horizon);
    // Birthdays are matched by date, so read from the start of the owner's yesterday to be safe at day edges.
    const from = new Date(now.getTime() - DAY);
    try {
      const read = await this.deps.source.calendar({ from, to });
      alerts.push(...this.invites(read.events, now));
      alerts.push(...this.birthdays(read.events, now));
      alerts.push(...this.flights(read, now, state));
    } catch (error) {
      this.fail("calendar", error);
    }
    if (this.deps.source.mail) {
      try {
        const items = await this.deps.source.mail(new Date(now.getTime() - MAIL_LOOKBACK_MS));
        alerts.push(...this.travelMail(items));
      } catch (error) {
        this.fail("mail", error);
      }
    }
    return alerts;
  }

  private fail(part: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.deps.audit.append({ kind: "error", conversationKey: "triggers", principal: "owner", detail: { message: `triggers ${part} read failed: ${message.slice(0, 300)}` } });
  }

  private invites(events: CalendarEvent[], now: Date): PendingAlert[] {
    const lang = this.deps.language();
    const limit = now.getTime() + this.deps.config.inviteHorizonHours * HOUR;
    const out: PendingAlert[] = [];
    for (const e of events) {
      if (e.allDay || e.status === "cancelled" || e.organizerSelf || e.selfResponse !== "needsAction") continue;
      const at = Date.parse(e.start);
      if (!Number.isFinite(at) || at <= now.getTime() || at > limit) continue;
      const soon = at - now.getTime() <= SOON_INVITE_MS;
      out.push({
        key: `invite:${e.id}:${e.start}:${soon ? "soon" : "early"}`,
        kind: "invite",
        urgent: false,
        text: render(lang, soon ? "inviteSoon" : "inviteEarly", { title: sanitizeExternal(e.summary), when: formatWhen(e.start, false, this.deps.timezone, lang) }),
      });
    }
    return out;
  }

  private birthdays(events: CalendarEvent[], now: Date): PendingAlert[] {
    const lang = this.deps.language();
    const today = localParts(now, this.deps.timezone).date;
    const out: PendingAlert[] = [];
    const seen = new Set<string>();
    for (const e of events) {
      if (e.status === "cancelled" || !looksLikeBirthday(e) || !/^\d{4}-\d{2}-\d{2}$/.test(e.start)) continue;
      const days = daysBetween(today, e.start);
      if (days !== 0 && days !== 1) continue;
      const key = `birthday:${e.id}:${e.start}:${days}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, kind: "birthday", urgent: false, text: render(lang, days === 0 ? "birthdayToday" : "birthdayTomorrow", { title: sanitizeExternal(e.summary) }) });
    }
    return out;
  }

  private flights(read: CalendarRead, now: Date, state: TriggerState): PendingAlert[] {
    const lang = this.deps.language();
    const tz = this.deps.timezone;
    const days = this.deps.config.flightHorizonDays;
    const rangeEnd = now.getTime() + days * DAY;
    const out: PendingAlert[] = [];
    const seenIds = new Set<string>();
    const urgentAt = (start: string): boolean => {
      const t = Date.parse(start);
      return Number.isFinite(t) && t > now.getTime() - HOUR && t - now.getTime() <= URGENT_FLIGHT_MS;
    };

    for (const e of read.events) {
      if (!looksLikeFlight(e)) continue;
      const at = Date.parse(e.start);
      if (!Number.isFinite(at)) continue;
      seenIds.add(e.id);
      const snap = state.flights[e.id];
      if (e.status === "cancelled") {
        if (snap && at > now.getTime()) {
          out.push({
            key: `flight-cancel:${e.id}`,
            kind: "flight",
            urgent: urgentAt(snap.start),
            text: render(lang, "flightCancelled", { title: sanitizeExternal(e.summary), when: formatWhen(snap.start, false, tz, lang) }),
            commit: (s) => void delete s.flights[e.id],
          });
        }
        continue;
      }
      if (at > rangeEnd || at < now.getTime() - DAY) continue;
      if (!snap) {
        // First sight is the baseline, never an alert: "changed" needs something to change from.
        state.flights[e.id] = { start: e.start, summary: sanitizeExternal(e.summary), seenAt: now.toISOString() };
        continue;
      }
      if (Date.parse(snap.start) !== at) {
        const next = { start: e.start, summary: sanitizeExternal(e.summary), seenAt: now.toISOString() };
        out.push({
          key: `flight:${e.id}:${snap.start}>${e.start}`,
          kind: "flight",
          urgent: urgentAt(e.start) || urgentAt(snap.start),
          text: render(lang, "flightChanged", { title: sanitizeExternal(e.summary), old: formatWhen(snap.start, false, tz, lang), now: formatWhen(e.start, false, tz, lang) }),
          commit: (s) => void (s.flights[e.id] = next),
        });
      }
    }

    // A watched flight that is gone from a complete read. Only claimed when the read was complete.
    if (read.complete) {
      for (const [id, snap] of Object.entries(state.flights)) {
        if (seenIds.has(id)) continue;
        const at = Date.parse(snap.start);
        if (!Number.isFinite(at) || at <= now.getTime() || at > rangeEnd) continue;
        out.push({
          key: `flight-missing:${id}:${snap.start}`,
          kind: "flight",
          urgent: urgentAt(snap.start),
          text: render(lang, "flightMissing", { title: snap.summary, when: formatWhen(snap.start, false, tz, lang), days }),
          commit: (s) => void delete s.flights[id],
        });
      }
    }

    // Flights already in the past are no longer watched.
    for (const [id, snap] of Object.entries(state.flights)) {
      const at = Date.parse(snap.start);
      if (!Number.isFinite(at) || at < now.getTime() - 2 * DAY) delete state.flights[id];
    }
    return out;
  }

  private travelMail(items: MailItem[]): PendingAlert[] {
    const lang = this.deps.language();
    const out: PendingAlert[] = [];
    for (const m of items) {
      if (!m.id || !looksLikeTravelChange(m.subject)) continue;
      out.push({
        key: `mail:${m.id}`,
        kind: "travel_mail",
        urgent: false,
        text: render(lang, "travelMail", { subject: sanitizeExternal(m.subject), from: sanitizeExternal(m.from, 80) }),
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private loadState(): TriggerState {
    const raw = this.deps.state.readJson<Partial<TriggerState>>(STATE_FILE, {});
    return {
      version: 1,
      fired: raw.fired && typeof raw.fired === "object" ? { ...raw.fired } : {},
      flights: raw.flights && typeof raw.flights === "object" ? { ...raw.flights } : {},
    };
  }

  private saveState(state: TriggerState): void {
    this.deps.state.writeJson(STATE_FILE, state);
  }

  private pruneFired(state: TriggerState, now: Date): void {
    for (const [key, at] of Object.entries(state.fired)) {
      if (Date.parse(at) + FIRED_KEEP_MS <= now.getTime()) delete state.fired[key];
    }
  }
}
