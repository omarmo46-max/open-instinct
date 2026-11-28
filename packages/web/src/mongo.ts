/** MongoDB storage. Indexes make email unique and let sessions and codes expire on their own. */
import { MongoClient, type Collection, type Db } from "mongodb";
import type { CodePurpose, CodeRecord, ModelConfig, Session, Store, User } from "./store.js";

type Doc<T> = Omit<T, "id"> & { _id: string };
const strip = <T extends object>(d: (Omit<T, "id"> & { _id: string }) | null): (T & { id: string }) | undefined => {
  if (!d) return undefined;
  const { _id, ...rest } = d as { _id: string } & Record<string, unknown>;
  return { id: _id, ...rest } as unknown as T & { id: string };
};

export class MongoStore implements Store {
  private constructor(private readonly client: MongoClient, private readonly db: Db) {}

  static async connect(uri: string, dbName: string): Promise<MongoStore> {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const s = new MongoStore(client, client.db(dbName));
    await s.users.createIndex({ email: 1 }, { unique: true });
    await s.users.createIndex({ agentSecretHash: 1 }, { sparse: true });
    await s.sessions.createIndex({ expiresAtDate: 1 }, { expireAfterSeconds: 0 });
    await s.sessions.createIndex({ userId: 1 });
    await s.codes.createIndex({ expiresAtDate: 1 }, { expireAfterSeconds: 0 });
    return s;
  }

  private get users(): Collection<Doc<User>> {
    return this.db.collection("users");
  }
  private get sessions(): Collection<Doc<Session> & { expiresAtDate: Date }> {
    return this.db.collection("sessions");
  }
  private get codes(): Collection<{ _id: string } & CodeRecord & { expiresAtDate: Date }> {
    return this.db.collection("codes");
  }
  private get models(): Collection<{ _id: string } & Omit<ModelConfig, "userId">> {
    return this.db.collection("models");
  }

  async createUser(u: User) {
    const { id, ...rest } = u;
    await this.users.insertOne({ _id: id, ...rest });
  }
  async userByEmail(email: string) {
    return strip<User>(await this.users.findOne({ email }));
  }
  async userById(id: string) {
    return strip<User>(await this.users.findOne({ _id: id }));
  }
  async userBySecretHash(hash: string) {
    return strip<User>(await this.users.findOne({ agentSecretHash: hash }));
  }
  async updateUser(id: string, patch: Partial<Omit<User, "id">>) {
    const set: Record<string, unknown> = {};
    const unset: Record<string, ""> = {};
    for (const [k, v] of Object.entries(patch)) (v === undefined ? (unset[k] = "") : (set[k] = v));
    await this.users.updateOne({ _id: id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  }
  async deleteUser(id: string) {
    await Promise.all([this.users.deleteOne({ _id: id }), this.sessions.deleteMany({ userId: id }), this.codes.deleteMany({ userId: id }), this.models.deleteOne({ _id: id })]);
  }
  async putSession(s: Session) {
    const { id, ...rest } = s;
    await this.sessions.replaceOne({ _id: id }, { ...rest, expiresAtDate: new Date(s.expiresAt) } as never, { upsert: true });
  }
  async getSession(id: string) {
    const d = await this.sessions.findOne({ _id: id });
    if (!d) return undefined;
    const { expiresAtDate: _x, ...rest } = d as unknown as { expiresAtDate: Date } & Session & { _id: string };
    return strip<Session>(rest as never);
  }
  async deleteSession(id: string) {
    await this.sessions.deleteOne({ _id: id });
  }
  async deleteUserSessions(userId: string, exceptId?: string) {
    await this.sessions.deleteMany({ userId, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  }
  async putCode(c: CodeRecord) {
    await this.codes.replaceOne({ _id: `${c.userId}:${c.purpose}` }, { ...c, expiresAtDate: new Date(c.expiresAt) }, { upsert: true });
  }
  async getCode(userId: string, purpose: CodePurpose) {
    const d = await this.codes.findOne({ _id: `${userId}:${purpose}` });
    if (!d) return undefined;
    const { _id, expiresAtDate, ...rest } = d;
    return rest as CodeRecord;
  }
  async deleteCode(userId: string, purpose: CodePurpose) {
    await this.codes.deleteOne({ _id: `${userId}:${purpose}` });
  }
  async getModel(userId: string) {
    const d = await this.models.findOne({ _id: userId });
    if (!d) return undefined;
    const { _id, ...rest } = d;
    return { userId: _id, ...rest } as ModelConfig;
  }
  async putModel(m: ModelConfig) {
    const { userId, ...rest } = m;
    await this.models.replaceOne({ _id: userId }, rest, { upsert: true });
  }
  async deleteModel(userId: string) {
    await this.models.deleteOne({ _id: userId });
  }
  async close() {
    await this.client.close();
  }
}
