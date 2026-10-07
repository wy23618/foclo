import type { Pool } from "pg";
import { transaction } from "./sync.js";
export const BACKUP_TABLES = [
  "users",
  "spaces",
  "auth_identities",
  "auth_sessions",
  "auth_session_refresh_history",
  "projects",
  "study_sessions",
  "pauses",
  "account_preferences",
  "sync_operations",
  "sync_changes",
  "sync_snapshots",
  "snapshot_items",
  "import_jobs",
  "import_items",
  "account_deletion_requests",
] as const;
// Administrative logical drill helper. Do not expose through client APIs.
export async function logicalBackup(pool: Pool) {
  return transaction(pool, async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = [];
    for (const name of BACKUP_TABLES) {
      const columns = (
        await db.query(
          "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
          [name],
        )
      ).rows;
      const rows = (await db.query("SELECT * FROM " + name)).rows.map((row) =>
        columns.map((c) =>
          c.data_type === "bytea" && row[c.column_name] !== null
            ? { base64: row[c.column_name].toString("base64") }
            : row[c.column_name],
        ),
      );
      tables.push({ name, columns, rows });
    }
    return { version: 1, createdAt: new Date().toISOString(), tables };
  });
}
export async function restoreEmptyDatabase(
  pool: Pool,
  backup: Awaited<ReturnType<typeof logicalBackup>>,
) {
  if (backup.version !== 1 || backup.tables.length !== BACKUP_TABLES.length)
    throw new Error("Invalid backup");
  return transaction(pool, async (db) => {
    for (const [i, t] of backup.tables.entries()) {
      if (t.name !== BACKUP_TABLES[i]) throw new Error("Invalid table order");
      const actual = (
        await db.query(
          "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
          [t.name],
        )
      ).rows;
      if (JSON.stringify(actual) !== JSON.stringify(t.columns))
        throw new Error("Schema mismatch");
      if (
        (await db.query("SELECT count(*) FROM " + t.name)).rows[0].count !== "0"
      )
        throw new Error("Restore target must be empty");
      for (const row of t.rows) {
        const values = row.map((v, j) =>
          t.columns[j]!.data_type === "bytea" && v !== null
            ? Buffer.from(v.base64, "base64")
            : v,
        );
        await db.query(
          "INSERT INTO " +
            t.name +
            " (" +
            t.columns.map((c) => '"' + c.column_name + '"').join(",") +
            ") VALUES (" +
            values.map((_, j) => "$" + (j + 1)).join(",") +
            ")",
          values,
        );
      }
    }
    await db.query("UPDATE spaces SET restore_epoch=gen_random_uuid()");
  });
}
