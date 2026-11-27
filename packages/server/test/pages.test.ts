import { describe, expect, it } from "vitest";
import { PageStore, handlePagesHttp } from "../src/pages.js";

function store() {
  const mem: Record<string, unknown> = {};
  return new PageStore({ readJson: (n: string, f: unknown) => (mem[n] ?? f) as never, writeJson: (n: string, v: unknown) => void (mem[n] = JSON.parse(JSON.stringify(v))) });
}
const mk = (s: PageStore, o: object) => s.create({ kind: "poll", title: "Where?", options: ["A", "B"], ...o }) as import("../src/pages.js").Page;

describe("pages", () => {
  it("validates, escapes and counts a poll", () => {
    const s = store();
    expect(typeof s.create({ kind: "poll", title: "x", options: ["only"] })).toBe("string");
    const p = mk(s, { title: "<b>Where?</b>", options: ["A", "<script>"] });
    const get = handlePagesHttp(s, "GET", `/p/${p.id}`, "", "c1")!;
    expect(get.status).toBe(200);
    expect(get.html).not.toContain("<script>");
    expect(get.html).toContain("&lt;script&gt;");
    expect(handlePagesHttp(s, "POST", `/p/${p.id}`, "choice=A", "c1")!.status).toBe(200);
    expect(handlePagesHttp(s, "POST", `/p/${p.id}`, "choice=Z", "c2")!.status).toBe(400);
    expect(s.tally(s.get(p.id)!)).toEqual([{ option: "A", votes: 1 }, { option: "<script>", votes: 0 }]);
  });
  it("blocks duplicate names, caps responses, rate-limits a client, and closes", () => {
    const s = store();
    const r = s.create({ kind: "rsvp", title: "Party", maxResponses: 2 }) as import("../src/pages.js").Page;
    expect(s.respond(r.id, { name: "Sam" }, "a")).toBeUndefined();
    expect(s.respond(r.id, { name: "sam" }, "b")).toBe("already in");
    expect(s.respond(r.id, { name: "" }, "b")).toBe("name required");
    expect(s.respond(r.id, { name: "Lina" }, "b")).toBeUndefined();
    expect(s.respond(r.id, { name: "Third" }, "c")).toBe("closed"); // full
    const p = mk(s, {});
    for (let i = 0; i < 5; i++) expect(s.respond(p.id, { choices: ["A"] }, "spam")).toBeUndefined();
    expect(s.respond(p.id, { choices: ["A"] }, "spam")).toBe("too many");
    expect(s.close(p.id)).toBe(true);
    expect(handlePagesHttp(s, "GET", `/p/${p.id}`, "", "z")!.status).toBe(410);
  });
  it("ignores other paths and unknown ids", () => {
    const s = store();
    expect(handlePagesHttp(s, "GET", "/status", "", "c")).toBeUndefined();
    expect(handlePagesHttp(s, "GET", "/p/pg_doesnotexist", "", "c")!.status).toBe(404);
  });
});
