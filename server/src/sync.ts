import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import {
  ProtocolError,
  requireValue,
  uuid,
  digest,
  validateProject,
  validateSession,
  validatePrefs,
  signCursor,
  readCursor,
} from "./protocol.js";
export type Identity = {
  userId: string;
  spaceId: string;
  generation: string;
  sessionId: string;
};
function boundedPage(items: any[], limit: number) {
  const result: any[] = [];
  let bytes = 0;
  for (const item of items.slice(0, limit)) {
    const size = Buffer.byteLength(JSON.stringify(item));
    requireValue(size <= 240 * 1024, "PAYLOAD_TOO_LARGE");
    if (bytes + size > 240 * 1024 && result.length) break;
    result.push(item);
    bytes += size;
  }
  return result;
}
export async function transaction<T>(
  pool: Pool,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  if ("withTransaction" in pool)
    return (pool as any).withTransaction(fn);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
async function lock(db: PoolClient, who: Identity, generation: string) {
  const { rows } = await db.query(
    "SELECT * FROM spaces WHERE id=$1 AND user_id=$2 FOR UPDATE",
    [who.spaceId, who.userId],
  );
  requireValue(rows[0], "AUTH_REQUIRED");
  requireValue(rows[0].generation === generation, "GENERATION_MISMATCH");
  return rows[0];
}
async function log(
  db: PoolClient,
  space: any,
  type: string,
  id: string,
  version: string,
  data: any,
  deleted = false,
) {
  space.change_seq = (BigInt(space.change_seq) + 1n).toString();
  await db.query(
    "INSERT INTO sync_changes(space_id,generation,seq,entity_type,entity_id,server_version,data,deleted) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      space.id,
      space.generation,
      space.change_seq,
      type,
      id,
      version,
      data,
      deleted,
    ],
  );
}
async function projects(db: PoolClient, space: any) {
  return (
    await db.query(
      "SELECT * FROM projects WHERE space_id=$1 AND generation=$2",
      [space.id, space.generation],
    )
  ).rows;
}
function cas(row: any, expected: any) {
  requireValue(row && !row.deleted_at, "ENTITY_DELETED");
  requireValue(
    typeof expected === "string" && row.server_version === expected,
    "VERSION_CONFLICT",
  );
}
function projectData(p: any, space: any, order: any) {
  return {
    id: p.id,
    name: p.name,
    parentId: p.parentId,
    archived: p.archived,
    shortName: p.shortName || "",
    createdAtSec: p.createdAtSec,
    updatedAtSec: p.updatedAtSec,
    spaceId: space.id,
    creationOrder: Number(order),
    revision: 1,
    lastUsedAtSec: null,
    color: p.color.toUpperCase(),
  };
}
function sessionData(s: any, space: any) {
  return {
    id: s.id,
    projectId: s.projectId,
    status: "COMPLETED",
    startedAtSec: s.startedAtSec,
    endedAtSec: s.endedAtSec,
    durationSeconds: s.durationSeconds,
    targetSeconds: s.targetSeconds,
    createdAtSec: s.createdAtSec,
    updatedAtSec: s.updatedAtSec,
    pauses: s.pauses.map((p: any) => ({
      id: p.id,
      sessionId: s.id,
      status: "COMPLETED",
      startedAtSec: p.startedAtSec,
      endedAtSec: p.endedAtSec,
      durationSeconds: p.durationSeconds,
      createdAtSec: p.createdAtSec,
    })),
    spaceId: space.id,
    revision: 1,
  };
}
export async function executeOperation(
  db: PoolClient,
  space: any,
  op: any,
  deviceId: string,
) {
  requireValue(
    op &&
      uuid(op.operationId) &&
      typeof op.kind === "string" &&
      typeof op.entityId === "string",
  );
  const hash = digest(op),
    old = (
      await db.query(
        "SELECT request_hash,result FROM sync_operations WHERE space_id=$1 AND generation=$2 AND operation_id=$3",
        [space.id, space.generation, op.operationId],
      )
    ).rows[0];
  if (old) {
    requireValue(old.request_hash === hash, "OPERATION_ID_REUSED");
    return old.result;
  }
  if (op.dependsOn) {
    const dep = (
      await db.query(
        "SELECT result FROM sync_operations WHERE space_id=$1 AND generation=$2 AND operation_id=$3",
        [space.id, space.generation, op.dependsOn],
      )
    ).rows[0];
    requireValue(dep && dep.result.status === "applied", "DEPENDENCY_PENDING");
  }
  const p = op.payload;
  let changes: any[] = [];
  if (op.kind === "project.create") {
    validateProject(p);
    requireValue(p.id === op.entityId);
    const rows = await projects(db, space),
      existing = rows.find((r) => r.id === p.id);
    requireValue(
      !existing,
      existing?.deleted_at ? "ENTITY_DELETED" : "VERSION_CONFLICT",
    );
    if (p.parentId)
      requireValue(
        rows.some(
          (r) =>
            r.id === p.parentId &&
            !r.deleted_at &&
            (!r.data.archived || p.archived),
        ),
        "INVALID_PARENT",
      );
    requireValue(
      !rows.some((r) => !r.deleted_at && r.name === p.name),
      "NAME_CONFLICT",
    );
    const order = space.next_order;
    space.next_order = (BigInt(order) + 1n).toString();
    const data = projectData(p, space, order);
    await db.query(
      "INSERT INTO projects(space_id,id,generation,name,parent_id,order_key,server_version,data) VALUES($1,$2,$3,$4,$5,$6,1,$7)",
      [space.id, p.id, space.generation, p.name, p.parentId, order, data],
    );
    await log(db, space, "project", p.id, "1", data);
    changes = [
      { entityType: "project", entityId: p.id, serverVersion: "1", data },
    ];
  } else if (op.kind.startsWith("project.")) {
    const rows = await projects(db, space),
      root = rows.find((r) => r.id === op.entityId);
    cas(root, op.baseServerVersion);
    let targets: any[] = [];
    if (op.kind === "project.patch") {
      requireValue(
        p &&
          Object.keys(p).every((k) =>
            ["name", "color", "shortName"].includes(k),
          ),
      );
      const data = { ...root.data, ...p };
      validateProject(data);
      requireValue(
        !rows.some(
          (r) => r.id !== root.id && !r.deleted_at && r.name === data.name,
        ),
        "NAME_CONFLICT",
      );
      targets = [{ row: root, data }];
    } else if (op.kind === "project.reorder") {
      requireValue(
        Array.isArray(p?.orderedIds) &&
          new Set(p.orderedIds).size === p.orderedIds.length,
      );
      const group = rows.filter(
        (r) =>
          !r.deleted_at &&
          r.parent_id === root.parent_id &&
          r.data.archived === root.data.archived,
      );
      requireValue(
        group.length === p.orderedIds.length &&
          group.every((r) => p.orderedIds.includes(r.id)),
        "VERSION_CONFLICT",
      );
      const orders = group
        .map((r) => BigInt(r.order_key))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      targets = p.orderedIds.map((id: string, i: number) => ({
        row: group.find((r) => r.id === id),
        data: {
          ...group.find((r) => r.id === id).data,
          creationOrder: Number(orders[i]),
        },
        order: orders[i]!.toString(),
      }));
    } else if (
      ["project.archive", "project.restore", "project.deleteSubtree"].includes(
        op.kind,
      )
    ) {
      const ids = new Set([root.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const r of rows)
          if (!r.deleted_at && !ids.has(r.id) && ids.has(r.parent_id)) {
            ids.add(r.id);
            changed = true;
          }
      }
      targets = rows
        .filter((r) => ids.has(r.id) && !r.deleted_at)
        .map((row) => ({
          row,
          data: {
            ...row.data,
            archived:
              op.kind === "project.archive"
                ? true
                : op.kind === "project.restore"
                  ? false
                  : row.data.archived,
          },
          deleted: op.kind === "project.deleteSubtree",
        }));
      if (op.kind === "project.restore" && root.parent_id)
        requireValue(
          rows.some(
            (r) => r.id === root.parent_id && !r.deleted_at && !r.data.archived,
          ),
          "INVALID_PARENT",
        );
    } else throw new ProtocolError("UNKNOWN_OPERATION");
    if (op.kind !== "project.patch") {
      requireValue(
        p?.expectedVersions &&
          Object.keys(p.expectedVersions).length === targets.length,
        "VERSION_CONFLICT",
      );
      for (const t of targets) cas(t.row, p.expectedVersions[t.row.id]);
    }
    for (const t of targets) {
      const v = (BigInt(t.row.server_version) + 1n).toString();
      await db.query(
        "UPDATE projects SET name=$3,order_key=$4,server_version=$5,data=$6,deleted_at=CASE WHEN $7 THEN now() ELSE deleted_at END WHERE space_id=$1 AND id=$2",
        [
          space.id,
          t.row.id,
          t.data.name,
          t.order || t.row.order_key,
          v,
          t.data,
          !!t.deleted,
        ],
      );
      await log(db, space, "project", t.row.id, v, t.data, !!t.deleted);
      changes.push({
        entityType: "project",
        entityId: t.row.id,
        serverVersion: v,
        data: t.data,
        deleted: !!t.deleted,
      });
    }
    if (op.kind === "project.deleteSubtree") {
      const deletedIds = targets.map((t) => t.row.id),
        ss = (
          await db.query(
            "SELECT * FROM study_sessions WHERE space_id=$1 AND generation=$2 AND project_id=ANY($3::uuid[]) AND deleted_at IS NULL",
            [space.id, space.generation, deletedIds],
          )
        ).rows;
      for (const s of ss) {
        const v = (BigInt(s.server_version) + 1n).toString();
        await db.query(
          "UPDATE study_sessions SET deleted_at=now(),server_version=$3 WHERE space_id=$1 AND id=$2",
          [space.id, s.id, v],
        );
        await log(db, space, "session", s.id, v, s.data, true);
        changes.push({
          entityType: "session",
          entityId: s.id,
          serverVersion: v,
          data: s.data,
          deleted: true,
        });
      }
    }
  } else if (op.kind === "session.createCompleted") {
    validateSession(p);
    requireValue(p.id === op.entityId);
    const existing = (
      await db.query(
        "SELECT * FROM study_sessions WHERE space_id=$1 AND id=$2",
        [space.id, p.id],
      )
    ).rows[0];
    if (existing) {
      requireValue(
        !existing.deleted_at && existing.generation === space.generation,
        "ENTITY_DELETED",
      );
      requireValue(
        digest(existing.data) === digest(sessionData(p, space)),
        "VERSION_CONFLICT",
      );
      changes = [
        {
          entityType: "session",
          entityId: p.id,
          serverVersion: existing.server_version,
          data: existing.data,
        },
      ];
    } else {
      const project = (
        await db.query(
          "SELECT * FROM projects WHERE space_id=$1 AND id=$2 AND generation=$3",
          [space.id, p.projectId, space.generation],
        )
      ).rows[0];
      requireValue(project && !project.deleted_at, "ENTITY_DELETED");
      const data = sessionData(p, space);
      requireValue(
        Buffer.byteLength(JSON.stringify(data)) <= 220 * 1024,
        "PAYLOAD_TOO_LARGE",
      );
      await db.query(
        "INSERT INTO study_sessions(space_id,id,generation,project_id,origin_device_id,server_version,data) VALUES($1,$2,$3,$4,$5,1,$6)",
        [space.id, p.id, space.generation, p.projectId, deviceId, data],
      );
      for (const pause of p.pauses)
        await db.query(
          "INSERT INTO pauses(space_id,id,session_id,data) VALUES($1,$2,$3,$4)",
          [space.id, pause.id, p.id, pause],
        );
      await log(db, space, "session", p.id, "1", data);
      changes = [
        { entityType: "session", entityId: p.id, serverVersion: "1", data },
      ];
    }
  } else if (op.kind === "session.delete") {
    const row = (
      await db.query(
        "SELECT * FROM study_sessions WHERE space_id=$1 AND id=$2 AND generation=$3",
        [space.id, op.entityId, space.generation],
      )
    ).rows[0];
    cas(row, op.baseServerVersion);
    const v = (BigInt(row.server_version) + 1n).toString();
    await db.query(
      "UPDATE study_sessions SET deleted_at=now(),server_version=$3 WHERE space_id=$1 AND id=$2",
      [space.id, row.id, v],
    );
    await log(db, space, "session", row.id, v, row.data, true);
    changes = [
      {
        entityType: "session",
        entityId: row.id,
        serverVersion: v,
        data: row.data,
        deleted: true,
      },
    ];
  } else if (op.kind === "prefs.patch") {
    requireValue(op.entityId === "account");
    validatePrefs(p);
    const row = (
      await db.query("SELECT * FROM account_preferences WHERE space_id=$1", [
        space.id,
      ])
    ).rows[0];
    requireValue(
      (row?.generation === space.generation ? row.server_version : "0") ===
        op.baseServerVersion,
      "VERSION_CONFLICT",
    );
    const v = (
        BigInt(
          row?.generation === space.generation ? row.server_version : "0",
        ) + 1n
      ).toString(),
      data = {
        ...(row?.generation === space.generation ? row.data : {}),
        ...p,
      };
    await db.query(
      "INSERT INTO account_preferences(space_id,generation,server_version,data) VALUES($1,$2,$3,$4) ON CONFLICT(space_id) DO UPDATE SET generation=$2,server_version=$3,data=$4",
      [space.id, space.generation, v, data],
    );
    await log(db, space, "prefs", "account", v, data);
    changes = [
      { entityType: "prefs", entityId: "account", serverVersion: v, data },
    ];
  } else throw new ProtocolError("UNKNOWN_OPERATION");
  const result = {
    operationId: op.operationId,
    status: "applied",
    committed: true,
    changes,
  };
  await db.query(
    "INSERT INTO sync_operations(space_id,generation,operation_id,request_hash,result) VALUES($1,$2,$3,$4,$5)",
    [space.id, space.generation, op.operationId, hash, result],
  );
  return result;
}
export async function push(pool: Pool, who: Identity, body: any) {
  requireValue(body?.protocolVersion === 1, "UPGRADE_REQUIRED");
  requireValue(body.spaceId === who.spaceId, "FORBIDDEN");
  requireValue(
    uuid(body.deviceId) &&
      Array.isArray(body.operations) &&
      body.operations.length <= 50,
  );
  requireValue(
    Buffer.byteLength(JSON.stringify(body)) <= 256 * 1024,
    "PAYLOAD_TOO_LARGE",
  );
  return transaction(pool, async (db) => {
    const space = await lock(db, who, body.generation),
      results = [];
    for (const op of body.operations) {
      const before = { ...space };
      try {
        const execute = () => executeOperation(db, space, op, body.deviceId);
        if ("withSavepoint" in db) {
          results.push(await (db as any).withSavepoint(execute));
        } else {
          await db.query("SAVEPOINT operation");
          results.push(await execute());
        }
      } catch (e: any) {
        if (!("withSavepoint" in db))
          await db.query("ROLLBACK TO SAVEPOINT operation");
        Object.assign(space, before);
        if (
          !(e instanceof ProtocolError) &&
          !["23505", "23503", "22P02"].includes(e.code)
        )
          throw e;
        const code =
          e.code === "23505"
            ? "NAME_CONFLICT"
            : e.code === "23503"
              ? "INVALID_REFERENCE"
              : e.code === "22P02"
                ? "INVALID_PAYLOAD"
                : e.code;
        const result = {
          operationId: op?.operationId,
          status: "conflict",
          committed: false,
          code,
          detail: e.detail,
        };
        results.push(result);
        if (
          uuid(op?.operationId) &&
          code !== "DEPENDENCY_PENDING" &&
          code !== "OPERATION_ID_REUSED"
        )
          await db.query(
            "INSERT INTO sync_operations(space_id,generation,operation_id,request_hash,result) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            [space.id, space.generation, op.operationId, digest(op), result],
          );
      }
      if (!("withSavepoint" in db)) await db.query("RELEASE SAVEPOINT operation");
    }
    await db.query(
      "UPDATE spaces SET change_seq=$2,next_order=$3 WHERE id=$1",
      [space.id, space.change_seq, space.next_order],
    );
    // Large subtree deletions can affect thousands of facts. Receipts retain
    // all effects in PostgreSQL; the wire acknowledgement is bounded and the
    // client pulls the remaining authoritative change log before its next task.
    const perResultBytes = Math.floor(
      (220 * 1024) / Math.max(1, results.length),
    );
    const wireResults = results.map((result: any) => {
      if (!Array.isArray(result.changes)) return result;
      let bytes = 0;
      const changes = [];
      for (const change of result.changes) {
        const size = Buffer.byteLength(JSON.stringify(change));
        if (bytes + size > perResultBytes) break;
        changes.push(change);
        bytes += size;
      }
      return {
        ...result,
        changes,
        hasMoreChanges: changes.length < result.changes.length,
      };
    });
    return {
      results: wireResults,
      upperSeq: space.change_seq,
      generation: space.generation,
    };
  });
}
export async function pull(pool: Pool, who: Identity, q: any, secret: string) {
  return transaction(pool, async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const space = (
      await db.query("SELECT * FROM spaces WHERE id=$1 AND user_id=$2", [
        who.spaceId,
        who.userId,
      ])
    ).rows[0];
    requireValue(space, "AUTH_REQUIRED");
    requireValue(q.generation === space.generation, "GENERATION_MISMATCH");
    let c: any = {
      spaceId: space.id,
      generation: space.generation,
      protocolVersion: 1,
      epoch: space.restore_epoch,
      after: "0",
      upper: space.change_seq,
    };
    if (q.cursor) {
      c = readCursor(q.cursor, secret);
      requireValue(
        c.spaceId === space.id &&
          c.generation === space.generation &&
          c.protocolVersion === 1,
        "INVALID_CURSOR",
      );
      requireValue(
        c.epoch === space.restore_epoch &&
          BigInt(c.after) <= BigInt(space.change_seq),
        "CURSOR_EXPIRED",
      );
      if (c.done) c.upper = space.change_seq;
    }
    const limit = Math.max(1, Math.min(100, Number(q.limit) || 50)),
      rows = (
        await db.query(
          "SELECT * FROM sync_changes WHERE space_id=$1 AND generation=$2 AND seq>$3 AND seq<=$4 ORDER BY seq LIMIT $5",
          [space.id, space.generation, c.after, c.upper, limit + 1],
        )
      ).rows,
      changes = boundedPage(
        rows.map((r) => ({
          seq: r.seq,
          entityType: r.entity_type,
          entityId: r.entity_id,
          serverVersion: r.server_version,
          data: r.data,
          deleted: r.deleted,
        })),
        limit,
      ),
      more = rows.length > changes.length;
    c.after = changes.length ? changes[changes.length - 1]!.seq : c.after;
    c.done = !more;
    return {
      changes,
      snapshotUpperSeq: c.upper,
      cursor: signCursor(c, secret),
      hasMore: more,
      generation: space.generation,
    };
  });
}
export async function snapshot(
  pool: Pool,
  who: Identity,
  generation: string,
  kind = "snapshot",
) {
  return transaction(pool, async (db) => {
    const space = await lock(db, who, generation),
      id = randomUUID();
    const activeSnapshots = Number(
      (
        await db.query(
          "SELECT count(*) FROM sync_snapshots WHERE space_id=$1 AND expires_at>now()",
          [space.id],
        )
      ).rows[0].count,
    );
    requireValue(activeSnapshots < 10, "SNAPSHOT_LIMIT");
    await db.query(
      "INSERT INTO sync_snapshots(id,space_id,generation,upper_seq,restore_epoch,expires_at,kind) VALUES($1,$2,$3,$4,$5,now()+interval '1 day',$6)",
      [
        id,
        space.id,
        space.generation,
        space.change_seq,
        space.restore_epoch,
        kind,
      ],
    );
    await db.query(
      `INSERT INTO snapshot_items(snapshot_id,ordinal,data) SELECT $1,row_number() OVER(ORDER BY type,id)::int,jsonb_build_object('entityType',type,'entityId',id,'serverVersion',v,'data',data,'deleted',deleted) FROM (SELECT 'project' type,id::text,server_version::text v,data,deleted_at IS NOT NULL deleted FROM projects WHERE space_id=$2 AND generation=$3 UNION ALL SELECT 'session',id::text,server_version::text,data,deleted_at IS NOT NULL FROM study_sessions WHERE space_id=$2 AND generation=$3 UNION ALL SELECT 'prefs','account',server_version::text,data,false FROM account_preferences WHERE space_id=$2 AND generation=$3) s`,
      [id, space.id, space.generation],
    );
    return { id, upperSeq: space.change_seq, generation: space.generation };
  });
}
export async function readSnapshot(
  pool: Pool,
  who: Identity,
  id: string,
  q: any,
  secret: string,
) {
  requireValue(uuid(id));
  return transaction(pool, async (db) => {
    const s = (
      await db.query(
        "SELECT sn.*,sp.generation current_generation,sp.restore_epoch current_restore_epoch FROM sync_snapshots sn JOIN spaces sp ON sp.id=sn.space_id WHERE sn.id=$1 AND sn.space_id=$2 AND sp.user_id=$3 AND sn.expires_at>now()",
        [id, who.spaceId, who.userId],
      )
    ).rows[0];
    requireValue(s, "SNAPSHOT_EXPIRED");
    requireValue(
      s.restore_epoch === s.current_restore_epoch,
      "SNAPSHOT_EXPIRED",
    );
    requireValue(s.generation === s.current_generation, "GENERATION_MISMATCH");
    const offset = Number(q.offset || 0);
    requireValue(Number.isInteger(offset) && offset >= 0);
    const rows = (
        await db.query(
          "SELECT data FROM snapshot_items WHERE snapshot_id=$1 AND ordinal>$2 ORDER BY ordinal LIMIT 51",
          [id, offset],
        )
      ).rows,
      changes = boundedPage(
        rows.map((r) => r.data),
        50,
      ),
      more = rows.length > changes.length;
    return {
      changes,
      nextOffset: offset + changes.length,
      hasMore: more,
      upperSeq: s.upper_seq,
      generation: s.generation,
      cursor: !more
        ? signCursor(
            {
              spaceId: s.space_id,
              generation: s.generation,
              protocolVersion: 1,
              epoch: s.restore_epoch,
              after: s.upper_seq,
              upper: s.upper_seq,
              done: true,
            },
            secret,
          )
        : null,
    };
  });
}
export async function clear(pool: Pool, who: Identity, body: any) {
  requireValue(
    body.confirmation === "DELETE_ALL_ACCOUNT_DATA" && uuid(body.operationId),
  );
  return transaction(pool, async (db) => {
    const existing = (
      await db.query(
        "SELECT request_hash,result FROM sync_operations WHERE space_id=$1 AND operation_id=$2 AND result->>'kind'='clear'",
        [who.spaceId, body.operationId],
      )
    ).rows[0];
    if (existing) {
      requireValue(
        existing.request_hash === digest(body),
        "OPERATION_ID_REUSED",
      );
      return existing.result;
    }
    const s = (
      await db.query(
        "SELECT * FROM spaces WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [who.spaceId, who.userId],
      )
    ).rows[0];
    requireValue(s, "AUTH_REQUIRED");
    const afterLock = (
      await db.query(
        "SELECT request_hash,result FROM sync_operations WHERE space_id=$1 AND operation_id=$2 AND result->>'kind'='clear'",
        [who.spaceId, body.operationId],
      )
    ).rows[0];
    if (afterLock) {
      requireValue(
        afterLock.request_hash === digest(body),
        "OPERATION_ID_REUSED",
      );
      return afterLock.result;
    }
    requireValue(s.generation === body.generation, "GENERATION_MISMATCH");
    const generation = (BigInt(s.generation) + 1n).toString();
    await db.query(
      "UPDATE projects SET deleted_at=coalesce(deleted_at,now()) WHERE space_id=$1",
      [s.id],
    );
    await db.query(
      "UPDATE study_sessions SET deleted_at=coalesce(deleted_at,now()) WHERE space_id=$1",
      [s.id],
    );
    await db.query(
      "UPDATE spaces SET generation=$2,change_seq=0,next_order=1 WHERE id=$1",
      [s.id, generation],
    );
    const result = { kind: "clear", generation, committed: true };
    await db.query(
      "INSERT INTO sync_operations(space_id,generation,operation_id,request_hash,result) VALUES($1,$2,$3,$4,$5)",
      [s.id, s.generation, body.operationId, digest(body), result],
    );
    return result;
  });
}
