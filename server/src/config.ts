export type NodeEnvironment = "development" | "test" | "production";

export interface ServerConfig {
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  databaseUrl: string;
  migrationDatabaseUrl: string;
  databaseSsl: boolean;
  databaseCa?: string;
  dbPoolMax: number;
  wechatAppId: string;
  wechatAppSecret: string;
  tokenPepper: string;
  cursorSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  refreshGraceSeconds: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function integer(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${key} is outside its allowed range`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawEnvironment = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(rawEnvironment))
    throw new Error("NODE_ENV must be development, test, or production");
  const nodeEnv = rawEnvironment as NodeEnvironment;
  const databaseUrl = required(env, "DATABASE_URL");
  const migrationDatabaseUrl = required(env, "MIGRATION_DATABASE_URL");
  for (const value of [databaseUrl, migrationDatabaseUrl]) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Database connection URL is invalid");
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol))
      throw new Error("Database URL must use PostgreSQL");
    if (
      ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"].some((k) =>
        url.searchParams.has(k),
      )
    )
      throw new Error(
        "Configure database TLS through DATABASE_SSL and DATABASE_CA only",
      );
  }
  let databaseSsl =
    env.DATABASE_SSL === undefined
      ? nodeEnv === "production"
      : env.DATABASE_SSL === "true";
  if (
    env.DATABASE_SSL !== undefined &&
    !["true", "false"].includes(env.DATABASE_SSL)
  )
    throw new Error("DATABASE_SSL must be true or false");
  if (nodeEnv === "production" && !databaseSsl)
    throw new Error("DATABASE_SSL cannot be disabled in production");
  const databaseCa = env.DATABASE_CA?.trim();
  const tokenPepper = required(env, "TOKEN_PEPPER");
  const cursorSecret = required(env, "CURSOR_SECRET");
  if (tokenPepper.length < 32)
    throw new Error("TOKEN_PEPPER must contain at least 32 characters");
  if (cursorSecret.length < 32)
    throw new Error("CURSOR_SECRET must contain at least 32 characters");
  if (tokenPepper === cursorSecret)
    throw new Error("TOKEN_PEPPER and CURSOR_SECRET must be different secrets");

  return {
    nodeEnv,
    host: env.HOST?.trim() || "0.0.0.0",
    port: integer(env, "PORT", 3000, 1, 65535),
    databaseUrl,
    migrationDatabaseUrl,
    databaseSsl,
    ...(databaseCa ? { databaseCa } : {}),
    dbPoolMax: integer(env, "DB_POOL_MAX", 10, 1, 100),
    wechatAppId: required(env, "WECHAT_APP_ID"),
    wechatAppSecret: required(env, "WECHAT_APP_SECRET"),
    tokenPepper,
    cursorSecret,
    accessTokenTtlSeconds: integer(
      env,
      "ACCESS_TOKEN_TTL_SECONDS",
      900,
      60,
      86400,
    ),
    refreshTokenTtlSeconds: integer(
      env,
      "REFRESH_TOKEN_TTL_SECONDS",
      2592000,
      3600,
      31536000,
    ),
    refreshGraceSeconds: integer(env, "REFRESH_GRACE_SECONDS", 30, 1, 120),
  };
}
