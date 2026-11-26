/**
 * What the owner told the trigger engine: pause everything, mute a kind or one item, and
 * correct its guesses ("that is not a flight", "that is a birthday"). Kept in its own file
 * so a chat tool can write it while a scan is running.
 */
import { normalizeText } from "./memory-search.js";
import type { StateDir } from "./state.js";

const FILE = "trigger-prefs.json";
const MAX_TITLES = 200;

export const TRIGGER_KIND_NAMES = ["invite", "birthday", "flight", "travel_mail"] as const;
export type TriggerKindName = (typeof TRIGGER_KIND_NAMES)[number];
export type Correctable = "flight" | "birthday";

/** A title reduced to what identifies it: case, spelling variants and punctuation removed. A series and its single instances share it. */
export function titleKey(title: string): string {
  return normalizeText(title).replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 80);
}

interface PrefsData {
  version: 1;
  paused: boolean;
  mutedKinds: string[];
  mutedTitles: Record<string, string[]>;
  overrides: Record<Correctable, Record<string, boolean>>;
}

export class TriggerPrefs {
  private readonly state: StateDir;

  constructor(state: StateDir) {
    this.state = state;
  }

  private load(): PrefsData {
    const raw = this.state.readJson<Partial<PrefsData>>(FILE, {});
    return {
      version: 1,
      paused: raw.paused === true,
      mutedKinds: Array.isArray(raw.mutedKinds) ? raw.mutedKinds.filter((k) => typeof k === "string") : [],
      mutedTitles: raw.mutedTitles && typeof raw.mutedTitles === "object" ? raw.mutedTitles : {},
      overrides: { flight: raw.overrides?.flight ?? {}, birthday: raw.overrides?.birthday ?? {} },
    };
  }

  private save(d: PrefsData): void {
    this.state.writeJson(FILE, d);
  }

  isPaused(): boolean {
    return this.load().paused;
  }

  setPaused(paused: boolean): void {
    const d = this.load();
    d.paused = paused;
    this.save(d);
  }

  /** Mute a whole kind (no title) or one title of that kind. */
  mute(kind: TriggerKindName, title?: string): void {
    const d = this.load();
    if (!title) {
      if (!d.mutedKinds.includes(kind)) d.mutedKinds.push(kind);
    } else {
      const k = titleKey(title);
      if (!k) throw new Error("that title is empty once cleaned");
      const list = (d.mutedTitles[kind] ??= []);
      if (!list.includes(k)) list.push(k);
      if (list.length > MAX_TITLES) list.shift();
    }
    this.save(d);
  }

  unmute(kind: TriggerKindName, title?: string): void {
    const d = this.load();
    if (!title) {
      d.mutedKinds = d.mutedKinds.filter((k) => k !== kind);
      delete d.mutedTitles[kind];
    } else {
      const k = titleKey(title);
      d.mutedTitles[kind] = (d.mutedTitles[kind] ?? []).filter((t) => t !== k);
    }
    this.save(d);
  }

  isMuted(kind: string, title?: string): boolean {
    const d = this.load();
    if (d.mutedKinds.includes(kind)) return true;
    return title ? (d.mutedTitles[kind] ?? []).includes(title) : false;
  }

  correct(kind: Correctable, title: string, is: boolean): void {
    const k = titleKey(title);
    if (!k) throw new Error("that title is empty once cleaned");
    const d = this.load();
    const map = d.overrides[kind];
    map[k] = is;
    const keys = Object.keys(map);
    if (keys.length > MAX_TITLES) delete map[keys[0]!];
    this.save(d);
  }

  override(kind: Correctable, title: string): boolean | undefined {
    return this.load().overrides[kind][titleKey(title)];
  }

  status(): { paused: boolean; mutedKinds: string[]; mutedTitles: Record<string, string[]>; notFlights: string[]; extraFlights: string[]; notBirthdays: string[]; extraBirthdays: string[] } {
    const d = this.load();
    const pick = (kind: Correctable, v: boolean): string[] => Object.entries(d.overrides[kind]).filter(([, x]) => x === v).map(([k]) => k);
    return { paused: d.paused, mutedKinds: d.mutedKinds, mutedTitles: d.mutedTitles, notFlights: pick("flight", false), extraFlights: pick("flight", true), notBirthdays: pick("birthday", false), extraBirthdays: pick("birthday", true) };
  }
}
