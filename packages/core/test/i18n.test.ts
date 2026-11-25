import { describe, expect, it } from "vitest";
import { detectLanguage, isNewConversationCommand, pickLanguage, t } from "../src/i18n.js";
import { buildSystemPrompt, type PromptInput } from "../src/prompt.js";
import { principalOf, testConfig } from "./helpers.js";

describe("detectLanguage", () => {
  it("reads the script, not the words", () => {
    expect(detectLanguage("أنا عايز أحجز طيارة لبكرة")).toBe("ar");
    expect(detectLanguage("book me a flight tomorrow")).toBe("en");
    expect(detectLanguage("احجزلي على Emirates يوم 12/3")).toBe("ar");
    expect(detectLanguage("ok تمام")).toBe("ar");
    expect(detectLanguage("https://example.com/a?b=1 هذا الرابط")).toBe("ar");
  });
  it("says nothing without letters", () => {
    expect(detectLanguage("")).toBeUndefined();
    expect(detectLanguage("👍 123 !!!")).toBeUndefined();
  });
});

describe("pickLanguage", () => {
  it("lets a pinned language win, then the message, then the locale", () => {
    expect(pickLanguage({ language: "ar" }, "hello")).toBe("ar");
    expect(pickLanguage({ language: "en" }, "مرحبا")).toBe("en");
    expect(pickLanguage({ language: "auto" }, "مرحبا")).toBe("ar");
    expect(pickLanguage({ locale: "ar-EG" }, undefined)).toBe("ar");
    expect(pickLanguage({}, undefined)).toBe("en");
    expect(pickLanguage(undefined, "hi")).toBe("en");
  });
  it("has every string in both languages", () => {
    for (const key of ["ackDefault", "ackEmail", "ackChat", "ackA2a", "newConversation", "newConversationStranger", "claimWelcome"] as const) {
      expect(t("en", key).length).toBeGreaterThan(0);
      expect(/[\u0600-\u06FF]/.test(t("ar", key)), key).toBe(true);
    }
  });
});

describe("isNewConversationCommand", () => {
  it("accepts the command in a few spellings and nothing else", () => {
    for (const ok of ["/new", " /NEW ", "/new@MyBot", "/reset", "محادثة جديدة", "ابدأ من جديد!", "/جديد"]) expect(isNewConversationCommand(ok), ok).toBe(true);
    for (const no of ["new", "/new york restaurants", "start a new chat please", "جديد", ""]) expect(isNewConversationCommand(no), no).toBe(false);
  });
});

describe("language prompt layer", () => {
  const input = (owner: Parameters<typeof testConfig>[0] = {}): PromptInput => ({
    config: testConfig(owner),
    principal: principalOf("owner"),
    channel: "telegram",
    capabilities: [],
    toolGroups: [],
    memoryDigest: "",
    now: new Date("2026-11-24T10:00:00Z"),
  } as unknown as PromptInput);

  it("always tells the model to mirror the person's language and dialect", () => {
    const text = buildSystemPrompt(input());
    expect(text).toContain("# Language");
    expect(text).toContain("match their dialect");
    expect(text).not.toContain("preferred language");
  });
  it("adds the owner's Arabic preference and dialect", () => {
    const text = buildSystemPrompt(input({ language: "ar", locale: "ar-EG" }));
    expect(text).toContain("preferred language is Arabic, Egyptian Arabic");
    expect(buildSystemPrompt(input({ locale: "ar-SA" }))).toContain("Gulf");
  });
  it("respects a pinned English", () => {
    expect(buildSystemPrompt(input({ language: "en", locale: "ar-EG" }))).toContain("preferred language is English");
  });
});
