/**
 * Groups the agent may answer in. A group is a shared audience: every reply is read by everyone
 * in it, and the owner does not know who they all are. So the agent stays silent in a group until
 * the owner allows it, and an allowed group gets its own small permission set (policy.ts GROUP_ROW),
 * its own notes, and no view of the owner's memory, accounts, files or people.
 */
import type { StateDir } from "./state.js";
import type { AllowedGroup, InstinctConfig } from "./types.js";
import { saveConfig } from "./config.js";

const PENDING_FILE = "groups-pending.json";
const NOTES_DIR = "groups";
export const GROUP_NOTES_MAX_CHARS = 20_000;
const PENDING_MAX = 50;

export interface PendingGroup {
  key: string;
  title?: string;
  firstSeen: string;
}

/** `telegram:-1001234` to a file-safe name. */
export function groupSlug(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "group";
}

export class GroupRegistry {
  constructor(
    private readonly state: StateDir,
    private readonly config: InstinctConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  allowed(): AllowedGroup[] {
    return [...(this.config.groups?.allow ?? [])];
  }

  isAllowed(key: string): boolean {
    return (this.config.groups?.allow ?? []).some((g) => g.key === key);
  }

  pending(): PendingGroup[] {
    return Object.entries(this.state.readJson<Record<string, { title?: string; firstSeen: string }>>(PENDING_FILE, {})).map(([key, v]) => ({ key, ...v }));
  }

  /** Remember a group that spoke to the agent before it was allowed. True the first time, so the owner is told once. */
  notePending(key: string, title?: string): boolean {
    const all = this.state.readJson<Record<string, { title?: string; firstSeen: string }>>(PENDING_FILE, {});
    if (all[key]) return false;
    all[key] = { ...(title ? { title: title.slice(0, 120) } : {}), firstSeen: this.now().toISOString() };
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - PENDING_MAX))) delete all[old];
    this.state.writeJson(PENDING_FILE, all);
    return true;
  }

  /** The group a person means: an exact key, or a title that matches exactly one pending or allowed group. */
  resolve(ref: string): { key: string; title?: string } | { error: string } {
    const q = ref.trim();
    if (!q) return { error: "say which group (its key or its title)" };
    const known = [...this.pending().map((p) => ({ key: p.key, ...(p.title ? { title: p.title } : {}) })), ...this.allowed().map((a) => ({ key: a.key, ...(a.title ? { title: a.title } : {}) }))];
    const exact = known.find((k) => k.key === q);
    if (exact) return exact;
    if (/^telegram:-?\d+$/.test(q)) return { key: q };
    const byTitle = known.filter((k) => k.title && k.title.toLowerCase().includes(q.toLowerCase()));
    const unique = [...new Map(byTitle.map((k) => [k.key, k])).values()];
    if (unique.length === 1) return unique[0]!;
    return { error: unique.length === 0 ? `no group matches "${q}"` : `several groups match "${q}": ${unique.map((u) => `${u.title ?? u.key} (${u.key})`).join(", ")}` };
  }

  allow(key: string, title?: string): void {
    const groups = this.config.groups ?? { allow: [] };
    if (!groups.allow.some((g) => g.key === key)) groups.allow.push({ key, ...(title ? { title } : {}), allowedAt: this.now().toISOString() });
    this.config.groups = groups;
    saveConfig(this.state, this.config);
    const all = this.state.readJson<Record<string, unknown>>(PENDING_FILE, {});
    if (key in all) {
      delete all[key];
      this.state.writeJson(PENDING_FILE, all);
    }
  }

  remove(key: string): boolean {
    const groups = this.config.groups;
    if (!groups) return false;
    const before = groups.allow.length;
    groups.allow = groups.allow.filter((g) => g.key !== key);
    if (groups.allow.length === before) return false;
    saveConfig(this.state, this.config);
    return true;
  }

  // ---- the group's own notes ----

  notesPath(key: string): string {
    return this.state.path(NOTES_DIR, `${groupSlug(key)}.md`);
  }

  readNotes(key: string): string {
    try {
      return this.state.readText(`${NOTES_DIR}/${groupSlug(key)}.md`) ?? "";
    } catch {
      return "";
    }
  }

  appendNote(key: string, text: string, author?: string): void {
    const line = `- ${this.now().toISOString().slice(0, 10)}${author ? ` (${author.replace(/[\r\n]+/g, " ").slice(0, 40)})` : ""}: ${text.replace(/[\r\n]+/g, " ").trim()}`;
    let notes = `${this.readNotes(key).trimEnd()}\n${line}`.trim();
    // Keep the newest notes when the file outgrows its cap.
    while (notes.length > GROUP_NOTES_MAX_CHARS) notes = notes.slice(notes.indexOf("\n") + 1);
    this.state.writeText(`${NOTES_DIR}/${groupSlug(key)}.md`, `${notes}\n`);
  }

  clearNotes(key: string): void {
    this.state.writeText(`${NOTES_DIR}/${groupSlug(key)}.md`, "");
  }
}
