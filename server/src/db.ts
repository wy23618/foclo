import { Pool, type PoolConfig } from "pg";
import type { ServerConfig } from "./config.js";

export function createPool(config: ServerConfig): Pool {
  const ssl: PoolConfig["ssl"] = config.databaseSsl
    ? {
        rejectUnauthorized: true,
        ...(config.databaseCa ? { ca: config.databaseCa } : {}),
      }
    : false;
  return new Pool({
    connectionString: config.databaseUrl,
    ssl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "yotick-api",
  });
}
