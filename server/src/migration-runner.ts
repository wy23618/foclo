import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

export async function applyMigrations(pool: Pool, directory: string) {
  const db = await pool.connect();
  const applied: number[] = [];
  let locked = false;
  try {
    // One session owns the lock across the independently atomic SQL files.
    await db.query("SELECT pg_advisory_lock(20261006, 1)");
    locked = true;
    const exists = (
      await db.query("SELECT to_regclass('public.schema_migrations') AS name")
    ).rows[0].name;
    const versions = new Set<number>(
      exists
        ? (await db.query("SELECT version FROM schema_migrations")).rows.map(
            (r) => r.version,
          )
        : [],
    );
    const files = (await readdir(directory))
      .filter((n) => /^\d+_.*\.sql$/.test(n))
      .sort();
    for (const file of files) {
      const version = Number(file.split("_")[0]);
      if (versions.has(version)) continue;
      await db.query(await readFile(join(directory, file), "utf8"));
      versions.add(version);
      applied.push(version);
    }
    return applied;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    let discard = false;
    try {
      if (locked) await db.query("SELECT pg_advisory_unlock(20261006, 1)");
    } catch (error) {
      discard = true;
      throw error;
    } finally {
      db.release(discard);
    }
  }
}
