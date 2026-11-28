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
import { TriggerPrefs, titleKey } from "./trigger-prefs.js";
import type { TriggersConfig } from "./types.js";

const STATE_FILE = "trigger-state.json";
export const TRIGGERS_SCAN_TASK = "triggers.scan";
export const TRIGGERS_SCHEDULE_ID = "s_triggers";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIRED_KEEP_MS = 60 * DAY;
const WIDE_DAYS_MIN = 90;
const DIGEST_MAX_CHARS = 3500;
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
  inviteSoonHours: 24,
  urgentFlightHours: 12,
  flightChangeMinutes: 20,
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
export function resolveTriggers(file: Partial<TriggersConfig> | undefined, env: { ORION_TRIGGERS?: string | undefined; ORION_QUIET_HOURS?: string | undefined } = {}): TriggersConfig {
  const d = DEFAULT_TRIGGERS;
  const switchRaw = env.ORION_TRIGGERS?.trim().toLowerCase();
  const enabled = switchRaw ? /^(1|true|yes|on)$/.test(switchRaw) : file?.enabled === true;
  let quietFrom = validClock(file?.quietFrom, d.quietFrom);
  let quietTo = validClock(file?.quietTo, d.quietTo);
  const quiet = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(env.ORION_QUIET_HOURS?.trim() ?? "");
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
    inviteSoonHours: clampInt(file?.inviteSoonHours, 1, 72, d.inviteSoonHours),
    urgentFlightHours: clampInt(file?.urgentFlightHours, 1, 72, d.urgentFlightHours),
    flightChangeMinutes: clampInt(file?.flightChangeMinutes, 0, 360, d.flightChangeMinutes),
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
  /** The event's place, when it has one (an airport is a strong flight signal). */
  location?: string;
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
  /** `titleKey` of the event or subject, so the owner can mute this one item. */
  title?: string;
}

interface FlightSnapshot {
  start: string;
  summary: string;
  seenAt: string;
  allDay?: boolean;
}

interface TriggerState {
  version: 1;
  fired: Record<string, string>;
  flights: Record<string, FlightSnapshot>;
  /** True once the owner got the one-time explanation of what the agent watches. */
  welcomed?: boolean;
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
  /** True when this scan sent the one-time welcome message. */
  welcome?: boolean;
  skipped?: "busy" | "paused";
}

export interface TriggerEngineDeps {
  source: TriggerSource;
  state: StateDir;
  audit: AuditLog;
  config: TriggersConfig;
  timezone: string;
  /** Language for the alert text; read at every run so a changed owner preference applies. */
  language: () => Lang;
  /** The owner's mutes and corrections. Built from `state` when not given. */
  prefs?: TriggerPrefs;
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
    flightChanged: "Travel plan “{title}” moved on your calendar ({shift}). Before: {old}. Now: {now}.",
    flightCancelled: "Travel plan “{title}” ({when}) is cancelled on your calendar.",
    flightMissing: "I could not find “{title}” ({when}) on your calendar over the next {days} days. It may have been moved or removed, so it is worth a look.",
    travelMail: "An email whose subject looks like a travel change: “{subject}”, from {from}. I only saw the subject, not the message, so this is a hint and not a confirmation. Please check it.",
    digestHeader: "{n} things worth a look:",
    welcome:
      "Heads up: proactive alerts are on. I will message you first about invites you have not answered, birthdays, changes to flights or trips on your calendar, and emails whose subject looks like a travel change (I only read subjects). I stay quiet at night unless a flight is about to leave. Tell me to mute a type or one item (for example \"stop alerts about the Friday meeting\"), correct me (\"that is not a flight\"), or say \"pause alerts\" to stop them all.",
    later: "{d} later",
    earlier: "{d} earlier",
  },
  ar: {
    inviteEarly: "عندك دعوة مستنية ردك: «{title}»، {when}.",
    inviteSoon: "تذكير: لسه ماردّتش على «{title}». بتبدأ {when}.",
    birthdayToday: "النهاردة عيد ميلاد: {title}.",
    birthdayTomorrow: "بكرة عيد ميلاد: {title}.",
    flightChanged: "خطة السفر «{title}» اتغيرت في التقويم ({shift}). كانت: {old}. بقت: {now}.",
    flightCancelled: "خطة السفر «{title}» ({when}) اتلغت في التقويم.",
    flightMissing: "ماقدرتش ألاقي «{title}» ({when}) في تقويمك خلال الـ {days} يوم الجايين. ممكن تكون اتأجلت أو اتشالت، فيستاهل تبص عليها.",
    travelMail: "إيميل عنوانه شكله بيخص تغيير في السفر: «{subject}»، من {from}. أنا شفت العنوان بس مش الرسالة، فده تلميح مش تأكيد. اتأكد منه بنفسك.",
    digestHeader: "{n} حاجات تستاهل تبص عليها:",
    welcome:
      "تنبيه: التنبيهات الاستباقية اتفعّلت. هبعتلك من نفسي عن الدعوات اللي ماردّتش عليها، وأعياد الميلاد، وأي تغيير في رحلات أو سفريات على تقويمك، وإيميلات عنوانها شكله بيخص تغيير في السفر (بقرا العناوين بس). بسكت بالليل إلا لو رحلة قربت تقلع. قولي أسكّت نوع معين أو حاجة بعينها (مثلًا \"بطّل تنبهني عن اجتماع الجمعة\")، أو صحّحلي (\"دي مش رحلة\")، أو قول \"وقّف التنبيهات\" وأوقفها كلها.",
    later: "اتأخرت {d}",
    earlier: "اتقدمت {d}",
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

const FLIGHT_WORDS =
  /\b(?:flights?|airlines?|airways|airport|boarding(?:\s+pass)?|departure|layover|itinerary)\b|\b(?:trip|travel|fly|flying)\s+to\b|✈|🛫|🛬|رحلة\s*(?:طيران|جوية|جويّة)|رحلة\s*(?:إلى|الى|لـ)|طيران|طيارة|مطار|سفرية|سفر\b/i;
const FLIGHT_ROUTE = /\b[A-Z]{3}\s*(?:→|->|–|—|-|to)\s*[A-Z]{3}\b/;
const FLIGHT_NUMBER = /\b[A-Z][A-Z0-9]\s?\d{2,4}\b.*\b(?:flight|→|->)|\bflight\s+[A-Z0-9]{2}\s?\d{2,4}\b/i;
const AIRPORT_PLACE = /\bairport\b|\bint(?:ernation)?al\b.*\bterminal\b|\bterminal\s*\d\b|مطار|\([A-Z]{3}\)/i;
/** Titles that use the same words for something else: a flight club, a meeting about flights, flight school. */
const FLIGHT_NOT = /\b(?:club|meeting|meetup|school|class|course|training|simulator|workshop|webinar|lunch|dinner|party|podcast|game|movie)\b|اجتماع|نادي|مدرسة|كورس|دورة|تدريب|ورشة|حفلة|غدا|عشا/i;
const BIRTHDAY_WORDS = /birthday|b-?day|عيد\s*(?:ال)?ميلاد/i;
const BIRTHDAY_NOT = /\b(?:christ|jesus|nativity|prophet)\b|المسيح|النبي|المولد\s*النبوي/i;

/**
 * Does this event look like a flight or trip? Uses the title, the place (an airport), the
 * calendar's own type (events Google creates from a confirmation email) and a short list of
 * words that mean something else. A heuristic: the owner can correct it with `trigger_feedback`.
 */
export function looksLikeFlight(event: CalendarEvent): boolean {
  const text = event.summary;
  const place = event.location ?? "";
  const fromMail = event.eventType === "fromGmail";
  const strong = FLIGHT_ROUTE.test(text) || FLIGHT_NUMBER.test(text) || AIRPORT_PLACE.test(place) || (fromMail && FLIGHT_WORDS.test(`${text} ${place}`));
  if (strong) return true;
  if (FLIGHT_NOT.test(text)) return false;
  return FLIGHT_WORDS.test(text);
}

export function looksLikeBirthday(event: CalendarEvent): boolean {
  if (event.eventType === "birthday") return true;
  return BIRTHDAY_WORDS.test(event.summary) && !BIRTHDAY_NOT.test(event.summary);
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

/** Minutes between two instants (timed) or between two dates (all-day, in whole days). Signed: positive means later. */
function shiftMinutes(oldStart: string, oldAllDay: boolean, newStart: string, newAllDay: boolean): number {
  if (oldAllDay || newAllDay) {
    const a = oldAllDay ? oldStart : oldStart.slice(0, 10);
    const b = newAllDay ? newStart : newStart.slice(0, 10);
    return daysBetween(a, b) * 1440;
  }
  return Math.round((Date.parse(newStart) - Date.parse(oldStart)) / 60_000);
}

function startMs(start: string, allDay: boolean): number {
  return Date.parse(allDay ? `${start}T00:00:00Z` : start);
}

function formatShift(minutes: number, allDay: boolean, lang: Lang): string {
  const abs = Math.abs(minutes);
  let d: string;
  if (allDay) {
    const days = Math.round(abs / 1440);
    d = lang === "ar" ? `${days} يوم` : `${days} day${days === 1 ? "" : "s"}`;
  } else {
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    d = lang === "ar" ? [h ? `${h} س` : "", m ? `${m} د` : ""].filter(Boolean).join(" ") : [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
  }
  return render(lang, minutes >= 0 ? "later" : "earlier", { d });
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class TriggerEngine {
  private readonly deps: TriggerEngineDeps;
  private readonly prefs: TriggerPrefs;
  private readonly now: () => Date;
  private running = false;

  constructor(deps: TriggerEngineDeps) {
    this.deps = deps;
    this.prefs = deps.prefs ?? new TriggerPrefs(deps.state);
    this.now = deps.now ?? (() => new Date());
  }

  /** One scan: read, detect, deliver what is due. Safe to call concurrently; the second call returns at once. */
  async run(): Promise<TriggerRunResult> {
    if (this.running) return { detected: 0, sent: 0, held: 0, failed: false, skipped: "busy" };
    if (this.prefs.isPaused()) return { detected: 0, sent: 0, held: 0, failed: false, skipped: "paused" };
    this.running = true;
    const state = this.loadState();
    try {
      const now = this.now();
      const cfg = this.deps.config;
      const read = await this.detect(now, state);
      const pending = read.alerts.filter((a) => state.fired[a.key] === undefined && !this.prefs.isMuted(a.kind, a.title));
      const window = this.deps.quiet?.() ?? { from: cfg.quietFrom, to: cfg.quietTo };
      const quiet = inQuietHours(now, this.deps.timezone, window.from, window.to);
      let sent = 0;
      let failed = false;
      let welcome = false;

      // The one-time explanation goes first, and only when the calendar was readable, so it never promises a feature that is not working.
      if (!state.welcomed && read.calendarOk && !quiet) {
        if (await this.safeSend(this.text("welcome"))) {
          state.welcomed = true;
          welcome = true;
          this.deps.audit.append({ kind: "trigger", conversationKey: "triggers", principal: "owner", detail: { trigger: "welcome" } });
        } else failed = true;
      }

      if (!failed) {
        const urgent = pending.filter((a) => a.urgent).slice(0, cfg.maxPerRun);
        const normal = quiet ? [] : pending.filter((a) => !a.urgent).slice(0, cfg.maxPerRun);
        for (const alert of urgent) {
          if (!(await this.deliver([alert], alert.text, false, now, state))) {
            failed = true;
            break;
          }
          sent++;
        }
        if (!failed && normal.length > 0) {
          const { text, included } = normal.length === 1 ? { text: normal[0]!.text, included: normal } : this.digest(normal);
          if (await this.deliver(included, text, included.length > 1, now, state)) sent += included.length;
          else failed = true;
        }
      }
      return { detected: pending.length, sent, held: pending.length - sent, failed, ...(welcome ? { welcome } : {}) };
    } finally {
      this.pruneFired(state, this.now());
      this.saveState(state);
      this.running = false;
    }
  }

  private text(key: "welcome"): string {
    return TEXT[this.deps.language()][key];
  }

  /** One message for several alerts. Only the alerts that fit are in it (and so only those are marked sent); the rest wait for the next scan. */
  private digest(alerts: PendingAlert[]): { text: string; included: PendingAlert[] } {
    const lang = this.deps.language();
    const included: PendingAlert[] = [];
    let body = "";
    for (const a of alerts) {
      const line = `\n• ${a.text}`;
      if (included.length > 0 && render(lang, "digestHeader", { n: included.length + 1 }).length + body.length + line.length > DIGEST_MAX_CHARS) break;
      included.push(a);
      body += line;
    }
    return { text: render(lang, "digestHeader", { n: included.length }) + body, included };
  }

  private async safeSend(text: string): Promise<boolean> {
    try {
      return await this.deps.send(text);
    } catch {
      return false;
    }
  }

  /** Send one message that stands for these alerts. Only after the channel took it are they recorded as sent. */
  private async deliver(alerts: PendingAlert[], text: string, digest: boolean, now: Date, state: TriggerState): Promise<boolean> {
    if (!(await this.safeSend(text))) return false;
    for (const alert of alerts) {
      state.fired[alert.key] = now.toISOString();
      alert.commit?.(state);
      this.deps.audit.append({ kind: "trigger", conversationKey: "triggers", principal: "owner", detail: { trigger: alert.kind, key: alert.key, urgent: alert.urgent, ...(digest ? { digest: true } : {}) } });
    }
    return true;
  }

  /** All facts worth an alert right now, not yet checked against `fired`. Never throws: a failing source is audited and skipped. */
  private async detect(now: Date, state: TriggerState): Promise<{ alerts: PendingAlert[]; calendarOk: boolean }> {
    const cfg = this.deps.config;
    const alerts: PendingAlert[] = [];
    let calendarOk = false;
    const horizon = Math.max(cfg.inviteHorizonHours * HOUR, cfg.flightHorizonDays * DAY);
    const to = new Date(now.getTime() + horizon);
    // Birthdays are matched by date, so read from yesterday to be safe at day edges.
    const from = new Date(now.getTime() - DAY);
    try {
      const read = await this.deps.source.calendar({ from, to });
      calendarOk = true;
      alerts.push(...this.invites(read.events, now));
      alerts.push(...this.birthdays(read.events, now));
      alerts.push(...(await this.travel(read, now, state)));
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
    return { alerts, calendarOk };
  }

  private fail(part: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.deps.audit.append({ kind: "error", conversationKey: "triggers", principal: "owner", detail: { message: `triggers ${part} read failed: ${message.slice(0, 300)}` } });
  }

  private invites(events: CalendarEvent[], now: Date): PendingAlert[] {
    const lang = this.deps.language();
    const limit = now.getTime() + this.deps.config.inviteHorizonHours * HOUR;
    const soonMs = this.deps.config.inviteSoonHours * HOUR;
    const out: PendingAlert[] = [];
    for (const e of events) {
      if (e.allDay || e.status === "cancelled" || e.organizerSelf || e.selfResponse !== "needsAction") continue;
      const at = Date.parse(e.start);
      if (!Number.isFinite(at) || at <= now.getTime() || at > limit) continue;
      const soon = at - now.getTime() <= soonMs;
      out.push({
        key: `invite:${e.id}:${e.start}:${soon ? "soon" : "early"}`,
        kind: "invite",
        urgent: false,
        title: titleKey(e.summary),
        text: render(lang, soon ? "inviteSoon" : "inviteEarly", { title: sanitizeExternal(e.summary), when: formatWhen(e.start, false, this.deps.timezone, lang) }),
      });
    }
    return out;
  }

  private isBirthday(e: CalendarEvent): boolean {
    return this.prefs.override("birthday", e.summary) ?? looksLikeBirthday(e);
  }

  private isTravel(e: CalendarEvent): boolean {
    return this.prefs.override("flight", e.summary) ?? looksLikeFlight(e);
  }

  private birthdays(events: CalendarEvent[], now: Date): PendingAlert[] {
    const lang = this.deps.language();
    const tz = this.deps.timezone;
    const today = localParts(now, tz).date;
    const out: PendingAlert[] = [];
    const seen = new Set<string>();
    for (const e of events) {
      if (e.status === "cancelled" || !this.isBirthday(e)) continue;
      // A birthday may be an all-day event or a timed one; either way it belongs to a calendar day in the owner's zone.
      const date = e.allDay ? e.start : Number.isFinite(Date.parse(e.start)) ? localParts(new Date(e.start), tz).date : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const days = daysBetween(today, date);
      if (days !== 0 && days !== 1) continue;
      const key = `birthday:${e.id}:${date}:${days}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, kind: "birthday", urgent: false, title: titleKey(e.summary), text: render(lang, days === 0 ? "birthdayToday" : "birthdayTomorrow", { title: sanitizeExternal(e.summary) }) });
    }
    return out;
  }

  private async travel(read: CalendarRead, now: Date, state: TriggerState): Promise<PendingAlert[]> {
    const cfg = this.deps.config;
    const lang = this.deps.language();
    const tz = this.deps.timezone;
    const rangeEnd = now.getTime() + cfg.flightHorizonDays * DAY;
    const out: PendingAlert[] = [];
    const seenIds = new Set<string>();
    const urgentAt = (start: string, allDay: boolean): boolean => {
      if (allDay) return false;
      const t = Date.parse(start);
      return Number.isFinite(t) && t > now.getTime() - HOUR && t - now.getTime() <= cfg.urgentFlightHours * HOUR;
    };
    const snapshotOf = (e: CalendarEvent): FlightSnapshot => ({ start: e.start, summary: sanitizeExternal(e.summary), seenAt: now.toISOString(), allDay: e.allDay });
    const meaningful = (minutes: number, allDay: boolean): boolean => (allDay ? Math.abs(minutes) >= 1440 : Math.abs(minutes) >= Math.max(1, cfg.flightChangeMinutes));

    /** A change alert from a snapshot to what the calendar shows now, or nothing when the move is too small to matter. */
    const changed = (id: string, snap: FlightSnapshot, e: CalendarEvent): PendingAlert | undefined => {
      const allDay = snap.allDay === true || e.allDay;
      const minutes = shiftMinutes(snap.start, snap.allDay === true, e.start, e.allDay);
      if (!meaningful(minutes, allDay)) return undefined; // not applied to the snapshot either, so small drifts add up until they matter
      const next = snapshotOf(e);
      return {
        key: `flight:${id}:${snap.start}>${e.start}`,
        kind: "flight",
        urgent: urgentAt(e.start, e.allDay) || urgentAt(snap.start, snap.allDay === true),
        title: titleKey(e.summary),
        text: render(lang, "flightChanged", { title: sanitizeExternal(e.summary), shift: formatShift(minutes, allDay, lang), old: formatWhen(snap.start, snap.allDay === true, tz, lang), now: formatWhen(e.start, e.allDay, tz, lang) }),
        commit: (s) => void (s.flights[id] = next),
      };
    };
    const cancelled = (id: string, snap: FlightSnapshot, title: string): PendingAlert => ({
      key: `flight-cancel:${id}`,
      kind: "flight",
      urgent: urgentAt(snap.start, snap.allDay === true),
      title: titleKey(title),
      text: render(lang, "flightCancelled", { title: sanitizeExternal(title), when: formatWhen(snap.start, snap.allDay === true, tz, lang) }),
      commit: (s) => void delete s.flights[id],
    });

    for (const e of read.events) {
      if (e.status !== "cancelled" && !this.isTravel(e)) {
        delete state.flights[e.id]; // no longer a trip (the owner said so, or the title changed): stop watching it
        continue;
      }
      if (e.status === "cancelled" && !state.flights[e.id]) continue; // never watched, nothing to report
      const at = startMs(e.start, e.allDay);
      if (!Number.isFinite(at)) continue;
      const snap = state.flights[e.id];
      if (e.status === "cancelled") {
        if (snap && startMs(snap.start, snap.allDay === true) > now.getTime()) out.push(cancelled(e.id, snap, e.summary));
        continue;
      }
      seenIds.add(e.id);
      if (at > rangeEnd || at < now.getTime() - DAY) continue;
      if (!snap) {
        // First sight is the baseline, never an alert: "changed" needs something to change from.
        state.flights[e.id] = snapshotOf(e);
        continue;
      }
      const alert = changed(e.id, snap, e);
      if (alert) out.push(alert);
    }

    // A watched plan that is gone from the normal window. Before saying so, look further ahead: it may simply have moved out of range.
    const candidates = read.complete ? Object.entries(state.flights).filter(([id, snap]) => !seenIds.has(id) && startMs(snap.start, snap.allDay === true) > now.getTime() && startMs(snap.start, snap.allDay === true) <= rangeEnd) : [];
    if (candidates.length > 0) {
      const wideDays = Math.min(365, Math.max(WIDE_DAYS_MIN, cfg.flightHorizonDays * 4));
      let wide: CalendarRead | undefined;
      try {
        wide = await this.deps.source.calendar({ from: now, to: new Date(now.getTime() + wideDays * DAY) });
      } catch (error) {
        this.fail("calendar (wide)", error); // cannot confirm, so say nothing
      }
      if (wide) {
        for (const [id, snap] of candidates) {
          const found = wide.events.find((e) => e.id === id);
          if (found && found.status === "cancelled") out.push(cancelled(id, snap, snap.summary));
          else if (found) {
            const alert = changed(id, snap, found);
            if (alert) out.push(alert);
          } else if (wide.complete) {
            out.push({
              key: `flight-missing:${id}:${snap.start}`,
              kind: "flight",
              urgent: urgentAt(snap.start, snap.allDay === true),
              title: titleKey(snap.summary),
              text: render(lang, "flightMissing", { title: snap.summary, when: formatWhen(snap.start, snap.allDay === true, tz, lang), days: wideDays }),
              commit: (s) => void delete s.flights[id],
            });
          }
        }
      }
    }

    // Plans already in the past are no longer watched.
    for (const [id, snap] of Object.entries(state.flights)) {
      const at = startMs(snap.start, snap.allDay === true);
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
        title: titleKey(m.subject),
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
      ...(raw.welcomed === true ? { welcomed: true } : {}),
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
