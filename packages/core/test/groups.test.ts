import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { GroupRegistry, groupSlug } from "../src/groups.js";
import { groupTools } from "../src/group-tools.js";
import { GROUP_ROW, PolicyEngine, defaultPolicy } from "../src/policy.js";
import { groupPrincipal } from "../src/principal.js";
import type { ToolContext } from "../src/tools.js";
import { inbound, principalOf, tempState, testConfig } from "./helpers.js";

const KEY = "telegram:-100123";
const group = groupPrincipal(inbound({ channel: "telegram", from: "telegram:9", conversationKey: KEY, meta: { isGroup: true, groupTitle: "Trip\ncrew" } }));

describe("group permissions", () => {
  const policy = new PolicyEngine(tempState(), defaultPolicy());
  it("allows only talking, the public web, the group's notes and leaving the owner a message", () => {
    expect(group).toMatchObject({ kind: "group", id: `group:${KEY}`, tier: "stranger", displayName: "Trip crew" });
    for (const cap of ["converse", "web.read", "owner.relay", "group.notes"] as const) expect(policy.canEver(group, cap), cap).toBe(true);
    for (const cap of ["memory.write", "calendar.freebusy", "calendar.read", "email.read", "email.send", "contacts.read", "files.read", "computer.use", "apps.use", "purchase", "phone.call", "schedule.manage", "trust.manage", "network.ask", "plans.propose"] as const) {
      expect(policy.canEver(group, cap), cap).toBe(false);
    }
    expect(Object.keys(GROUP_ROW).sort()).toEqual(["converse", "group.notes", "owner.relay", "web.read"]);
  });
  it("keeps group notes away from every tier, the owner included", () => {
    for (const tier of ["owner", "partner", "friend", "stranger"] as const) expect(policy.canEver(principalOf(tier), "group.notes"), tier).toBe(false);
  });
  it("is not widened by a tier-level grant, and an owner-level principal still cannot use group notes", () => {
    expect(policy.canEver({ ...group, tier: "owner" }, "memory.write")).toBe(false);
  });
});

describe("GroupRegistry", () => {
  const make = () => {
    const state = tempState();
    const config = testConfig();
    return { state, config, reg: new GroupRegistry(state, config) };
  };
  it("remembers a pending group once, then allows it by title and persists it in config", () => {
    const { state, config, reg } = make();
    expect(reg.notePending(KEY, "Trip crew")).toBe(true);
    expect(reg.notePending(KEY, "Trip crew")).toBe(false);
    expect(reg.resolve("trip")).toEqual({ key: KEY, title: "Trip crew" });
    reg.allow(KEY, "Trip crew");
    expect(reg.isAllowed(KEY)).toBe(true);
    expect(reg.pending()).toEqual([]);
    expect(JSON.parse(state.readText("config.json"))["groups"].allow[0]).toMatchObject({ key: KEY, title: "Trip crew" });
    expect(config.groups?.allow).toHaveLength(1);
    expect(reg.remove(KEY)).toBe(true);
    expect(reg.remove(KEY)).toBe(false);
  });
  it("refuses an ambiguous or unknown group", () => {
    const { reg } = make();
    reg.notePending("telegram:-1", "Family A");
    reg.notePending("telegram:-2", "Family B");
    expect(reg.resolve("family")).toHaveProperty("error");
    expect(reg.resolve("nothing")).toHaveProperty("error");
    expect(reg.resolve("")).toHaveProperty("error");
  });
  it("keeps notes per group, one line each, newest when the file is full", () => {
    const { reg } = make();
    reg.appendNote(KEY, "dinner at 8\nsecond line", "Maria");
    expect(reg.readNotes(KEY)).toMatch(/^- \d{4}-\d{2}-\d{2} \(Maria\): dinner at 8 second line\n$/);
    expect(reg.readNotes("telegram:-999")).toBe("");
    for (let i = 0; i < 600; i++) reg.appendNote(KEY, `note ${i} ${"x".repeat(60)}`);
    expect(reg.readNotes(KEY).length).toBeLessThanOrEqual(20_000);
    expect(reg.readNotes(KEY)).toContain("note 599");
    expect(groupSlug("telegram:-100123")).toBe("telegram_-100123");
  });
});

describe("group tools", () => {
  const ctx = (principal: ToolContext["principal"], key = KEY): ToolContext => ({ principal, conversationKey: `${key}:${principal.id}`, deliveryKey: key, channel: "telegram", now: () => new Date() }) as ToolContext;
  const setup = () => {
    const state = tempState();
    const reg = new GroupRegistry(state, testConfig());
    const [notes, groups] = groupTools({ registry: reg, audit: new AuditLog(state) }).map((t) => t.spec);
    return { reg, notes: notes!, groups: groups! };
  };
  const text = (r: unknown) => JSON.stringify(r);

  it("group_notes works only inside an allowed group", async () => {
    const { reg, notes } = setup();
    await expect(notes.execute({ action: "read" }, ctx(group))).rejects.toThrow(/allowed/);
    reg.allow(KEY);
    await notes.execute({ action: "append", text: "Meet at the fountain" }, ctx(group));
    expect(text(await notes.execute({ action: "read" }, ctx(group)))).toContain("Meet at the fountain");
    await expect(notes.execute({ action: "read" }, ctx(principalOf("owner")))).rejects.toThrow(/allowed/);
    await expect(notes.execute({ action: "append", text: "x".repeat(501) }, ctx(group))).rejects.toThrow(/500/);
    await notes.execute({ action: "clear" }, ctx(group));
    expect(text(await notes.execute({ action: "read" }, ctx(group)))).toContain("no notes yet");
  });

  it("groups lets the owner list, allow and remove, and audits it", async () => {
    const { reg, groups } = setup();
    reg.notePending(KEY, "Trip crew");
    expect(text(await groups.execute({ action: "list" }, ctx(principalOf("owner"))))).toContain("Trip crew");
    expect(text(await groups.execute({ action: "allow", group: "trip" }, ctx(principalOf("owner"))))).toContain("Allowed");
    expect(reg.isAllowed(KEY)).toBe(true);
    expect(text(await groups.execute({ action: "remove", group: KEY }, ctx(principalOf("owner"))))).toContain("Stopped");
    await expect(groups.execute({ action: "allow", group: "ghost" }, ctx(principalOf("owner")))).rejects.toThrow(/no group matches/);
  });
});
