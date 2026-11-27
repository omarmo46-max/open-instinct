import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentKeyring, Identity, StateDir, type Principal, type RegisteredTool } from "@open-instinct/core";
import { decodeE2ee, describeE2ee, e2eeA2aTools, e2eeFileData, type E2eeData } from "../src/e2ee-a2a.js";

const OWNER: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Owner" };
const FRIEND: Principal = { kind: "contact", id: "contact:x", tier: "friend", displayName: "X", contactId: "x" };

function agent(handle: string) {
  const state = new StateDir(fs.mkdtempSync(path.join(os.tmpdir(), `e2ee-${handle}-`)));
  const ring = new AgentKeyring(state, Identity.load(state));
  const workspace = state.path("workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return { handle, state, ring, workspace };
}

/** Two agents wired together: whatever one sends over "A2A" is decoded for the other. */
function pair() {
  const alice = agent("alice");
  const bob = agent("bob");
  const inbox: Record<string, string[]> = { alice: [], bob: [] };
  const make = (me: ReturnType<typeof agent>, other: ReturnType<typeof agent>) => {
    const sent: unknown[] = [];
    const tools = e2eeA2aTools({
      a2a: { send: async (to: string, _text: string, data?: Record<string, unknown>) => { sent.push(data); const d = decodeE2ee(data); if (d) inbox[to]!.push(describeE2ee(d, other.ring, other.workspace)); return { taskId: "t1", contextId: "c1", state: "submitted" } as never; }, reply: async () => {} } as never,
      keyring: me.ring,
      contacts: { get: (id: string) => (id === other.handle ? { id, name: other.handle, agentHandle: `@${other.handle}` } : undefined), findByHandle: () => undefined } as never,
      audit: { append() {} },
      selfHandle: me.handle,
      workspace: me.workspace,
    });
    const run = (name: string, args: unknown, who: Principal = OWNER) => (tools.find((t: RegisteredTool) => t.spec.name === name)!.spec as any).execute(args, { principal: who, conversationKey: "k", channel: "imessage" });
    return { run, tools, sent };
  };
  return { alice, bob, inbox, a: make(alice, bob), b: make(bob, alice) };
}
const text = (r: any) => r.content[0].text as string;

describe("C5 over A2A", () => {
  it("keys are exchanged but never trusted automatically", async () => {
    const t = pair();
    await t.a.run("e2ee_share_keys_a2a", { contact: "bob" });
    expect(t.inbox.bob![0]).toContain("NOT trusted yet");
    expect(t.bob.ring.peer("alice")).toBeUndefined();
  });

  it("full flow: pin both ways, send a file, it arrives verified and decrypted", async () => {
    const t = pair();
    t.bob.ring.pinPeer("alice", t.alice.ring.bundle());
    t.alice.ring.pinPeer("bob", t.bob.ring.bundle());
    fs.writeFileSync(path.join(t.alice.workspace, "secret.txt"), "top secret plan");
    const r = await t.a.run("e2ee_send_file_a2a", { contact: "bob", path: "secret.txt" });
    expect(r.isError).toBeUndefined();
    expect(t.inbox.bob![0]).toContain("Verified encrypted file from @alice");
    const dir = path.join(t.bob.workspace, "received");
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, files[0]!), "utf8")).toBe("top secret plan");
    // the data on the wire is ciphertext only
    expect(JSON.stringify(t.a.sent)).not.toContain("top secret plan");
  });

  it("refuses: unpinned peer, outside the workspace, non-owner, oversized, missing file", async () => {
    const t = pair();
    fs.writeFileSync(path.join(t.alice.workspace, "a.txt"), "x");
    expect((await t.a.run("e2ee_send_file_a2a", { contact: "bob", path: "a.txt" })).isError).toBe(true); // no pinned keys
    t.alice.ring.pinPeer("bob", t.bob.ring.bundle());
    expect((await t.a.run("e2ee_send_file_a2a", { contact: "bob", path: "../../etc/passwd" })).isError).toBe(true);
    expect((await t.a.run("e2ee_send_file_a2a", { contact: "bob", path: "a.txt" }, FRIEND)).isError).toBe(true);
    expect((await t.a.run("e2ee_send_file_a2a", { contact: "bob", path: "nope.txt" })).isError).toBe(true);
    fs.writeFileSync(path.join(t.alice.workspace, "big.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
    expect((await t.a.run("e2ee_send_file_a2a", { contact: "bob", path: "big.bin" })).isError).toBe(true);
  });

  it("the receiver rejects unpinned senders, forged senders and tampered files", () => {
    const t = pair();
    const mallory = agent("mallory");
    mallory.ring.pinPeer("bob", t.bob.ring.bundle());
    const env = mallory.ring.encryptFor("bob", Buffer.from("evil"), { name: "x.txt" });
    // bob has never pinned mallory
    const unpinned = decodeE2ee(e2eeFileData("mallory", env)) as E2eeData;
    expect(describeE2ee(unpinned, t.bob.ring, t.bob.workspace)).toContain("not pinned");
    // mallory claims to be alice, but alice is pinned with a different key: the signature check fails
    t.bob.ring.pinPeer("alice", t.alice.ring.bundle());
    const forged = decodeE2ee(e2eeFileData("alice", env)) as E2eeData;
    expect(describeE2ee(forged, t.bob.ring, t.bob.workspace)).toContain("could not be opened");
    // a flipped byte
    t.alice.ring.pinPeer("bob", t.bob.ring.bundle());
    const good = t.alice.ring.encryptFor("bob", Buffer.from("hello"), { name: "h.txt" });
    const ct = Buffer.from(good.ct, "base64");
    ct[0] = ct[0]! ^ 1;
    const bad = decodeE2ee(e2eeFileData("alice", { ...good, ct: ct.toString("base64") })) as E2eeData;
    expect(describeE2ee(bad, t.bob.ring, t.bob.workspace)).toContain("could not be opened");
    expect(fs.existsSync(path.join(t.bob.workspace, "received"))).toBe(false);
  });

  it("decode ignores anything that is not a well formed e2ee part; no tools without A2A", () => {
    expect(decodeE2ee({ oip: "1" })).toBeUndefined();
    expect(decodeE2ee({ e2ee: "1", kind: "file", from_handle: "a b", envelope: {} })).toBeUndefined();
    expect(e2eeA2aTools({ keyring: pair().alice.ring, contacts: {} as never, audit: { append() {} }, workspace: "/tmp" })).toEqual([]);
  });
});
