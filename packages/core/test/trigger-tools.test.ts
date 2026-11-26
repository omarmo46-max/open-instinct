import { describe, expect, it } from "vitest";
import { TriggerPrefs, titleKey } from "../src/trigger-prefs.js";
import { triggerTools } from "../src/trigger-tools.js";
import { tempState } from "./helpers.js";

const run = async (tools: ReturnType<typeof triggerTools>, name: string, args: Record<string, unknown>) => {
  const t = tools.find((x) => x.spec.name === name)!;
  const out = (await t.spec.execute(args as never, {} as never)) as { content: Array<{ text: string }>; isError?: boolean };
  return { text: out.content[0]!.text, isError: out.isError === true };
};

describe("trigger tools", () => {
  it("are owner-only and cover mute, resume, correct and status", async () => {
    const prefs = new TriggerPrefs(tempState());
    const tools = triggerTools(prefs);
    expect(tools.every((t) => t.spec.meta?.capabilities?.join() === "memory.write")).toBe(true);
    expect((await run(tools, "trigger_mute", { kind: "birthday" })).text).toContain("Muted all birthday");
    expect(prefs.isMuted("birthday")).toBe(true);
    expect((await run(tools, "trigger_mute", { kind: "invite", title: "Friday Standup" })).text).toContain("Friday Standup");
    expect(prefs.isMuted("invite", titleKey("friday standup"))).toBe(true);
    expect((await run(tools, "trigger_feedback", { kind: "flight", title: "Flight club", is: false })).text).toContain("is not a flight");
    expect(prefs.override("flight", "FLIGHT  club!")).toBe(false);
    expect((await run(tools, "trigger_status", {})).text).toContain("flight club");
    expect((await run(tools, "trigger_mute", { kind: "all" })).text).toContain("paused");
    expect(prefs.isPaused()).toBe(true);
    await run(tools, "trigger_unmute", { kind: "all" });
    await run(tools, "trigger_unmute", { kind: "birthday" });
    expect(prefs.isPaused()).toBe(false);
    expect(prefs.isMuted("birthday")).toBe(false);
  });
  it("matches a muted title by whole words, not by accident", () => {
    const prefs = new TriggerPrefs(tempState());
    prefs.mute("invite", "Friday standup");
    expect(prefs.isMuted("invite", titleKey("Friday standup weekly"))).toBe(true);
    expect(prefs.isMuted("invite", titleKey("Fridays standups"))).toBe(false);
    prefs.mute("invite", "hr");
    expect(prefs.isMuted("invite", titleKey("hr review"))).toBe(false); // too short to match inside a longer title
    prefs.correct("flight", "flight club", false);
    expect(prefs.override("flight", "Flight club meeting")).toBe(false);
    prefs.unmute("invite", "friday standup weekly");
    expect(prefs.isMuted("invite", titleKey("Friday standup"))).toBe(false);
  });
  it("rejects unknown kinds", async () => {
    const tools = triggerTools(new TriggerPrefs(tempState()));
    expect((await run(tools, "trigger_mute", { kind: "weather" })).isError).toBe(true);
    expect((await run(tools, "trigger_feedback", { kind: "invite", title: "x", is: true })).isError).toBe(true);
  });
});
