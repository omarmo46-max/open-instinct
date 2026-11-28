export interface User {
  id: string;
  email: string;
  name: string;
  passHash: string;
  verified: boolean;
  createdAt: string;
  /** The person's agent: its base URL, the owner token (sealed), and the hash of the secret the agent uses to call back. */
  agentUrl?: string;
  agentTokenSealed?: string;
  agentSecretHash?: string;
}

export interface Session {
  /** sha256 of the cookie value. */
  id: string;
  userId: string;
  csrf: string;
  createdAt: string;
  expiresAt: string;
}

export type CodePurpose = "verify" | "reset";
export interface CodeRecord {
  userId: string;
  purpose: CodePurpose;
  hash: string;
  expiresAt: string;
  attempts: number;
}

export type ModelStatus = "untested" | "active" | "failed" | "off";
export interface ModelConfig {
  userId: string;
  provider: string;
  model: string;
  baseUrl?: string;
  keySealed: string;
  keyLast4: string;
  enabled: boolean;
  status: ModelStatus;
  lastError?: string;
  updatedAt: string;
}

export interface Store {
  createUser(u: User): Promise<void>;
  userByEmail(email: string): Promise<User | undefined>;
  userById(id: string): Promise<User | undefined>;
  userBySecretHash(hash: string): Promise<User | undefined>;
  updateUser(id: string, patch: Partial<Omit<User, "id">>): Promise<void>;
  /** Removes the user and everything that belongs to them. */
  deleteUser(id: string): Promise<void>;
  putSession(s: Session): Promise<void>;
  getSession(id: string): Promise<Session | undefined>;
  deleteSession(id: string): Promise<void>;
  deleteUserSessions(userId: string, exceptId?: string): Promise<void>;
  putCode(c: CodeRecord): Promise<void>;
  getCode(userId: string, purpose: CodePurpose): Promise<CodeRecord | undefined>;
  deleteCode(userId: string, purpose: CodePurpose): Promise<void>;
  getModel(userId: string): Promise<ModelConfig | undefined>;
  putModel(m: ModelConfig): Promise<void>;
  deleteModel(userId: string): Promise<void>;
  close(): Promise<void>;
}

export class MemoryStore implements Store {
  users = new Map<string, User>();
  sessions = new Map<string, Session>();
  codes = new Map<string, CodeRecord>();
  models = new Map<string, ModelConfig>();
  async createUser(u: User) {
    if ([...this.users.values()].some((x) => x.email === u.email)) throw new Error("duplicate email");
    this.users.set(u.id, { ...u });
  }
  async userByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email);
  }
  async userById(id: string) {
    return this.users.get(id);
  }
  async userBySecretHash(hash: string) {
    return [...this.users.values()].find((u) => u.agentSecretHash === hash);
  }
  async updateUser(id: string, patch: Partial<Omit<User, "id">>) {
    const u = this.users.get(id);
    if (u) this.users.set(id, { ...u, ...patch });
  }
  async deleteUser(id: string) {
    this.users.delete(id);
    this.models.delete(id);
    for (const [k, s] of this.sessions) if (s.userId === id) this.sessions.delete(k);
    for (const k of [...this.codes.keys()]) if (k.startsWith(`${id}:`)) this.codes.delete(k);
  }
  async putSession(s: Session) {
    this.sessions.set(s.id, s);
  }
  async getSession(id: string) {
    return this.sessions.get(id);
  }
  async deleteSession(id: string) {
    this.sessions.delete(id);
  }
  async deleteUserSessions(userId: string, exceptId?: string) {
    for (const [k, s] of this.sessions) if (s.userId === userId && k !== exceptId) this.sessions.delete(k);
  }
  async putCode(c: CodeRecord) {
    this.codes.set(`${c.userId}:${c.purpose}`, c);
  }
  async getCode(userId: string, purpose: CodePurpose) {
    return this.codes.get(`${userId}:${purpose}`);
  }
  async deleteCode(userId: string, purpose: CodePurpose) {
    this.codes.delete(`${userId}:${purpose}`);
  }
  async getModel(userId: string) {
    return this.models.get(userId);
  }
  async putModel(m: ModelConfig) {
    this.models.set(m.userId, m);
  }
  async deleteModel(userId: string) {
    this.models.delete(userId);
  }
  async close() {}
}
