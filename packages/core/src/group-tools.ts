/**
 * Two tools for groups. `group_notes` is the only memory a group has: a small notebook kept per
 * group, readable and writable only from inside that group. `groups` is how the owner lets the
 * agent answer in a group (or stops it); nobody else can call it.
 */
import { Type } from "typebox";
import type { GroupRegistry } from "./groups.js";
import { GROUP_NOTES_MAX_CHARS } from "./groups.js";
import { defineTool, textResult } from "./tools.js";
import type { RegisteredTool } from "./tools.js";
import type { AuditLog } from "./audit.js";

export function groupTools({ registry, audit }: { registry: GroupRegistry; audit: AuditLog }): RegisteredTool[] {
  const notes = defineTool({
    name: "group_notes",
    label: "Group notes",
    description:
      "The notebook of the group you are in. action \"read\" shows it, \"append\" adds one short line (what the group asked you to remember), \"clear\" empties it. Only for things the group itself asked you to keep; never put private details about anyone here.",
    parameters: Type.Object({
      action: Type.String({ description: "\"read\", \"append\" or \"clear\"" }),
      text: Type.Optional(Type.String({ description: "The line to add, for append. One or two sentences." })),
    }),
    meta: { capabilities: ["group.notes"], group: "memory" },
    execute: async ({ action, text }, ctx) => {
      // The policy row already limits this to a group principal; the key must be the group's own thread.
      const key = ctx.deliveryKey ?? ctx.conversationKey;
      if (ctx.principal.kind !== "group" || !registry.isAllowed(key)) throw new Error("group_notes works only inside a group the owner allowed.");
      switch ((action ?? "").toLowerCase()) {
        case "read":
          return textResult(registry.readNotes(key).trim() || "(no notes yet)");
        case "append": {
          const line = (text ?? "").trim();
          if (!line) throw new Error("append needs text");
          if (line.length > 500) throw new Error("keep a note under 500 characters");
          registry.appendNote(key, line);
          return textResult(`Noted (the notebook keeps the latest ${GROUP_NOTES_MAX_CHARS.toLocaleString("en-US")} characters).`);
        }
        case "clear":
          registry.clearNotes(key);
          return textResult("Cleared this group's notes.");
        default:
          throw new Error('action must be "read", "append" or "clear"');
      }
    },
  });

  const groups = defineTool({
    name: "groups",
    label: "Manage groups",
    description:
      "Which groups you may answer in. action \"list\" shows allowed groups and groups that asked for you but are not allowed yet; \"allow\" lets you answer in a group (give its title or its key); \"remove\" stops. Only the owner can use this, and only when they ask.",
    parameters: Type.Object({
      action: Type.String({ description: "\"list\", \"allow\" or \"remove\"" }),
      group: Type.Optional(Type.String({ description: "The group's title (a part of it is enough) or its key, e.g. telegram:-1001234567890" })),
    }),
    meta: { capabilities: ["trust.manage"], group: "owner" },
    execute: async ({ action, group }, ctx) => {
      switch ((action ?? "").toLowerCase()) {
        case "list": {
          const allowed = registry.allowed().map((g) => `- ${g.title ?? g.key} (${g.key}), allowed ${g.allowedAt.slice(0, 10)}`);
          const pending = registry.pending().map((p) => `- ${p.title ?? p.key} (${p.key}), asked ${p.firstSeen.slice(0, 10)}`);
          return textResult([`Allowed groups:\n${allowed.join("\n") || "(none)"}`, `Waiting for your say-so:\n${pending.join("\n") || "(none)"}`].join("\n\n"));
        }
        case "allow": {
          const target = registry.resolve(group ?? "");
          if ("error" in target) throw new Error(target.error);
          registry.allow(target.key, target.title);
          audit.append({ kind: "policy", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { groupAllowed: target.key } });
          return textResult(`Allowed: I will answer in ${target.title ?? target.key} (public web and the group's own notes only).`);
        }
        case "remove": {
          const target = registry.resolve(group ?? "");
          if ("error" in target) throw new Error(target.error);
          const removed = registry.remove(target.key);
          audit.append({ kind: "policy", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { groupRemoved: target.key } });
          return textResult(removed ? `Stopped: I will stay silent in ${target.title ?? target.key}.` : `${target.title ?? target.key} was not allowed.`);
        }
        default:
          throw new Error('action must be "list", "allow" or "remove"');
      }
    },
  });

  return [notes, groups];
}
