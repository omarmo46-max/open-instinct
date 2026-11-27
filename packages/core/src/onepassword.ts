/**
 * C8 1Password broker. The agent never holds a 1Password login. It runs the `op` command line
 * with a service-account token (limited to the vaults the owner listed) and only for one read at a
 * time. Nothing is cached beyond the short lease the SecretBroker keeps for redaction.
 */
import { execFile } from "node:child_process";

export type OpRunner = (args: string[], opts: { timeoutMs: number }) => Promise<string>;

const REF = /^op:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)(?:\/([^/\s]+))?$/;

export function defaultOpRunner(token: string, bin = "op"): OpRunner {
  return (args, { timeoutMs }) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 20, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OP_SERVICE_ACCOUNT_TOKEN: token } }, (error, stdout, stderr) => {
        if (error) reject(new Error(cleanError(stderr || error.message, token)));
        else resolve(stdout);
      });
    });
}

function cleanError(message: string, token: string): string {
  return message.split(token).join("***").replace(/\bops_[A-Za-z0-9+/=_-]{20,}/g, "***").replace(/\s+/g, " ").trim().slice(0, 200);
}

export interface OpItemSummary {
  id: string;
  title: string;
  category: string;
}

export class OnePasswordClient {
  private readonly run: OpRunner;
  private readonly vaults: string[];
  private readonly timeoutMs: number;

  constructor(opts: { run: OpRunner; vaults: string[]; timeoutMs?: number }) {
    this.run = opts.run;
    this.vaults = opts.vaults.map((v) => v.trim().toLowerCase()).filter(Boolean);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Vaults the owner allowed. With none listed, nothing can be read. */
  allowedVaults(): string[] {
    return [...this.vaults];
  }

  private allowed(vault: string): boolean {
    return this.vaults.includes(vault.toLowerCase());
  }

  static isRef(ref: string): boolean {
    return REF.test(ref.trim());
  }

  async read(ref: string): Promise<string> {
    const m = REF.exec(ref.trim());
    if (!m) throw new Error("not a 1Password reference (use op://Vault/Item/field)");
    const vault = decodeURIComponent(m[1]!);
    if (!this.allowed(vault)) throw new Error(`the vault "${vault}" is not on the allowed list`);
    const out = await this.run(["read", "--no-newline", ref.trim()], { timeoutMs: this.timeoutMs });
    if (!out) throw new Error("1Password returned nothing for that reference");
    return out;
  }

  async list(vault: string): Promise<OpItemSummary[]> {
    if (!this.allowed(vault)) throw new Error(`the vault "${vault}" is not on the allowed list`);
    const out = await this.run(["item", "list", "--vault", vault, "--format", "json"], { timeoutMs: this.timeoutMs });
    const rows = JSON.parse(out) as Array<{ id?: string; title?: string; category?: string }>;
    return rows.filter((r) => r.id && r.title).map((r) => ({ id: r.id!, title: r.title!, category: r.category ?? "" }));
  }

  async available(): Promise<boolean> {
    try {
      await this.run(["--version"], { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
