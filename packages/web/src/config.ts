export interface WebConfig {
  port: number;
  publicUrl: string;
  brand: string;
  mongoUri?: string;
  mongoDb: string;
  /** 32 random bytes, base64. Encrypts API keys and agent tokens at rest. */
  secretKey: Buffer;
  allowPrivateAgents: boolean;
  trustProxy: boolean;
  secureCookies: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, randomKey: () => Buffer): WebConfig {
  const publicUrl = (env.WEB_PUBLIC_URL?.trim() || `http://127.0.0.1:${env.WEB_PORT?.trim() || "8090"}`).replace(/\/+$/, "");
  const raw = env.WEB_SECRET_KEY?.trim();
  let secretKey: Buffer;
  if (raw) {
    secretKey = Buffer.from(raw, "base64");
    if (secretKey.length !== 32) throw new Error("WEB_SECRET_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)");
  } else if (env.NODE_ENV === "production") {
    throw new Error("WEB_SECRET_KEY is required in production");
  } else {
    secretKey = randomKey();
  }
  return {
    port: Number(env.WEB_PORT?.trim() || env.PORT?.trim() || 8090),
    publicUrl,
    brand: env.WEB_BRAND?.trim() || "Open Instinct",
    ...(env.WEB_MONGODB_URI?.trim() ? { mongoUri: env.WEB_MONGODB_URI.trim() } : {}),
    mongoDb: env.WEB_MONGODB_DB?.trim() || "instinct_web",
    secretKey,
    allowPrivateAgents: env.WEB_ALLOW_PRIVATE_AGENTS?.trim() === "1",
    trustProxy: env.WEB_TRUST_PROXY?.trim() === "1",
    secureCookies: publicUrl.startsWith("https://"),
  };
}
