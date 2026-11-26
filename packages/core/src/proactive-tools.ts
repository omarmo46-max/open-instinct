/** Owner tools for Phase B: memory search (B3), booking preferences (B4), places and arrival reminders (B5). All owner-only (`memory.write`). */
import { Type } from "typebox";
import type { MemorySearch } from "./memory-search.js";
import type { PlaceStore } from "./places.js";
import { renderBrief, type PreferenceStore } from "./preferences.js";
import { defineTool, textResult, type RegisteredTool } from "./tools.js";

const str = (v: unknown, max = 120): string => (typeof v === "string" ? v.slice(0, max) : "");

export interface ProactiveToolDeps {
  search: MemorySearch;
  prefs: PreferenceStore;
  /** Present only when INSTINCT_LOCATION=1. */
  places?: PlaceStore;
}

export function proactiveTools({ search, prefs, places }: ProactiveToolDeps): RegisteredTool[] {
  const tools: RegisteredTool[] = [
    defineTool({
      name: "memory_search",
      label: "Search memory",
      description: "Find notes in durable memory and the journals by what they mean (or by words when meaning search is off). Use it when the owner refers to something from before and the digest does not show it.",
      parameters: Type.Object({ query: Type.String({ description: "What to look for, in the owner's own words" }), limit: Type.Optional(Type.Number({ description: "1 to 10, default 5" })) }),
      meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `search memory: ${str((a as Record<string, unknown>)?.query)}` },
      execute: async ({ query, limit }) => {
        const r = await search.search(query, limit);
        if (r.hits.length === 0) return textResult(`Nothing found (${r.mode} search).${r.note ? ` ${r.note}` : ""}`);
        return textResult([`${r.mode} search${r.note ? ` (${r.note})` : ""}:`, ...r.hits.map((h) => `- [${h.source}] ${h.text}`)].join("\n"));
      },
    }),
    defineTool({
      name: "preference_note",
      label: "Save a preference",
      description: "Save how the owner likes things for bookings. stated=true when the owner says it outright (\"I always want a window seat\"); stated=false when they simply pick an option, so repeated choices can become a learned preference. category: flight, hotel, restaurant, transport, shopping, or your own short word.",
      parameters: Type.Object({ category: Type.String(), key: Type.String({ description: "For example seat, airline, room_type, cuisine, budget" }), value: Type.String(), stated: Type.Optional(Type.Boolean()) }),
      meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `preference: ${str((a as Record<string, unknown>)?.category)}.${str((a as Record<string, unknown>)?.key)} = ${str((a as Record<string, unknown>)?.value)}` },
      execute: async ({ category, key, value, stated }) => {
        const saved = prefs.note(category, key, value, stated === true);
        return textResult(`Saved ${saved.key} = ${saved.value}${stated === true ? " (stated)" : " (a choice; it becomes a learned preference after it repeats)"}.`);
      },
    }),
    defineTool({
      name: "booking_brief",
      label: "Booking preferences",
      description: "Call this BEFORE searching or booking a flight, hotel, restaurant, ride or purchase for the owner. Returns what to apply and what to ask. Spending approvals still apply as usual.",
      parameters: Type.Object({ category: Type.Optional(Type.String({ description: "flight, hotel, restaurant, ... Leave empty for all" })) }),
      meta: { capabilities: ["memory.write"], group: "memory" },
      execute: async ({ category }) => textResult(renderBrief(prefs.brief(category ?? ""))),
    }),
    defineTool({
      name: "preference_forget",
      label: "Forget preferences",
      description: "Remove one saved preference (category and key) or a whole category (key left empty).",
      parameters: Type.Object({ category: Type.String(), key: Type.Optional(Type.String()) }),
      meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `forget preference: ${str((a as Record<string, unknown>)?.category)}` },
      execute: async ({ category, key }) => textResult(`Removed ${prefs.forget(category, key || undefined)} preference(s).`),
    }),
  ];
  if (places) {
    tools.push(
      defineTool({
        name: "place_save",
        label: "Save a place",
        description: "Save a named place (home, office, pharmacy) with its coordinates so arrival reminders can work. Ask the owner for the place or have them share a map pin; never guess coordinates.",
        parameters: Type.Object({ name: Type.String(), latitude: Type.Number(), longitude: Type.Number(), radius_m: Type.Optional(Type.Number({ description: "50 to 2000, default 150" })) }),
        meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `save place: ${str((a as Record<string, unknown>)?.name)}` },
        execute: async ({ name, latitude, longitude, radius_m }) => {
          const p = places.savePlace(name, latitude, longitude, radius_m);
          return textResult(`Saved place ${p.name} (radius ${p.radiusM} m).`);
        },
      }),
      defineTool({
        name: "arrival_reminder",
        label: "Arrival reminder",
        description: "Remind the owner when they arrive at (or leave) a saved place. It fires once.",
        parameters: Type.Object({ place: Type.String(), text: Type.String(), when: Type.Optional(Type.String({ description: "arrive (default) or leave" })) }),
        meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `reminder at ${str((a as Record<string, unknown>)?.place)}: ${str((a as Record<string, unknown>)?.text)}` },
        execute: async ({ place, text, when }) => {
          const r = places.addReminder(place, text, when === "leave" ? "leave" : "arrive");
          return textResult(`I will remind you when you ${r.on} ${r.place}.`);
        },
      }),
      defineTool({
        name: "where_am_i",
        label: "Where is the owner",
        description: "The last saved place the owner was reported inside, and how old that report is. Also lists saved places and pending arrival reminders.",
        parameters: Type.Object({}),
        meta: { capabilities: ["memory.write"], group: "memory" },
        execute: async () => {
          const w = places.whereAmI();
          const lines = [w.at ? `Last report ${w.ageMinutes} min ago. Inside: ${w.inside.join(", ") || "none of the saved places"}.` : "No location report yet.", `Saved places: ${places.listPlaces().map((p) => p.name).join(", ") || "none"}.`, `Pending reminders: ${places.listReminders().map((r) => `${r.on} ${r.place}: ${r.text}`).join("; ") || "none"}.`];
          return textResult(lines.join("\n"));
        },
      }),
      defineTool({
        name: "place_remove",
        label: "Remove a place",
        description: "Delete a saved place and its reminders. Also deletes the stored last location when clear_history is true.",
        parameters: Type.Object({ name: Type.String(), clear_history: Type.Optional(Type.Boolean()) }),
        meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `remove place: ${str((a as Record<string, unknown>)?.name)}` },
        execute: async ({ name, clear_history }) => {
          const removed = places.removePlace(name);
          if (clear_history) places.clearHistory();
          return textResult(removed ? `Removed ${name}.${clear_history ? " Location history cleared." : ""}` : `No saved place called ${name}.`);
        },
      }),
    );
  }
  return tools;
}

/** What POST /location does: validate, update places, fire reminders. */
export class LocationService {
  private readonly places: PlaceStore;
  private readonly notify: (text: string) => Promise<boolean>;

  constructor(places: PlaceStore, notify: (text: string) => Promise<boolean>) {
    this.places = places;
    this.notify = notify;
  }

  async ingest(body: unknown): Promise<{ ok: boolean; events: number; fired: number; error?: string }> {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    try {
      let events;
      if (typeof b.place === "string" && (b.event === "arrive" || b.event === "leave")) events = this.places.report(b.place, b.event);
      else if (typeof b.lat === "number" && typeof b.lon === "number") events = this.places.fix(b.lat, b.lon, typeof b.accuracy === "number" ? b.accuracy : undefined);
      else return { ok: false, events: 0, fired: 0, error: "send {lat, lon, accuracy?} or {place, event: \"arrive\"|\"leave\"}" };
      let fired = 0;
      for (const r of this.places.take(events)) {
        if (await this.notify(`${r.on === "arrive" ? "📍" : "👋"} ${r.place}: ${r.text}`)) fired++;
        else this.places.addReminder(r.place, r.text, r.on); // not delivered: keep it for the next event
      }
      return { ok: true, events: events.length, fired };
    } catch (error) {
      return { ok: false, events: 0, fired: 0, error: (error as Error).message.slice(0, 200) };
    }
  }
}
