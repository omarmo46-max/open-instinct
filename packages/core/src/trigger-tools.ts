/** Owner tools to steer the proactive alerts: mute, pause, and correct the agent's guesses. Owner only (`memory.write`). */
import { Type } from "typebox";
import { TRIGGER_KIND_NAMES, type TriggerKindName, type TriggerPrefs } from "./trigger-prefs.js";
import { defineTool, textResult, type RegisteredTool } from "./tools.js";

const KINDS = `${TRIGGER_KIND_NAMES.join(", ")}`;
const isKind = (k: string): k is TriggerKindName => (TRIGGER_KIND_NAMES as readonly string[]).includes(k);
const arg = (a: unknown, key: string): string => {
  const v = (a as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" ? v.slice(0, 120) : "";
};

export function triggerTools(prefs: TriggerPrefs): RegisteredTool[] {
  const meta = { capabilities: ["memory.write" as const], group: "memory" as const };
  return [
    defineTool({
      name: "trigger_feedback",
      label: "Correct an alert",
      description: "Correct the proactive alerts. Use when the owner says an event is not a flight or trip (is=false), is one (is=true), is not a birthday, or is one. kind: flight or birthday. title: the event's title as the owner or the alert wrote it.",
      parameters: Type.Object({ kind: Type.String({ description: "flight or birthday" }), title: Type.String(), is: Type.Boolean() }),
      meta: { ...meta, describe: (a) => `alert correction: ${arg(a, "title")}` },
      execute: async ({ kind, title, is }) => {
        if (kind !== "flight" && kind !== "birthday") return { content: [{ type: "text", text: "kind must be flight or birthday." }], isError: true };
        prefs.correct(kind, title, is);
        return textResult(`Got it: "${title}" ${is ? "is" : "is not"} a ${kind === "flight" ? "flight or trip" : "birthday"}.`);
      },
    }),
    defineTool({
      name: "trigger_mute",
      label: "Mute alerts",
      description: `Stop proactive alerts. kind: ${KINDS}, or all to pause every alert. With a title, only that one item is muted (for example one recurring meeting); without it the whole kind is. Use the title exactly as it appears in the alert or on the calendar (not a translation), because matching is by those words.`,
      parameters: Type.Object({ kind: Type.String(), title: Type.Optional(Type.String()) }),
      meta: { ...meta, describe: (a) => `mute alerts: ${arg(a, "kind")} ${arg(a, "title")}`.trim() },
      execute: async ({ kind, title }) => {
        if (kind === "all") {
          prefs.setPaused(true);
          return textResult("All proactive alerts are paused. Say when to resume.");
        }
        if (!isKind(kind)) return { content: [{ type: "text", text: `kind must be one of ${KINDS}, or all.` }], isError: true };
        prefs.mute(kind, title || undefined);
        return textResult(title ? `Muted ${kind} alerts about "${title}".` : `Muted all ${kind} alerts.`);
      },
    }),
    defineTool({
      name: "trigger_unmute",
      label: "Resume alerts",
      description: "Undo trigger_mute. kind all resumes everything that was paused.",
      parameters: Type.Object({ kind: Type.String(), title: Type.Optional(Type.String()) }),
      meta: { ...meta, describe: (a) => `resume alerts: ${arg(a, "kind")} ${arg(a, "title")}`.trim() },
      execute: async ({ kind, title }) => {
        if (kind === "all") {
          prefs.setPaused(false);
          return textResult("Proactive alerts resumed.");
        }
        if (!isKind(kind)) return { content: [{ type: "text", text: `kind must be one of ${KINDS}, or all.` }], isError: true };
        prefs.unmute(kind, title || undefined);
        return textResult(title ? `Resumed ${kind} alerts about "${title}".` : `Resumed ${kind} alerts.`);
      },
    }),
    defineTool({
      name: "trigger_status",
      label: "Alert settings",
      description: "Show what is paused or muted, and the corrections the owner made.",
      parameters: Type.Object({}),
      meta,
      execute: async () => {
        const s = prefs.status();
        const titles = Object.entries(s.mutedTitles).filter(([, v]) => v.length > 0).map(([k, v]) => `${k}: ${v.join(", ")}`);
        return textResult(
          [
            `Alerts: ${s.paused ? "paused" : "on"}.`,
            `Muted kinds: ${s.mutedKinds.join(", ") || "none"}.`,
            `Muted items: ${titles.join("; ") || "none"}.`,
            `Not trips: ${s.notFlights.join(", ") || "none"}. Extra trips: ${s.extraFlights.join(", ") || "none"}.`,
            `Not birthdays: ${s.notBirthdays.join(", ") || "none"}. Extra birthdays: ${s.extraBirthdays.join(", ") || "none"}.`,
          ].join("\n"),
        );
      },
    }),
  ];
}
