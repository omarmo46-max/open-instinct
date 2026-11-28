/** Owner tools for Phase C: vault (C6), step-up (C7), 1Password (C8), encrypted files (C5), tool pins (C4). Owner only. */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { isInside } from "./attachments.js";
import { AgentKeyring, MAX_E2EE_BYTES, type Envelope, type PeerBundle } from "./e2ee.js";
import type { AuditLog } from "./audit.js";
import type { OnePasswordClient } from "./onepassword.js";
import type { StateDir } from "./state.js";
import { defineTool, textResult, type RegisteredTool, type ToolRegistry } from "./tools.js";
import { toolFingerprint, type ToolPins, type Identity } from "./tool-identity.js";
import { base32Decode, generateTotpSecret, otpauthUri, totp, verifyTotp, type StepUp } from "./totp.js";
import { isVaultType, maskCard, type Vault } from "./vault.js";
import { writePrivateFile } from "./tool-identity.js";

const MEMORY = { capabilities: ["memory.write" as const], group: "memory" as const };
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const arg = (a: unknown, k: string): string => {
  const v = (a as Record<string, unknown> | undefined)?.[k];
  return typeof v === "string" ? v.slice(0, 80) : "";
};

/** The TOTP secret for step-up. Kept in `keys/stepup.json` (mode 0600) until the owner confirms a first code. */
export class StepUpStore {
  private readonly state: StateDir;
  private pending: string | undefined;

  constructor(state: StateDir) {
    this.state = state;
  }

  secret(): string | undefined {
    const s = this.state.readJson<{ secret?: string }>("keys/stepup.json", {}).secret;
    return typeof s === "string" && s ? s : undefined;
  }

  begin(): string {
    this.pending = generateTotpSecret();
    return this.pending;
  }

  confirm(code: string): boolean {
    if (!this.pending || !verifyTotp(this.pending, code).ok) return false;
    writePrivateFile(this.state, "keys/stepup.json", { version: 1, secret: this.pending, enabledAt: new Date().toISOString() });
    this.pending = undefined;
    return true;
  }

  disable(): void {
    writePrivateFile(this.state, "keys/stepup.json", { version: 1 });
  }
}

export interface SecurityToolDeps {
  state: StateDir;
  vault?: Vault | undefined;
  stepUp?: StepUp | undefined;
  stepUpStore?: StepUpStore | undefined;
  op?: OnePasswordClient | undefined;
  keyring?: AgentKeyring | undefined;
  pins?: ToolPins | undefined;
  identity?: Identity | undefined;
  registry?: ToolRegistry | undefined;
  audit?: AuditLog | undefined;
  /** Wraps a tool the way the rest are wrapped (credential filling and redaction), when it is put back in service. */
  rewrap?: ((t: RegisteredTool) => RegisteredTool) | undefined;
  /** Tools taken out of service because they changed after being pinned. */
  quarantined?: Map<string, RegisteredTool> | undefined;
  issuer: string;
}

export function securityTools(d: SecurityToolDeps): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const workspace = d.state.path("workspace");

  if (d.vault) {
    const vault = d.vault;
    tools.push(
      defineTool({
        name: "vault_list",
        label: "List vault entries",
        description: "List what is saved in the vault (labels and a short hint only, never a password or a full card number).",
        parameters: Type.Object({}),
        meta: MEMORY,
        execute: async () => {
          if (!vault.configured) return fail("The vault is not set up (the operator has to set ORION_VAULT_KEY or ORION_VAULT_PASSPHRASE).");
          const rows = vault.list().filter((r) => !r.label.startsWith("_"));
          return textResult(rows.length ? rows.map((r) => `- ${r.label} [${r.type}] ${r.hint}`).join("\n") : "The vault is empty.");
        },
      }),
      defineTool({
        name: "vault_save",
        label: "Save to the vault",
        description:
          "Save a login, card, address or note in the encrypted vault. login: site, username, password (optional totpSecret). card: holder, number, expMonth, expYear (never the security code). address: name, line1, city, country. note: text. " +
          "The owner typed these in chat, so tell them to delete that message afterwards. To use a saved secret later, write {{secret:vault:Label.field}} in a tool call; never ask for it back.",
        parameters: Type.Object({ type: Type.String({ description: "login, card, address or note" }), label: Type.String(), fields: Type.Record(Type.String(), Type.String()) }),
        meta: { ...MEMORY, describe: (a) => `save to vault: ${arg(a, "label")}` },
        execute: async ({ type, label, fields }) => {
          if (!vault.configured) return fail("The vault is not set up.");
          try {
            const e = vault.put({ type, label, fields });
            return textResult(`Saved "${e.label}" (${e.type}). Tell the owner to delete the message that contained the details.`);
          } catch (error) {
            return fail((error as Error).message);
          }
        },
      }),
      defineTool({
        name: "vault_address",
        label: "Read a saved address",
        description: "Read a saved ADDRESS (not a login or card). Use it to fill in shipping or billing details.",
        parameters: Type.Object({ label: Type.String() }),
        meta: MEMORY,
        execute: async ({ label }) => {
          if (!vault.configured) return fail("The vault is not set up.");
          const e = vault.find(label);
          if (!e || e.type !== "address") return fail(`No saved address called "${label}".`);
          return textResult(Object.entries(e.fields).map(([k, v]) => `${k}: ${v}`).join("\n"));
        },
      }),
      defineTool({
        name: "vault_delete",
        label: "Delete a vault entry",
        description: "Delete one vault entry by label.",
        parameters: Type.Object({ label: Type.String() }),
        meta: { ...MEMORY, describe: (a) => `delete from vault: ${arg(a, "label")}` },
        execute: async ({ label }) => (vault.configured && vault.remove(label) ? textResult(`Deleted "${label}".`) : fail(`Nothing called "${label}".`)),
      }),
      defineTool({
        name: "vault_reveal",
        label: "Reveal a stored secret",
        description: "Show the full details of a login, card or note. The owner must approve, and enter a step-up code if one is set. Prefer {{secret:vault:Label.field}} in a tool call so the value never reaches you.",
        parameters: Type.Object({ label: Type.String() }),
        meta: { ...MEMORY, secretAccess: true, describe: (a) => `reveal vault entry: ${arg(a, "label")}` },
        execute: async ({ label }) => {
          if (!vault.configured) return fail("The vault is not set up.");
          const e = vault.find(label);
          if (!e) return fail(`Nothing called "${label}".`);
          const f = { ...e.fields };
          if (e.type === "card" && f.number) f.number = `${f.number} (${maskCard(f.number)})`;
          return textResult(Object.entries(f).map(([k, v]) => `${k}: ${v}`).join("\n"));
        },
      }),
      defineTool({
        name: "totp_code",
        label: "Current login code",
        description: "The current 6-digit code for a login that has a saved authenticator secret. The owner must approve.",
        parameters: Type.Object({ label: Type.String() }),
        meta: { ...MEMORY, secretAccess: true, describe: (a) => `login code for: ${arg(a, "label")}` },
        execute: async ({ label }) => {
          if (!vault.configured) return fail("The vault is not set up.");
          const e = vault.find(label);
          const secret = e?.fields.totpSecret;
          if (!e || !secret) return fail(`"${label}" has no saved authenticator secret.`);
          try {
            base32Decode(secret);
            return textResult(`${totp(secret)} (valid for under 30 seconds)`);
          } catch {
            return fail("The saved authenticator secret is not valid.");
          }
        },
      }),
    );
  }

  if (d.stepUpStore) {
    const store = d.stepUpStore;
    tools.push(
      defineTool({
        name: "stepup_enroll",
        label: "Set up step-up codes",
        description: "Start step-up: returns a secret and an otpauth link to add to an authenticator app. It only takes effect after stepup_confirm with a code from the app.",
        parameters: Type.Object({}),
        meta: MEMORY,
        execute: async () => {
          const secret = store.begin();
          return textResult(`Add this to an authenticator app (Google Authenticator, Authy, 1Password):\nSecret: ${secret}\nLink: ${otpauthUri({ secret, account: "owner", issuer: d.issuer })}\nThen send me a code with stepup_confirm.`);
        },
      }),
      defineTool({
        name: "stepup_confirm",
        label: "Confirm step-up setup",
        description: "Finish step-up setup with the 6-digit code the authenticator app shows now.",
        parameters: Type.Object({ code: Type.String() }),
        meta: MEMORY,
        execute: async ({ code }) => (store.confirm(code) ? textResult("Step-up is on. From now on a code is needed before a stored secret is used or revealed.") : fail("That code did not match. Check the app and try again.")),
      }),
      defineTool({
        name: "stepup_disable",
        label: "Turn off step-up",
        description: "Turn step-up off. The owner must approve and be verified first.",
        parameters: Type.Object({}),
        meta: { ...MEMORY, secretAccess: true },
        execute: async () => {
          store.disable();
          return textResult("Step-up is off.");
        },
      }),
    );
  }

  if (d.op) {
    const op = d.op;
    tools.push(
      defineTool({
        name: "op_list",
        label: "List 1Password items",
        description: "List item titles in an allowed 1Password vault (no secrets).",
        parameters: Type.Object({ vault: Type.String() }),
        meta: MEMORY,
        execute: async ({ vault }) => {
          try {
            const items = await op.list(vault);
            return textResult(items.length ? items.map((i) => `- ${i.title} (${i.category})`).join("\n") : "No items.");
          } catch (error) {
            return fail((error as Error).message);
          }
        },
      }),
      defineTool({
        name: "op_reveal",
        label: "Reveal a 1Password secret",
        description: "Read one field, for example op://Personal/Netflix/password. The owner must approve. Prefer {{secret:op://...}} in a tool call so the value never reaches you.",
        parameters: Type.Object({ ref: Type.String() }),
        meta: { ...MEMORY, secretAccess: true, describe: (a) => `reveal 1Password field: ${arg(a, "ref")}` },
        execute: async ({ ref }) => {
          try {
            return textResult(await op.read(ref));
          } catch (error) {
            return fail((error as Error).message);
          }
        },
      }),
    );
  }

  if (d.keyring) {
    const ring = d.keyring;
    const inside = (p: string): string => {
      const full = path.resolve(workspace, p);
      if (!isInside(workspace, full)) throw new Error("files must be inside the workspace folder");
      return full;
    };
    tools.push(
      defineTool({
        name: "e2ee_my_keys",
        label: "My encryption keys",
        description: "Your public encryption keys. Give them to a peer so they can send you encrypted files. Public keys only.",
        parameters: Type.Object({}),
        meta: MEMORY,
        execute: async () => textResult(JSON.stringify(ring.bundle(), null, 1)),
      }),
      defineTool({
        name: "e2ee_pin_peer",
        label: "Trust a peer's keys",
        description: "Save a peer's public keys (the JSON from their e2ee_my_keys). A different key for the same peer later is refused. Check the fingerprint with them first.",
        parameters: Type.Object({ peer: Type.String(), keys: Type.String({ description: "their JSON bundle" }) }),
        meta: { ...MEMORY, describe: (a) => `trust encryption keys of ${arg(a, "peer")}` },
        execute: async ({ peer, keys }) => {
          try {
            const b = JSON.parse(keys) as PeerBundle;
            return textResult(`${ring.pinPeer(peer, b)}: ${peer}`);
          } catch (error) {
            return fail((error as Error).message);
          }
        },
      }),
      defineTool({
        name: "e2ee_encrypt_file",
        label: "Encrypt a file for a peer",
        description: "Encrypt a workspace file so only the pinned peer can read it. Writes <file>.enc.json next to it.",
        parameters: Type.Object({ path: Type.String(), peer: Type.String() }),
        meta: { capabilities: ["files.read", "files.write"], group: "memory", describe: (a) => `encrypt ${arg(a, "path")} for ${arg(a, "peer")}` },
        execute: async ({ path: p, peer }) => {
          try {
            const full = inside(p);
            const st = fs.statSync(full);
            if (!st.isFile() || st.size > MAX_E2EE_BYTES) return fail("that is not a file, or it is larger than 25 MB");
            const env = ring.encryptFor(peer, fs.readFileSync(full), { name: path.basename(full) });
            const out = `${full}.enc.json`;
            fs.writeFileSync(out, JSON.stringify(env));
            return textResult(`Encrypted for ${peer}: ${path.relative(workspace, out)}`);
          } catch (error) {
            return fail((error as Error).message);
          }
        },
      }),
      defineTool({
        name: "e2ee_decrypt_file",
        label: "Decrypt a file from a peer",
        description: "Decrypt a .enc.json file from a pinned peer into the workspace. Fails if it was changed, signed by someone else, or made for someone else.",
        parameters: Type.Object({ path: Type.String(), peer: Type.String() }),
        meta: { capabilities: ["files.read", "files.write"], group: "memory", describe: (a) => `decrypt ${arg(a, "path")} from ${arg(a, "peer")}` },
        execute: async ({ path: p, peer }) => {
          try {
            const full = inside(p);
            const env = JSON.parse(fs.readFileSync(full, "utf8")) as Envelope;
            const { data, name } = ring.decryptFrom(peer, env);
            const safe = path.basename(name ?? "decrypted.bin").replace(/[^\w.-]+/g, "_") || "decrypted.bin";
            const out = path.join(path.dirname(full), `decrypted-${safe}`);
            fs.writeFileSync(out, data);
            return textResult(`Decrypted ${data.length} bytes to ${path.relative(workspace, out)}`);
          } catch (error) {
            return fail((error as Error).message);
          }
        },
      }),
    );
  }

  if (d.audit) {
    const audit = d.audit;
    tools.push(
      defineTool({
        name: "audit_verify",
        label: "Check the activity log",
        description: "Check that the activity log has not been edited or had lines removed. Reports the first broken line.",
        parameters: Type.Object({}),
        meta: { capabilities: ["trust.manage"], group: "memory" },
        execute: async () => {
          const r = audit.verify();
          return textResult(r.ok ? `The log is intact: ${r.entries} entries${r.unchained ? ` (${r.unchained} older ones were written before chaining)` : ""}${r.torn ? `, ${r.torn} torn line(s) from a crash` : ""}.` : `The log was changed: the chain breaks at line ${r.brokenAt}.`);
        },
      }),
    );
  }

  if (d.pins && d.quarantined && d.registry) {
    const { pins, quarantined, registry } = d;
    tools.push(
      defineTool({
        name: "tool_pins",
        label: "Tool identity",
        description: "Show which tools are pinned and which were taken out of service because their description or schema changed after being pinned.",
        parameters: Type.Object({}),
        meta: { capabilities: ["trust.manage"], group: "memory" },
        execute: async () => {
          const q = [...quarantined.keys()];
          return textResult([`Pinned tools: ${pins.list().length}.`, q.length ? `Quarantined (changed since pinned): ${q.join(", ")}.` : "No tool has changed since it was pinned.", d.identity ? `Agent identity: ${d.identity.fingerprint}.` : ""].filter(Boolean).join("\n"));
        },
      }),
      defineTool({
        name: "tool_pin_approve",
        label: "Accept a changed tool",
        description: "Accept a quarantined tool as it is now and put it back in service. Only after the owner has looked at what changed.",
        parameters: Type.Object({ name: Type.String() }),
        meta: { capabilities: ["trust.manage"], group: "memory", describe: (a) => `accept changed tool ${arg(a, "name")}` },
        execute: async ({ name }) => {
          const tool = quarantined.get(name);
          if (!tool) return fail(`${name} is not quarantined.`);
          pins.approve(tool);
          registry.register(d.rewrap ? d.rewrap(tool) : tool);
          quarantined.delete(name);
          return textResult(`${name} accepted (fingerprint ${toolFingerprint(tool).slice(0, 12)}) and back in service.`);
        },
      }),
    );
  }
  return tools;
}
