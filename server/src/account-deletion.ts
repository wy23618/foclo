import type { Pool, PoolClient } from "pg";
import { transaction } from "./sync.js";
import { requireValue, uuid } from "./protocol.js";
import { recordDeletionIntent, readDeletionIntents } from "./deletion-ledger.js";
// Administrative fulfillment only: not registered as a public client route.
export async function fulfillAccountDeletion(
  pool: Pool,
  requestId: string,
  confirmation: string,
  ledgerDirectory?: string,
) {
  requireValue(
    uuid(requestId) && confirmation === "PURGE_REQUESTED_ACCOUNT",
    "CONFIRMATION_REQUIRED",
  );
  if (ledgerDirectory) await readDeletionIntents(ledgerDirectory);
  return transaction(pool, async (db) => {
    const request = (
      await db.query(
        "SELECT * FROM account_deletion_requests WHERE id=$1 AND status='pending_policy_review' FOR UPDATE",
        [requestId],
      )
    ).rows[0];
    requireValue(request, "DELETION_REQUEST_NOT_FOUND");
    const space = (
      await db.query("SELECT * FROM spaces WHERE user_id=$1 FOR UPDATE", [
        request.user_id,
      ])
    ).rows[0];
    requireValue(space, "SPACE_NOT_FOUND");
    if (ledgerDirectory)
      await recordDeletionIntent(ledgerDirectory, {
        formatVersion: 1,
        requestId,
        userId: request.user_id,
        approvedAt: new Date().toISOString(),
      });
    await purgeAccountRows(db, request.user_id, space.id);
    return { fulfilled: true, requestId };
  });
}
async function purgeAccountRows(db: PoolClient, userId: string, spaceId: string) {
    await db.query(
      "UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1",
      [userId],
    );
    await db.query(
      "DELETE FROM auth_session_refresh_history WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id=$1)",
      [userId],
    );
    await db.query("DELETE FROM auth_sessions WHERE user_id=$1", [
      userId,
    ]);
    await db.query(
      "DELETE FROM import_items WHERE job_id IN (SELECT id FROM import_jobs WHERE space_id=$1)",
      [spaceId],
    );
    await db.query("DELETE FROM import_jobs WHERE space_id=$1", [spaceId]);
    await db.query("DELETE FROM sync_snapshots WHERE space_id=$1", [spaceId]);
    for (const table of [
      "pauses",
      "study_sessions",
      "projects",
      "account_preferences",
      "sync_changes",
      "sync_operations",
    ])
      await db.query("DELETE FROM " + table + " WHERE space_id=$1", [spaceId]);
    await db.query("DELETE FROM spaces WHERE id=$1", [spaceId]);
    await db.query("DELETE FROM auth_identities WHERE user_id=$1", [
      userId,
    ]);
    await db.query("DELETE FROM account_deletion_requests WHERE user_id=$1", [
      userId,
    ]);
    await db.query("DELETE FROM users WHERE id=$1", [userId]);
}

// Only a separately restored DB can be reconciled with administrator-approved
// intents. Idempotent retries finish an intent even if a prior purge rolled back.
export async function reconcileDeletionLedger(pool: Pool, directory: string) {
  const intents = await readDeletionIntents(directory);
  const database = (await pool.query("SELECT current_database() AS name")).rows[0].name as string;
  requireValue(/^yotick_restore_[a-z0-9_]+$/.test(database), "ISOLATED_RESTORE_REQUIRED");
  let purged = 0;
  for (const intent of intents) {
    const changed = await transaction(pool, async db => {
      const user = (await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [intent.userId])).rows[0];
      if (!user) return false;
      const space = (await db.query("SELECT id FROM spaces WHERE user_id=$1 FOR UPDATE", [intent.userId])).rows[0];
      requireValue(space, "SPACE_NOT_FOUND");
      await purgeAccountRows(db, intent.userId, space.id); return true;
    });
    if (changed) purged++;
  }
  return { approvedIntents: intents.length, purged, database };
}
