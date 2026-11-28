/**
 * Places and arrival awareness (B5). The owner's phone reports where it is (a location fix, or a
 * Shortcut automation saying "arrived at Home"). The agent keeps only the latest fix and a short
 * event list, matches fixes to the places the owner saved, and fires "when I arrive" reminders.
 * Off unless ORION_LOCATION=1. Nothing here is sent to a model or a third party.
 */
import { randomBytes } from "node:crypto";
import type { StateDir } from "./state.js";

const PLACES = "places.json";
const LAST = "location.json";
const MAX_PLACES = 30;
const MAX_REMINDERS = 50;
const MAX_EVENTS = 20;
const MAX_ACCURACY_M = 200;
const LEAVE_FACTOR = 1.3;
const DEFAULT_RADIUS_M = 150;

export interface Place {
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
}

export interface ArrivalReminder {
  id: string;
  place: string;
  on: "arrive" | "leave";
  text: string;
  createdAt: string;
}

export interface PlaceEvent {
  place: string;
  kind: "arrive" | "leave";
  at: string;
}

interface PlacesData {
  version: 1;
  places: Place[];
  reminders: ArrivalReminder[];
}

interface LastData {
  version: 1;
  lat?: number;
  lon?: number;
  at?: string;
  inside: string[];
  events: PlaceEvent[];
}

const cleanName = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
const same = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0 || a.toLowerCase() === b.toLowerCase();

export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const rad = (d: number): number => (d * Math.PI) / 180;
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLon - aLon) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class PlaceStore {
  private readonly state: StateDir;
  private readonly now: () => Date;

  constructor(state: StateDir, now: () => Date = () => new Date()) {
    this.state = state;
    this.now = now;
  }

  private data(): PlacesData {
    const raw = this.state.readJson<Partial<PlacesData>>(PLACES, {});
    return { version: 1, places: Array.isArray(raw.places) ? raw.places : [], reminders: Array.isArray(raw.reminders) ? raw.reminders : [] };
  }

  private last(): LastData {
    const raw = this.state.readJson<Partial<LastData>>(LAST, {});
    return { version: 1, ...(typeof raw.lat === "number" && typeof raw.lon === "number" ? { lat: raw.lat, lon: raw.lon } : {}), ...(raw.at ? { at: raw.at } : {}), inside: Array.isArray(raw.inside) ? raw.inside : [], events: Array.isArray(raw.events) ? raw.events : [] };
  }

  listPlaces(): Place[] {
    return this.data().places;
  }

  listReminders(): ArrivalReminder[] {
    return this.data().reminders;
  }

  savePlace(name: string, lat: number, lon: number, radiusM = DEFAULT_RADIUS_M): Place {
    const n = cleanName(name);
    if (!n) throw new Error("a place needs a name");
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new Error("latitude must be within ±90 and longitude within ±180");
    const radius = Math.min(2000, Math.max(50, Math.round(radiusM)));
    const d = this.data();
    const place: Place = { name: n, lat, lon, radiusM: radius };
    const i = d.places.findIndex((p) => same(p.name, n));
    if (i >= 0) d.places[i] = place;
    else if (d.places.length >= MAX_PLACES) throw new Error("too many saved places; remove one first");
    else d.places.push(place);
    this.state.writeJson(PLACES, d);
    return place;
  }

  removePlace(name: string): boolean {
    const d = this.data();
    const before = d.places.length;
    d.places = d.places.filter((p) => !same(p.name, name));
    d.reminders = d.reminders.filter((r) => !same(r.place, name));
    if (d.places.length === before) return false;
    this.state.writeJson(PLACES, d);
    return true;
  }

  addReminder(place: string, text: string, on: "arrive" | "leave" = "arrive"): ArrivalReminder {
    const d = this.data();
    const p = d.places.find((x) => same(x.name, place));
    if (!p) throw new Error(`unknown place "${cleanName(place)}"; save it first with place_save`);
    if (d.reminders.length >= MAX_REMINDERS) throw new Error("too many pending reminders");
    const t = text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!t) throw new Error("the reminder needs text");
    const r: ArrivalReminder = { id: `r_${randomBytes(4).toString("hex")}`, place: p.name, on, text: t, createdAt: this.now().toISOString() };
    d.reminders.push(r);
    this.state.writeJson(PLACES, d);
    return r;
  }

  /** Reminders for these events, removed from the list (each fires once). */
  take(events: PlaceEvent[]): ArrivalReminder[] {
    const d = this.data();
    const due = d.reminders.filter((r) => events.some((e) => e.kind === r.on && same(e.place, r.place)));
    if (due.length === 0) return [];
    d.reminders = d.reminders.filter((r) => !due.includes(r));
    this.state.writeJson(PLACES, d);
    return due;
  }

  /** A location fix. Returns the arrivals and departures it caused. Poor fixes are ignored. */
  fix(lat: number, lon: number, accuracyM?: number): PlaceEvent[] {
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new Error("bad coordinates");
    if (typeof accuracyM === "number" && accuracyM > MAX_ACCURACY_M) return [];
    const at = this.now().toISOString();
    const last = this.last();
    const inside = new Set(last.inside);
    const events: PlaceEvent[] = [];
    for (const p of this.listPlaces()) {
      const dist = distanceM(lat, lon, p.lat, p.lon);
      if (!inside.has(p.name) && dist <= p.radiusM) {
        inside.add(p.name);
        events.push({ place: p.name, kind: "arrive", at });
      } else if (inside.has(p.name) && dist > p.radiusM * LEAVE_FACTOR) {
        inside.delete(p.name);
        events.push({ place: p.name, kind: "leave", at });
      }
    }
    this.writeLast({ lat, lon, at, inside: [...inside], events: [...last.events, ...events].slice(-MAX_EVENTS) });
    return events;
  }

  /** An arrival or departure the phone reported itself (an iOS automation). Only for saved places. */
  report(place: string, kind: "arrive" | "leave"): PlaceEvent[] {
    const p = this.listPlaces().find((x) => same(x.name, place));
    if (!p) throw new Error(`unknown place "${cleanName(place)}"`);
    const last = this.last();
    const inside = new Set(last.inside);
    if (kind === "arrive" ? inside.has(p.name) : !inside.has(p.name)) return []; // already in that state
    if (kind === "arrive") inside.add(p.name);
    else inside.delete(p.name);
    const ev: PlaceEvent = { place: p.name, kind, at: this.now().toISOString() };
    this.writeLast({ ...last, inside: [...inside], events: [...last.events, ev].slice(-MAX_EVENTS) });
    return [ev];
  }

  private writeLast(d: Omit<LastData, "version">): void {
    this.state.writeJson(LAST, { version: 1, ...d });
  }

  /** Where the owner last was: saved places they are inside, and how old the report is. */
  whereAmI(): { inside: string[]; at?: string; ageMinutes?: number } {
    const l = this.last();
    const age = l.at ? Math.max(0, Math.round((this.now().getTime() - Date.parse(l.at)) / 60_000)) : undefined;
    return { inside: l.inside, ...(l.at ? { at: l.at } : {}), ...(age !== undefined ? { ageMinutes: age } : {}) };
  }

  /** Delete the last fix and the event list (not the saved places). */
  clearHistory(): void {
    this.state.writeJson(LAST, { version: 1, inside: [], events: [] });
  }
}
