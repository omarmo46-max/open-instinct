/**
 * Habit learning (B2). Counts which local hours the owner writes in (hour only, never text),
 * and finds the quietest stretch of the clock: that is when the owner sleeps. Proactive alerts
 * and wake-aware schedules use it; until there is enough data they use the configured quiet hours.
 */
import { localParts } from "./scheduler.js";
import type { StateDir } from "./state.js";

const FILE = "habits.json";
const WINDOW_HOURS = 7;
const MIN_MESSAGES = 40;
const MIN_DAYS = 7;
const MAX_QUIET_SHARE = 0.05;
const DAYS_KEPT = 30;
const HALVE_AT = 3000;

interface HabitData {
  version: 1;
  hours: number[];
  days: string[];
  total: number;
}

export interface SleepWindow {
  from: string;
  to: string;
  /** False until enough days and messages were seen, or when no quiet stretch stands out. */
  confident: boolean;
}

const pad = (h: number): string => `${String(((h % 24) + 24) % 24).padStart(2, "0")}:00`;

export class HabitStore {
  private readonly state: StateDir;
  private readonly tz: string;

  constructor(state: StateDir, timezone: string) {
    this.state = state;
    this.tz = timezone;
  }

  private load(): HabitData {
    const raw = this.state.readJson<Partial<HabitData>>(FILE, {});
    const hours = Array.isArray(raw.hours) && raw.hours.length === 24 ? raw.hours.map((n) => (Number.isFinite(n) ? Number(n) : 0)) : new Array<number>(24).fill(0);
    return { version: 1, hours, days: Array.isArray(raw.days) ? raw.days.filter((d) => typeof d === "string") : [], total: hours.reduce((a, b) => a + b, 0) };
  }

  /** One owner message at `at`. Stores a count per hour and the set of days seen, nothing else. */
  record(at: Date): void {
    const data = this.load();
    const p = localParts(at, this.tz);
    data.hours[p.hour] = (data.hours[p.hour] ?? 0) + 1;
    if (!data.days.includes(p.date)) data.days = [...data.days, p.date].slice(-DAYS_KEPT);
    if (data.hours.reduce((a, b) => a + b, 0) > HALVE_AT) data.hours = data.hours.map((n) => n / 2);
    this.state.writeJson(FILE, { version: 1, hours: data.hours, days: data.days });
  }

  sleepWindow(): SleepWindow {
    const { hours, days, total } = this.load();
    let bestStart = 0;
    let bestSum = Infinity;
    for (let start = 0; start < 24; start++) {
      let sum = 0;
      for (let i = 0; i < WINDOW_HOURS; i++) sum += hours[(start + i) % 24] ?? 0;
      if (sum < bestSum) {
        bestSum = sum;
        bestStart = start;
      }
    }
    const confident = total >= MIN_MESSAGES && days.length >= MIN_DAYS && bestSum <= total * MAX_QUIET_SHARE;
    return { from: pad(bestStart), to: pad(bestStart + WINDOW_HOURS), confident };
  }

  summary(): { messages: number; days: number } {
    const d = this.load();
    return { messages: Math.round(d.total), days: d.days.length };
  }
}
