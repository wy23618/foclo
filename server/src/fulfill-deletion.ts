import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { fulfillAccountDeletion } from "./account-deletion.js";
const config = loadConfig(),
  pool = createPool({ ...config, databaseUrl: config.migrationDatabaseUrl });
try {
  const id = process.argv[2] || "";
  if (process.env.ACCOUNT_DELETION_CONFIRM !== id)
    throw new Error("Explicit request ID confirmation required");
  process.stdout.write(
    JSON.stringify(
      await fulfillAccountDeletion(pool, id, "PURGE_REQUESTED_ACCOUNT"),
    ) + "\n",
  );
} finally {
  await pool.end();
}
