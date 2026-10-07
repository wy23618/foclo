import type { Pool } from "pg";
import { transaction } from "./sync.js";
import { requireValue, uuid } from "./protocol.js";
// Administrative fulfillment only: not registered as a public client route.
export async function fulfillAccountDeletion(
  pool: Pool,
  requestId: string,
  confirmation: string,
) {
  requireValue(
    uuid(requestId) && confirmation === "PURGE_REQUESTED_ACCOUNT",
    "CONFIRMATION_REQUIRED",
  );
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
    await db.query(
      "UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1",
      [request.user_id],
    );
    await db.query(
      "DELETE FROM auth_session_refresh_history WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id=$1)",
      [request.user_id],
    );
    await db.query("DELETE FROM auth_sessions WHERE user_id=$1", [
      request.user_id,
    ]);
    await db.query(
      "DELETE FROM import_items WHERE job_id IN (SELECT id FROM import_jobs WHERE space_id=$1)",
      [space.id],
    );
    await db.query("DELETE FROM import_jobs WHERE space_id=$1", [space.id]);
    await db.query("DELETE FROM sync_snapshots WHERE space_id=$1", [space.id]);
    for (const table of [
      "pauses",
      "study_sessions",
      "projects",
      "account_preferences",
      "sync_changes",
      "sync_operations",
    ])
      await db.query("DELETE FROM " + table + " WHERE space_id=$1", [space.id]);
    await db.query("DELETE FROM spaces WHERE id=$1", [space.id]);
    await db.query("DELETE FROM auth_identities WHERE user_id=$1", [
      request.user_id,
    ]);
    await db.query("DELETE FROM account_deletion_requests WHERE user_id=$1", [
      request.user_id,
    ]);
    await db.query("DELETE FROM users WHERE id=$1", [request.user_id]);
    return { fulfilled: true, requestId };
  });
}
