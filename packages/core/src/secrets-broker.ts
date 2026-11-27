/**
 * Where stored secrets are resolved, authorized and kept out of sight. The model writes
 * `{{secret:vault:Netflix.password}}`; the runtime asks the owner; only then does this broker
 * put the value into the tool call, and it scrubs the value from whatever the tool returns.
 */
import type { OnePasswordClient } from "./onepassword.js";
import { findSecretRefs, replaceSecretRefs } from "./secret-refs.js";
import type { CredentialIssuer } from "./tool-identity.js";
import type { RegisteredTool, ToolResultLike } from "./tools.js";
import type { Vault } from "./vault.js";
import { hashArgs } from "./runtime.js";

export const REDACTED = "[secret]";

export class SecretBroker {
  private readonly vault: Vault | undefined;
  private readonly op: OnePasswordClient | undefined;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly leases = new Map<string, number>();
  private readonly grants = new Map<string, number>();
  private readonly tokens = new Map<string, string>();
  private readonly issuer: CredentialIssuer | undefined;

  constructor(opts: { vault?: Vault | undefined; op?: OnePasswordClient | undefined; issuer?: CredentialIssuer | undefined; now?: () => Date; leaseMs?: number }) {
    this.issuer = opts.issuer;
    this.vault = opts.vault;
    this.op = opts.op;
    this.now = opts.now ?? (() => new Date());
    this.leaseMs = opts.leaseMs ?? 120_000;
  }

  available(): boolean {
    return Boolean(this.vault?.configured || this.op);
  }

  /** Read one value. Not an authorization: the runtime has already got the owner's yes. */
  async resolve(ref: string): Promise<string> {
    const r = ref.trim();
    let value: string;
    if (r.startsWith("vault:")) {
      if (!this.vault?.configured) throw new Error("the vault is not set up");
      value = this.vault.lookup(r);
    } else if (r.startsWith("op://")) {
      if (!this.op) throw new Error("1Password is not set up");
      value = await this.op.read(r);
    } else throw new Error(`"${r}" is not a secret reference`);
    this.leases.set(value, this.now().getTime() + this.leaseMs); // known for a while, so it can be scrubbed from the result
    return value;
  }

  /**
   * The owner approved this exact call: allow it to fill in references once. With an issuer the
   * grant is a signed credential for that tool and those arguments, valid for two minutes, one use.
   */
  grant(argsHash: string, tool = "*", ttlMs = 120_000): void {
    if (this.issuer) {
      this.tokens.set(argsHash, this.issuer.issue({ subject: "owner-approval", audience: tool, scope: [argsHash], ttlSeconds: Math.round(ttlMs / 1000), singleUse: true }));
      return;
    }
    this.grants.set(argsHash, this.now().getTime() + ttlMs);
  }

  private consume(argsHash: string, tool: string): boolean {
    if (this.issuer) {
      const token = this.tokens.get(argsHash);
      this.tokens.delete(argsHash);
      if (!token) return false;
      try {
        this.issuer.verify(token, { audience: tool, scope: argsHash });
        return true;
      } catch {
        return false;
      }
    }
    const until = this.grants.get(argsHash);
    this.grants.delete(argsHash);
    return until !== undefined && until > this.now().getTime();
  }

  /** Every secret value known right now: the vault's and anything just read from 1Password. */
  knownValues(): string[] {
    const t = this.now().getTime();
    for (const [v, until] of this.leases) if (until <= t) this.leases.delete(v);
    let stored: string[] = [];
    try {
      stored = this.vault?.configured ? this.vault.secretValues() : [];
    } catch {
      stored = []; // a vault that cannot be opened has nothing to scrub
    }
    return [...new Set([...stored, ...this.leases.keys()])].filter((v) => v.length >= 4);
  }

  redact(text: string): string {
    let out = text;
    for (const v of this.knownValues().sort((a, b) => b.length - a.length)) out = out.split(v).join(REDACTED);
    return out;
  }

  private redactResult(r: ToolResultLike): ToolResultLike {
    if (typeof r === "string") return this.redact(r);
    return { ...r, content: r.content.map((p) => (p.type === "text" ? { ...p, text: this.redact(p.text) } : p)) };
  }

  /** The same tool, but it fills in approved references and scrubs secrets from what it returns. */
  wrap(tool: RegisteredTool): RegisteredTool {
    const spec = tool.spec;
    return {
      spec: {
        ...spec,
        execute: async (args, ctx, signal) => {
          let real = args;
          if (findSecretRefs(args).length > 0) {
            if (spec.meta.acceptsSecrets !== true) return { content: [{ type: "text", text: `${spec.name} cannot be given stored credentials.` }], isError: true };
            if (!this.consume(hashArgs(args), spec.name)) return { content: [{ type: "text", text: "Stored credentials were not approved for this call. Ask the owner first." }], isError: true };
            real = await replaceSecretRefs(args, (ref) => this.resolve(ref));
          }
          const result = await spec.execute(real, ctx, signal);
          // A tool whose job is to reveal a secret (after the owner's yes and step-up) must be able to say it.
          return spec.meta.secretAccess === true ? result : this.redactResult(result);
        },
      },
    };
  }
}
