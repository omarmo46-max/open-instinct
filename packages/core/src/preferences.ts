/**
 * Learned preferences for bookings (B4). The owner either states a preference ("window seat")
 * or the agent notices the same choice again and again. `applicable` returns what to apply
 * before a booking and what is still undecided, so the agent asks about the second kind.
 */
import type { StateDir } from "./state.js";

const FILE = "preferences.json";
const LEARN_AFTER = 3;
const LEARN_LEAD = 2;
const MAX_VALUES_PER_KEY = 8;
const MAX_KEYS = 200;

export interface PrefEntry {
  count: number;
  /** The owner said this outright (not just chose it). */
  stated: boolean;
  lastAt: string;
}

interface PrefData {
  version: 1;
  items: Record<string, Record<string, PrefEntry>>;
}

export interface AppliedPref {
  key: string;
  value: string;
  how: "stated" | "learned";
}

export interface PrefBrief {
  apply: AppliedPref[];
  /** Keys with competing choices and no clear winner: ask the owner. */
  undecided: Array<{ key: string; values: string[] }>;
}

const slug = (s: string): string => s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40);
const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

export class PreferenceStore {
  private readonly state: StateDir;
  private readonly now: () => Date;

  constructor(state: StateDir, now: () => Date = () => new Date()) {
    this.state = state;
    this.now = now;
  }

  private load(): PrefData {
    const raw = this.state.readJson<Partial<PrefData>>(FILE, {});
    return { version: 1, items: raw.items && typeof raw.items === "object" ? raw.items : {} };
  }

  /** Record a preference. `stated: true` makes it the winner at once; a plain choice only adds to its count. */
  note(category: string, key: string, value: string, stated: boolean): { key: string; value: string } {
    const k = `${slug(category)}.${slug(key)}`;
    const v = clean(value);
    if (k.length < 3 || k.startsWith(".") || k.endsWith(".") || !v) throw new Error("preference needs a category, a key and a value");
    const data = this.load();
    if (!data.items[k] && Object.keys(data.items).length >= MAX_KEYS) throw new Error("too many preferences stored; forget some first");
    const values = (data.items[k] ??= {});
    const entry = (values[v] ??= { count: 0, stated: false, lastAt: "" });
    entry.count += 1;
    entry.lastAt = this.now().toISOString();
    if (stated) {
      for (const other of Object.values(values)) other.stated = false; // the newest statement wins
      entry.stated = true;
    }
    const keep = Object.entries(values).sort((a, b) => Number(b[1].stated) - Number(a[1].stated) || b[1].count - a[1].count).slice(0, MAX_VALUES_PER_KEY);
    data.items[k] = Object.fromEntries(keep);
    this.state.writeJson(FILE, data);
    return { key: k, value: v };
  }

  /** What to apply for a category ("flight", "hotel", ...). An empty category returns all. */
  brief(category = ""): PrefBrief {
    const prefix = category ? `${slug(category)}.` : "";
    const apply: AppliedPref[] = [];
    const undecided: PrefBrief["undecided"] = [];
    for (const [key, values] of Object.entries(this.load().items)) {
      if (prefix && !key.startsWith(prefix)) continue;
      const ranked = Object.entries(values).sort((a, b) => Number(b[1].stated) - Number(a[1].stated) || b[1].count - a[1].count);
      const top = ranked[0];
      if (!top) continue;
      if (top[1].stated) apply.push({ key, value: top[0], how: "stated" });
      else if (top[1].count >= LEARN_AFTER && top[1].count - (ranked[1]?.[1].count ?? 0) >= LEARN_LEAD) apply.push({ key, value: top[0], how: "learned" });
      else if (ranked.length > 1 || top[1].count < LEARN_AFTER) undecided.push({ key, values: ranked.map(([v]) => v) });
    }
    return { apply, undecided: undecided.filter((u) => u.values.length > 1) };
  }

  forget(category: string, key?: string): number {
    const data = this.load();
    const target = key ? `${slug(category)}.${slug(key)}` : `${slug(category)}.`;
    let removed = 0;
    for (const k of Object.keys(data.items)) {
      if (key ? k === target : k.startsWith(target)) {
        delete data.items[k];
        removed++;
      }
    }
    if (removed) this.state.writeJson(FILE, data);
    return removed;
  }
}

/** The text a booking brief returns to the model. */
export function renderBrief(b: PrefBrief): string {
  if (b.apply.length === 0 && b.undecided.length === 0) return "No saved preferences for this. Ask the owner what matters, and save the answer with preference_note.";
  const lines: string[] = [];
  if (b.apply.length) lines.push("Apply these unless the owner says otherwise this time:", ...b.apply.map((p) => `- ${p.key} = ${p.value} (${p.how})`));
  if (b.undecided.length) lines.push("Not settled, ask the owner (do not guess):", ...b.undecided.map((u) => `- ${u.key}: ${u.values.join(" or ")}`));
  return lines.join("\n");
}
