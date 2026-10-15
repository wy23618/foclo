import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { ServerConfig } from "./config.js";
import { authenticate, AuthFailure } from "./auth.js";
import { push, pull, snapshot, readSnapshot, clear } from "./sync.js";
import { registerImports } from "./imports.js";
import { ProtocolError, requireValue } from "./protocol.js";
import { randomUUID } from "node:crypto";
export function registerRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ServerConfig,
) {
  app.setErrorHandler((error: any, _request, reply) => {
    const known =
      error instanceof ProtocolError || error instanceof AuthFailure;
    const status =
      error instanceof AuthFailure
        ? error.statusCode
        : error instanceof ProtocolError
          ? error.code === "AUTH_REQUIRED"
            ? 401
            : error.code === "FORBIDDEN"
              ? 403
              : 409
          : error.statusCode || 500;
    reply
      .code(status)
      .send({
        error: {
          code: known
            ? error.code
            : error.statusCode === 413
              ? "PAYLOAD_TOO_LARGE"
              : "RETRYABLE_ERROR",
          message: known ? error.message : "请求未完成，请重试",
        },
      });
  });
  app.post("/api/v1/sync/push", async (r) =>
    push(pool, await authenticate(pool, config, r), r.body),
  );
  app.get("/api/v1/sync/pull", async (r) =>
    pull(
      pool,
      await authenticate(pool, config, r),
      r.query,
      config.cursorSecret,
    ),
  );
  app.post("/api/v1/sync/snapshots", async (r) =>
    snapshot(
      pool,
      await authenticate(pool, config, r),
      (r.body as any)?.generation,
    ),
  );
  app.get("/api/v1/sync/snapshots/:id", async (r) =>
    readSnapshot(
      pool,
      await authenticate(pool, config, r),
      (r.params as any).id,
      r.query,
      config.cursorSecret,
    ),
  );
  app.post("/api/v1/data/clear", async (r) =>
    clear(pool, await authenticate(pool, config, r), r.body),
  );
  app.post("/api/v1/exports", async (r) =>
    snapshot(
      pool,
      await authenticate(pool, config, r),
      (r.body as any)?.generation,
      "export",
    ),
  );
  app.get("/api/v1/exports/:id", async (r) =>
    readSnapshot(
      pool,
      await authenticate(pool, config, r),
      (r.params as any).id,
      r.query,
      config.cursorSecret,
    ),
  );
  app.get("/api/v1/account/deletion-requests", async (r) => {
    const who = await authenticate(pool, config, r);
    const row = (await pool.query(
      "SELECT id,status,requested_at FROM account_deletion_requests WHERE user_id=$1 ORDER BY requested_at DESC LIMIT 1",
      [who.userId],
    )).rows[0];
    return { request: row ? { id: row.id, status: row.status, requestedAt: row.requested_at } : null };
  });
  app.post("/api/v1/account/deletion-requests", async (r) => {
    const who = await authenticate(pool, config, r);
    requireValue(
      (r.body as any)?.confirmation === "REQUEST_ACCOUNT_DELETION",
      "CONFIRMATION_REQUIRED",
    );
    const row = (
      await pool.query(
        "INSERT INTO account_deletion_requests(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) WHERE status='pending_policy_review' DO UPDATE SET user_id=excluded.user_id RETURNING id,status,requested_at",
        [randomUUID(), who.userId],
      )
    ).rows[0];
    return { id: row.id, status: row.status, requestedAt: row.requested_at };
  });
  registerImports(app, pool, config);
}
