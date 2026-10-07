import { resolve } from "node:path";
import { applyMigrations } from "./migration-runner.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
const config = loadConfig(),
  pool = createPool({ ...config, databaseUrl: config.migrationDatabaseUrl });
try {
  const applied = await applyMigrations(pool, resolve("migrations"));
  for (const version of applied)
    process.stdout.write("Applied migration " + version + "\n");
} finally {
  await pool.end();
}
