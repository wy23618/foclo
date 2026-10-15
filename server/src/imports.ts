import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { planGuestMerge } from './guest-merge.js';
import { authenticate } from "./auth.js";
import type { ServerConfig } from "./config.js";
import { transaction, executeOperation, type Identity } from "./sync.js";
import {
  requireValue,
  uuid,
  digest,
  ProtocolError,
  validateProject,
  validateSession,
} from "./protocol.js";
async function job(db: PoolClient, who: Identity, id: string) {
  requireValue(uuid(id));
  const row = (
    await db.query(
      "SELECT j.*,s.generation current_generation FROM import_jobs j JOIN spaces s ON j.space_id=s.id WHERE j.id=$1 AND j.space_id=$2 AND s.user_id=$3 AND j.expires_at>now() FOR UPDATE OF j",
      [id, who.spaceId, who.userId],
    )
  ).rows[0];
  requireValue(row, "IMPORT_NOT_FOUND");
  requireValue(
    row.generation === row.current_generation,
    "GENERATION_MISMATCH",
  );
  return row;
}
async function contents(db: PoolClient, j: any) {
  const chunks = (
    await db.query(
      "SELECT * FROM import_items WHERE job_id=$1 ORDER BY chunk_index",
      [j.id],
    )
  ).rows;
  requireValue(
    chunks.length === j.chunk_count &&
      chunks.every((c, i) => c.chunk_index === i),
    "IMPORT_INCOMPLETE",
  );
  requireValue(
    chunks.reduce((n, c) => n + Buffer.byteLength(JSON.stringify(c.data)), 0) <=
      8 * 1024 * 1024,
    "IMPORT_TOO_LARGE",
  );
  const projects: any[] = [],
    sessions: any[] = [];
  for (const c of chunks) {
    projects.push(...c.data.projects);
    sessions.push(...c.data.sessions);
  }
  requireValue(
    projects.length <= 500 && sessions.length <= 10000,
    "IMPORT_TOO_LARGE",
  );
  requireValue(
    new Set(projects.map((p) => p.id)).size === projects.length &&
      new Set(sessions.map((p) => p.id)).size === sessions.length,
    "INVALID_PAYLOAD",
  );
  return { projects, sessions };
}
async function preview(db: PoolClient, j: any) {
  const c = await contents(db, j),
    cloudProjects = (
      await db.query("SELECT * FROM projects WHERE space_id=$1", [j.space_id])
    ).rows,
    cloudSessions = (
      await db.query("SELECT * FROM study_sessions WHERE space_id=$1", [
        j.space_id,
      ])
    ).rows,
    conflicts: any[] = [];
  for (const p of c.projects) {
    validateProject(p);
    const same = cloudProjects.find((r) => r.id === p.id),
      name = cloudProjects.find(
        (r) => !r.deleted_at && r.name === p.name && r.id !== p.id,
      );
    if (same)
      conflicts.push({
        type: same.deleted_at ? "ENTITY_DELETED" : "PROJECT_ID_EXISTS",
        sourceId: p.id,
        cloud: same.data,
      });
    if (name)
      conflicts.push({
        type: "NAME_CONFLICT",
        sourceId: p.id,
        cloud: name.data,
      });
  }
  for (const s of c.sessions) {
    validateSession(s);
    const same = cloudSessions.find((r) => r.id === s.id);
    if (same)
      conflicts.push({
        type: same.deleted_at ? "ENTITY_DELETED" : "SESSION_ID_EXISTS",
        sourceId: s.id,
        cloud: same.data,
      });
  }
  return {
    mergePolicy: 'KEEP_ACCOUNT',
    projectCount: c.projects.length,
    sessionCount: c.sessions.length,
    pauseCount: c.sessions.reduce((n, s) => n + s.pauses.length, 0),
    digest: digest(c),
    conflicts,
  };
}
export function registerImports(
  app: FastifyInstance,
  pool: Pool,
  config: ServerConfig,
) {
  app.post("/api/v1/imports", async (r) => {
    const who = await authenticate(pool, config, r),
      b = r.body as any;
    requireValue(
      b &&
        Number.isInteger(b.chunkCount) &&
        b.chunkCount >= 1 &&
        b.chunkCount <= 1000 &&
        typeof b.sourceId === "string" &&
        b.sourceId.length <= 200 &&
        uuid(b.jobId),
    );
    return transaction(pool, async (db) => {
      const s = (
        await db.query(
          "SELECT generation FROM spaces WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [who.spaceId, who.userId],
        )
      ).rows[0];
      requireValue(s?.generation === b.generation, "GENERATION_MISMATCH");
      const old = (
        await db.query("SELECT * FROM import_jobs WHERE id=$1", [b.jobId])
      ).rows[0];
      if (old) {
        requireValue(
          new Date(old.expires_at).getTime() > Date.now(),
          "IMPORT_EXPIRED",
        );
        requireValue(
          old.space_id === who.spaceId &&
            old.source_id === b.sourceId &&
            old.chunk_count === b.chunkCount,
          "OPERATION_ID_REUSED",
        );
        return { id: old.id, status: old.status };
      }
      const activeJobs = Number(
        (
          await db.query(
            "SELECT count(*) FROM import_jobs WHERE space_id=$1 AND expires_at>now() AND status='uploading'",
            [who.spaceId],
          )
        ).rows[0].count,
      );
      requireValue(activeJobs < 5, "IMPORT_JOB_LIMIT");
      await db.query(
        "INSERT INTO import_jobs(id,space_id,generation,source_id,chunk_count) VALUES($1,$2,$3,$4,$5)",
        [b.jobId, who.spaceId, b.generation, b.sourceId, b.chunkCount],
      );
      return { id: b.jobId, status: "uploading" };
    });
  });
  app.put("/api/v1/imports/:id/chunks/:index", async (r) => {
    const who = await authenticate(pool, config, r),
      params = r.params as any,
      b = r.body as any,
      index = Number(params.index);
    requireValue(
      Number.isInteger(index) &&
        index >= 0 &&
        b &&
        Array.isArray(b.projects) &&
        Array.isArray(b.sessions),
    );
    requireValue(
      Buffer.byteLength(JSON.stringify(b)) <= 256 * 1024,
      "PAYLOAD_TOO_LARGE",
    );
    return transaction(pool, async (db) => {
      const j = await job(db, who, params.id);
      requireValue(
        index < j.chunk_count && j.status === "uploading",
        "IMPORT_STATE",
      );
      const hash = digest(b),
        old = (
          await db.query(
            "SELECT digest FROM import_items WHERE job_id=$1 AND chunk_index=$2",
            [j.id, index],
          )
        ).rows[0];
      if (old) requireValue(old.digest === hash, "CHUNK_REUSED");
      else {
        const currentBytes = Number(
          (
            await db.query(
              "SELECT coalesce(sum(octet_length(data::text)),0) AS bytes FROM import_items WHERE job_id=$1",
              [j.id],
            )
          ).rows[0].bytes,
        );
        requireValue(
          currentBytes + Buffer.byteLength(JSON.stringify(b)) <=
            8 * 1024 * 1024,
          "IMPORT_TOO_LARGE",
        );
        await db.query(
          "INSERT INTO import_items(job_id,chunk_index,digest,data) VALUES($1,$2,$3,$4)",
          [j.id, index, hash, b],
        );
      }
      return { index, digest: hash, received: true };
    });
  });
  app.get("/api/v1/imports/:id", async (r) => {
    const who = await authenticate(pool, config, r);
    return transaction(pool, async (db) => {
      const j = await job(db, who, (r.params as any).id);
      const received = (
        await db.query(
          "SELECT chunk_index,digest FROM import_items WHERE job_id=$1 ORDER BY chunk_index",
          [j.id],
        )
      ).rows;
      return {
        id: j.id,
        status: j.status,
        chunkCount: j.chunk_count,
        received,
        result: j.result,
      };
    });
  });
  app.post("/api/v1/imports/preview", async (r) => {
    const who = await authenticate(pool, config, r);
    return transaction(pool, async (db) =>
      preview(db, await job(db, who, (r.body as any)?.jobId)),
    );
  });
  app.post("/api/v1/imports/:id/commit", async (r) => {
    const who = await authenticate(pool, config, r),
      b = r.body as any;
    return transaction(pool, async (db) => {
      const j = await job(db, who, (r.params as any).id);
      if (j.status === "committed") return j.result;
      requireValue(
        b?.confirmation === "MERGE_GUEST_DATA" && uuid(b.deviceId),
        "CONFIRMATION_REQUIRED",
      );
      const space = (
        await db.query(
          "SELECT * FROM spaces WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [who.spaceId, who.userId],
        )
      ).rows[0];
      requireValue(space.generation === j.generation, "GENERATION_MISMATCH");
      const c = await contents(db, j);
      requireValue(b.sourceDigest === digest(c), "SOURCE_CHANGED");
      requireValue(b.mergePolicy === undefined || b.mergePolicy === 'KEEP_ACCOUNT', 'INVALID_PAYLOAD');
      const automatic = b.mergePolicy === 'KEEP_ACCOUNT';
      const plan = automatic ? planGuestMerge(c,
        (await db.query('SELECT * FROM projects WHERE space_id=$1', [space.id])).rows,
        (await db.query('SELECT * FROM study_sessions WHERE space_id=$1', [space.id])).rows,
        String(space.generation)) : null;
      const mapping = plan ? plan.mapping : b.mapping || {},
        sessionMapping = plan ? plan.sessionMapping : b.sessionMapping || {};
      requireValue(
        mapping &&
          typeof mapping === "object" &&
          !Array.isArray(mapping) &&
          sessionMapping &&
          typeof sessionMapping === "object" &&
          !Array.isArray(sessionMapping),
      );
      requireValue(
        Object.keys(sessionMapping).every(
          (id) =>
            c.sessions.some((s) => s.id === id) &&
            (sessionMapping[id] === "skip" || uuid(sessionMapping[id])),
        ),
        "INVALID_MAPPING",
      );
      const results = [];
      let addedProjectCount = 0;
      let ordered = c.projects.slice(),
        done = new Set<string>();
      while (ordered.length) {
        const ready = ordered.filter(
          (p) => !p.parentId || done.has(p.parentId) || mapping[p.parentId],
        );
        requireValue(ready.length, "INVALID_PARENT");
        for (const p of ready) {
          if (plan?.skippedProjects.has(p.id)) {
            done.add(p.id);
            continue;
          }
          if (mapping[p.id]) {
            requireValue(uuid(mapping[p.id]));
            const target = (
              await db.query(
                "SELECT id FROM projects WHERE space_id=$1 AND id=$2 AND generation=$3 AND deleted_at IS NULL",
                [space.id, mapping[p.id], space.generation],
              )
            ).rows[0];
            requireValue(target, "INVALID_MAPPING");
          } else {
            const existing = (
              await db.query(
                "SELECT * FROM projects WHERE space_id=$1 AND id=$2",
                [space.id, p.id],
              )
            ).rows[0];
            if (existing) {
              requireValue(
                !existing.deleted_at &&
                  existing.generation === space.generation,
                "ENTITY_DELETED",
              );
              const keys = [
                "id",
                "name",
                "parentId",
                "archived",
                "shortName",
                "color",
              ];
              requireValue(
                keys.every(
                  (k) => (existing.data[k] ?? null) === (p[k] ?? null),
                ),
                "VERSION_CONFLICT",
              );
            } else {
              addedProjectCount++;
              results.push(
                await executeOperation(
                  db,
                  space,
                  {
                    operationId: randomUUID(),
                    kind: "project.create",
                    entityId: p.id,
                    payload: {
                      ...(plan?.projectOverrides[p.id] || p),
                      parentId: mapping[p.parentId] || p.parentId,
                    },
                  },
                  b.deviceId,
                ),
              );
            }
          }
          done.add(p.id);
        }
        ordered = ordered.filter((p) => !done.has(p.id));
      }
      for (const s of c.sessions) {
        if (sessionMapping[s.id] === "skip") continue;
        const id = sessionMapping[s.id] || s.id,
          data = {
            ...s,
            id,
            projectId: mapping[s.projectId] || s.projectId,
            pauses: s.pauses.map((p: any) =>
              id !== s.id ? { ...p, id: randomUUID(), sessionId: id } : p,
            ),
          };
        results.push(
          await executeOperation(
            db,
            space,
            {
              operationId: randomUUID(),
              kind: "session.createCompleted",
              entityId: id,
              payload: data,
            },
            b.deviceId,
          ),
        );
      }
      await db.query(
        "UPDATE spaces SET change_seq=$2,next_order=$3 WHERE id=$1",
        [space.id, space.change_seq, space.next_order],
      );
      const result = {
        committed: true,
        sourceProjectCount: c.projects.length,
        sourceSessionCount: c.sessions.length,
        projectCount: new Set(c.projects.filter(p => !plan?.skippedProjects.has(p.id)).map((p) => mapping[p.id] || p.id))
          .size,
        sessionCount: new Set(
          c.sessions
            .filter((s) => sessionMapping[s.id] !== "skip")
            .map((s) => sessionMapping[s.id] || s.id),
        ).size,
        pauseCount: c.sessions
          .filter((s) => sessionMapping[s.id] !== "skip")
          .reduce((n, s) => n + s.pauses.length, 0),
        sourceDigest: digest(c),
        mapping,
        sessionMapping,
        ...(automatic ? { mergePolicy:'KEEP_ACCOUNT',
          addedProjectCount,
          addedSessionCount:c.sessions.filter(s => sessionMapping[s.id] !== 'skip').length,
          skippedSessionCount:c.sessions.filter(s => sessionMapping[s.id] === 'skip').length,
          skippedProjectCount:plan!.skippedProjects.size } : {}),
        upperSeq: space.change_seq,
      };
      await db.query(
        "UPDATE import_jobs SET status='committed',mapping=$2,result=$3 WHERE id=$1",
        [j.id, mapping, result],
      );
      return result;
    });
  });
}
