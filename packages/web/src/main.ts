#!/usr/bin/env node
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { ConsoleMailer } from "./mailer.js";
import { createWebServer } from "./server.js";
import { MemoryStore, type Store } from "./store.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env, () => crypto.randomBytes(32));
  const log = (m: string) => console.log(m);
  let store: Store;
  if (config.mongoUri) {
    const { MongoStore } = await import("./mongo.js");
    store = await MongoStore.connect(config.mongoUri, config.mongoDb);
    log(`web: MongoDB connected (${config.mongoDb})`);
  } else {
    if (process.env.NODE_ENV === "production") throw new Error("WEB_MONGODB_URI is required in production");
    store = new MemoryStore();
    log("web: WEB_MONGODB_URI is not set, using in-memory storage. Accounts are lost on restart.");
  }
  const server = createWebServer({ store, mailer: new ConsoleMailer(log), config, log });
  server.listen(config.port, () => log(`web: ${config.brand} listening on ${config.publicUrl}`));
  const stop = () => server.close(() => void store.close().then(() => process.exit(0)));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
