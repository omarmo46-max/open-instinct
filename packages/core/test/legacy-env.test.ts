import { describe, expect, it } from "vitest";
import { applyLegacyEnv } from "../src/legacy-env.js";

describe("applyLegacyEnv", () => {
  it("copies old INSTINCT_ names to ORION_ when the new name is unset", () => {
    const env: NodeJS.ProcessEnv = { INSTINCT_MODEL: "anthropic/claude-sonnet-5-5", INSTINCT_CHAT_TOKEN: "t" };
    expect(applyLegacyEnv(env).sort()).toEqual(["INSTINCT_CHAT_TOKEN", "INSTINCT_MODEL"]);
    expect(env.ORION_MODEL).toBe("anthropic/claude-sonnet-5-5");
    expect(env.ORION_CHAT_TOKEN).toBe("t");
  });
  it("never overrides a value set under the new name", () => {
    const env: NodeJS.ProcessEnv = { INSTINCT_MODEL: "old", ORION_MODEL: "new" };
    expect(applyLegacyEnv(env)).toEqual([]);
    expect(env.ORION_MODEL).toBe("new");
  });
  it("leaves unrelated variables alone", () => {
    const env: NodeJS.ProcessEnv = { PORT: "8080" };
    expect(applyLegacyEnv(env)).toEqual([]);
    expect(env).toEqual({ PORT: "8080" });
  });
});
