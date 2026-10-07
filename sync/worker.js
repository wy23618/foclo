const local = require("./local");
const repo = require("../core/repository");
const { uuid } = require("../core/ids");
const time = require("../core/time");
function createWorker({
  service,
  request,
  deviceId,
  isCurrent = () => true,
  onStatus = () => {},
  onChanged = () => {},
}) {
  let running = null,
    stopped = false,
    timer = null,
    failures = 0;
  function valid() {
    if (stopped || !isCurrent()) {
      const e = new Error("账号已切换");
      e.code = "CANCELLED";
      throw e;
    }
  }
  async function tx(fn) {
    valid();
    return service.syncTransaction(async (ctx) => {
      valid();
      return fn(ctx);
    });
  }
  async function indexSession(ctx, s, remove, ops, indexes) {
    const keys = [repo.projectSessionsKey(s.projectId)];
    for (
      let d = time.dayIndex(s.startedAtSec);
      d <= time.dayIndex(Math.max(s.startedAtSec, s.endedAtSec - 1));
      d++
    )
      keys.push(repo.dayIndexKey(time.dayKeyOfIndex(d)));
    for (const k of keys) {
      if (!indexes[k]) indexes[k] = (await ctx.adapter.get(k)) || [];
      indexes[k] = indexes[k].filter((id) => id !== s.id);
      if (!remove) indexes[k].push(s.id);
      indexes[k].sort();
    }
    ops.push(
      remove
        ? { t: "remove", k: repo.sessionKey(s.id) }
        : {
            t: "set",
            k: repo.sessionKey(s.id),
            v: { ...s, spaceId: ctx.meta.id, revision: s.revision || 1 },
          },
    );
  }
  async function apply(changes, cursor, acks) {
    return tx(async (ctx) => {
      const tasks = await local.pending(ctx.adapter),
        ops = [],
        indexes = {},
        projects = { ...ctx.projects };
      let prefs = { ...ctx.prefs };
      let changedProjects = false;
      let changedPrefs = false;
      const acknowledged = new Set((acks || []).map((a) => a.operationId));
      for (const c of changes) {
        const shadow = { ...c },
          key = local.shadowKey(c.entityType, c.entityId),
          previous = await ctx.adapter.get(key);
        if (
          !c.restoring &&
          previous &&
          BigInt(previous.serverVersion) > BigInt(c.serverVersion)
        )
          continue;
        ops.push({ t: "set", k: key, v: shadow });
        const dirty = tasks.filter(
          (t) =>
            !acknowledged.has(t.operationId) &&
            ((t.entityId === c.entityId &&
              t.kind.split(".")[0] ===
                (c.entityType === "prefs" ? "prefs" : c.entityType)) ||
              t.related.includes(c.entityId)),
        );
        if (dirty.length) {
          if (
            !previous ||
            previous.serverVersion !== c.serverVersion ||
            previous.deleted !== c.deleted ||
            c.restoredMissing
          ) {
            const frozen = dirty.some((t) => t.frozen),
              code = c.deleted ? "ENTITY_DELETED" : "VERSION_CONFLICT";
            // A create acknowledgement followed by queued local edits is a dependency, not a conflict.
            const ownAck = (acks || []).some((a) =>
              (a.changes || []).some(
                (x) =>
                  x.entityType === c.entityType &&
                  x.entityId === c.entityId &&
                  x.serverVersion === c.serverVersion,
              ),
            );
            if (!ownAck && !frozen) {
              const id = uuid();
              ops.push({
                t: "set",
                k: local.conflictKey(id),
                v: {
                  id,
                  code,
                  cloud: c,
                  local:
                    c.entityType === "project"
                      ? projects[c.entityId]
                      : c.entityType === "prefs"
                        ? prefs
                        : await ctx.adapter.get(repo.sessionKey(c.entityId)),
                  operationIds: dirty.map((t) => t.operationId),
                  createdAt: Date.now(),
                },
              });
              for (const t of dirty)
                ops.push({
                  t: "set",
                  k: local.itemKey(t.operationId),
                  v: { ...t, status: "conflict" },
                });
            }
          }
          continue;
        }
        if (c.entityType === "project") {
          if (c.deleted) {
            let cur = ctx.active && ctx.active.projectId,
              depends = false;
            while (cur) {
              if (cur === c.entityId) {
                depends = true;
                break;
              }
              cur = projects[cur] && projects[cur].parentId;
            }
            if (depends) {
              const id = "deleted-active-" + c.entityId;
              ops.push({
                t: "set",
                k: local.conflictKey(id),
                v: {
                  id,
                  code: "ACTIVE_PROJECT_DELETED",
                  cloud: c,
                  local: projects[c.entityId],
                  operationIds: [],
                  createdAt: Date.now(),
                },
              });
              continue;
            }
            delete projects[c.entityId];
            if (prefs.lastProjectId === c.entityId) delete prefs.lastProjectId;
          } else {
            const same = Object.values(projects).find(
              (p) => p.id !== c.entityId && p.name === c.data.name,
            );
            if (same) {
              const id = uuid();
              ops.push({
                t: "set",
                k: local.conflictKey(id),
                v: {
                  id,
                  code: "NAME_CONFLICT",
                  cloud: c,
                  local: same,
                  operationIds: [],
                  createdAt: Date.now(),
                },
              });
              continue;
            }
            projects[c.entityId] = {
              ...c.data,
              lastUsedAtSec: projects[c.entityId]?.lastUsedAtSec || null,
              spaceId: ctx.meta.id,
              revision: (projects[c.entityId]?.revision || 0) + 1,
            };
          }
          changedProjects = true;
        } else if (c.entityType === "session") {
          const old = await ctx.adapter.get(repo.sessionKey(c.entityId));
          if (c.deleted) {
            if (old && old.status === "COMPLETED")
              await indexSession(ctx, old, true, ops, indexes);
          } else if (projects[c.data.projectId]) {
            if (old && old.status === "ACTIVE") {
              const id = uuid();
              ops.push({
                t: "set",
                k: local.conflictKey(id),
                v: {
                  id,
                  code: "ACTIVE_ID_CONFLICT",
                  cloud: c,
                  local: old,
                  operationIds: [],
                },
              });
            } else await indexSession(ctx, c.data, false, ops, indexes);
          } else {
            const id = uuid();
            ops.push({
              t: "set",
              k: local.conflictKey(id),
              v: {
                id,
                code: "ORPHAN_SESSION",
                cloud: c,
                local: old,
                operationIds: [],
                createdAt: Date.now(),
              },
            });
          }
        } else if (c.entityType === "prefs") {
          prefs = { ...prefs, ...local.pickPrefs(c.data) };
          changedPrefs = true;
        }
      }
      if (changedProjects || changedPrefs)
        ops.push({ t: "set", k: repo.PROJECTS, v: projects });
      if (changedPrefs) ops.push({ t: "set", k: repo.PREFS, v: prefs });
      Object.keys(indexes).forEach((k) =>
        ops.push({ t: "set", k, v: indexes[k] }),
      );
      for (const ack of acks || [])
        if (ack.status === "applied")
          ops.push(
            { t: "set", k: local.receiptKey(ack.operationId), v: ack },
            { t: "remove", k: local.itemKey(ack.operationId) },
            { t: "remove", k: "yotick/outbox-state/" + ack.operationId },
          );
      const s = await ctx.adapter.get(local.STATE);
      ops.push({
        t: "set",
        k: local.STATE,
        v: { ...s, ...(cursor ? { cursor } : {}), lastSyncedAt: Date.now() },
      });
      const meta = {
        ...ctx.meta,
        dataRevision: ctx.meta.dataRevision + 1,
        nextCreationOrder: Math.max(
          ctx.meta.nextCreationOrder,
          ...Object.values(projects).map((p) => p.creationOrder + 1),
        ),
      };
      if (changedProjects || changedPrefs || Object.keys(indexes).length)
        ops.push({ t: "set", k: repo.META, v: meta });
      await ctx.commit("sync:" + uuid(), ops);
    });
  }
  async function pullAll() {
    let more = true;
    while (more) {
      const s = await tx((ctx) => ctx.adapter.get(local.STATE));
      if (s.quarantined)
        throw Object.assign(new Error("旧代次数据已隔离，请导出保全"), {
          code: "GENERATION_MISMATCH",
        });
      if (s.snapshotProgress) {
        await restoreSnapshot(s);
        return;
      }
      let page;
      try {
        page = await request("GET", "/sync/pull", {
          generation: s.generation,
          cursor: s.cursor || undefined,
        });
      } catch (e) {
        if (e.code === "CURSOR_EXPIRED") {
          await restoreSnapshot(s);
          return;
        }
        throw e;
      }
      valid();
      await apply(page.changes, page.cursor);
      more = page.hasMore;
    }
  }
  async function restoreSnapshot(s) {
    let progress = s.snapshotProgress;
    if (!progress) {
      const snap = await request("POST", "/sync/snapshots", {
        generation: s.generation,
      });
      progress = { id: snap.id, offset: 0, pageKeys: [], ready: false };
      await tx(async (ctx) => {
        const current = await ctx.adapter.get(local.STATE);
        await ctx.commit("snapshot-start:" + uuid(), [
          {
            t: "set",
            k: local.STATE,
            v: { ...current, snapshotProgress: progress },
          },
        ]);
      });
    }
    while (!progress.ready) {
      let page;
      try {
        page = await request("GET", "/sync/snapshots/" + progress.id, {
          offset: progress.offset,
        });
      } catch (e) {
        if (e.code === "SNAPSHOT_EXPIRED") {
          await tx(async (ctx) => {
            const current = await ctx.adapter.get(local.STATE);
            await ctx.commit("snapshot-expired:" + uuid(), [
              {
                t: "set",
                k: local.STATE,
                v: { ...current, snapshotProgress: null },
              },
            ]);
          });
          return restoreSnapshot({ ...s, snapshotProgress: null });
        }
        throw e;
      }
      valid();
      const key =
        "yotick/snapshot-pages/" + progress.id + "/" + progress.offset;
      progress = {
        ...progress,
        offset: page.nextOffset,
        pageKeys: progress.pageKeys.concat(key),
        ready: !page.hasMore,
        cursor: page.cursor,
      };
      await tx(async (ctx) => {
        const current = await ctx.adapter.get(local.STATE);
        await ctx.commit("snapshot-page:" + uuid(), [
          { t: "set", k: key, v: page.changes },
          {
            t: "set",
            k: local.STATE,
            v: { ...current, snapshotProgress: progress },
          },
        ]);
      });
    }
    valid();
    await service.buildSyncView(
      (ctx) =>
        require("./snapshot-view").buildSnapshotView(
          ctx,
          progress.pageKeys,
          progress.cursor,
        ),
      valid,
    );
  }
  async function next() {
    return tx(async (ctx) => {
      const s = await ctx.adapter.get(local.STATE),
        tasks = await local.pending(ctx.adapter);
      if (s.snapshotProgress) return null;
      if (s.quarantined) return null;
      const t = tasks[0];
      if (!t || t.status === "conflict") return null;
      if (t.frozen) return t;
      let type = t.kind.split(".")[0],
        shadow = await ctx.adapter.get(local.shadowKey(type, t.entityId));
      const payload = local.clone(t.payload),
        base = shadow ? shadow.serverVersion : "0";
      if (t.kind !== "project.create" && t.kind !== "session.createCompleted")
        for (const key of Object.keys(t.bases || {})) {
          const dep = t.dependencies[key],
            receipt = dep ? await ctx.adapter.get(local.receiptKey(dep)) : null;
          const parts = key.split("/"),
            sh = await ctx.adapter.get(local.shadowKey(parts[0], parts[1]));
          const expected = receipt
            ? receipt.changes.find(
                (c) => c.entityType === parts[0] && c.entityId === parts[1],
              )?.serverVersion || t.bases[key]
            : t.bases[key];
          if (dep && !receipt) {
            const id = uuid();
            await ctx.commit("missing-dependency:" + id, [
              {
                t: "set",
                k: local.itemKey(t.operationId),
                v: { ...t, status: "conflict" },
              },
              {
                t: "set",
                k: local.conflictKey(id),
                v: {
                  id,
                  code: "DEPENDENCY_PENDING",
                  local: t,
                  cloud: sh,
                  operationIds: [t.operationId],
                  createdAt: Date.now(),
                },
              },
            ]);
            return null;
          }
          if ((sh ? sh.serverVersion : "0") !== expected) {
            const id = uuid();
            await ctx.commit("dependency-conflict:" + id, [
              {
                t: "set",
                k: local.itemKey(t.operationId),
                v: { ...t, status: "conflict" },
              },
              {
                t: "set",
                k: local.conflictKey(id),
                v: {
                  id,
                  code: "VERSION_CONFLICT",
                  cloud: sh,
                  local: t,
                  operationIds: [t.operationId],
                  createdAt: Date.now(),
                },
              },
            ]);
            return null;
          }
        }
      if (payload.expectedVersions) {
        for (const id of t.related) {
          const sh = await ctx.adapter.get(local.shadowKey("project", id));
          if (!sh || sh.deleted) {
            const idc = uuid();
            await ctx.commit("sync-conflict:" + idc, [
              {
                t: "set",
                k: local.itemKey(t.operationId),
                v: { ...t, status: "conflict" },
              },
              {
                t: "set",
                k: local.conflictKey(idc),
                v: {
                  id: idc,
                  code: "ENTITY_DELETED",
                  local: t,
                  cloud: sh,
                  operationIds: [t.operationId],
                },
              },
            ]);
            return null;
          }
          payload.expectedVersions[id] = sh.serverVersion;
        }
      }
      const operation = {
        operationId: t.operationId,
        kind: t.kind,
        entityId: t.entityId,
        payload,
        ...(t.kind === "project.create" || t.kind === "session.createCompleted"
          ? {}
          : { baseServerVersion: base }),
      };
      if (
        unescape(encodeURIComponent(JSON.stringify(operation))).length >
        220 * 1024
      ) {
        const id = uuid();
        await ctx.commit("large-entity:" + id, [
          {
            t: "set",
            k: local.itemKey(t.operationId),
            v: { ...t, status: "conflict" },
          },
          {
            t: "set",
            k: local.conflictKey(id),
            v: {
              id,
              code: "PAYLOAD_TOO_LARGE",
              local: t,
              cloud: shadow,
              operationIds: [t.operationId],
              createdAt: Date.now(),
            },
          },
        ]);
        return null;
      }
      // Dependency receipt is already durable locally before selecting the next task.
      const frozen = { ...t, frozen: operation, status: "sending" };
      await ctx.commit("freeze:" + t.operationId, [
        { t: "set", k: local.itemKey(t.operationId), v: frozen },
      ]);
      return frozen;
    });
  }
  async function run() {
    try {
      const queued = await tx((ctx) => local.pending(ctx.adapter));
      onStatus({ state: "syncing", pending: queued.length });
      await pullAll();
      for (let i = 0; i < 50; i++) {
        const task = await next();
        if (!task) break;
        const s = await tx((ctx) => ctx.adapter.get(local.STATE));
        const response = await request("POST", "/sync/push", {
          protocolVersion: 1,
          spaceId: s.spaceId,
          generation: s.generation,
          deviceId,
          operations: [task.frozen],
        });
        valid();
        const ack = response.results[0];
        if (ack.status === "applied") {
          await apply(ack.changes, null, [ack]);
          if (ack.hasMoreChanges) await pullAll();
        } else if (ack.code === "DEPENDENCY_PENDING") break;
        else
          await tx(async (ctx) => {
            const id = uuid();
            await ctx.commit("conflict:" + id, [
              {
                t: "set",
                k: local.itemKey(task.operationId),
                v: { ...task, status: "conflict" },
              },
              {
                t: "set",
                k: local.conflictKey(id),
                v: {
                  id,
                  code: ack.code,
                  local: task,
                  cloud: await ctx.adapter.get(
                    local.shadowKey(task.kind.split(".")[0], task.entityId),
                  ),
                  operationIds: [task.operationId],
                  createdAt: Date.now(),
                },
              },
            ]);
          });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await pullAll();
      failures = 0;
      const p = await tx((ctx) => local.pending(ctx.adapter));
      onStatus({
        state: p.some((t) => t.status === "conflict")
          ? "conflict"
          : p.length
            ? "pending"
            : "synced",
        pending: p.length,
        lastSyncedAt: Date.now(),
      });
      onChanged();
      if (p.length && p[0].status !== "conflict")
        timer = setTimeout(() => trigger(), 1000);
    } catch (e) {
      if (e.code === "CANCELLED") return;
      if (e.code === "GENERATION_MISMATCH")
        await tx(async (ctx) => {
          const s = await ctx.adapter.get(local.STATE);
          await ctx.commit("quarantine:" + uuid(), [
            { t: "set", k: local.STATE, v: { ...s, quarantined: true } },
          ]);
        });
      onStatus({
        state:
          e.code === "AUTH_REQUIRED"
            ? "auth-required"
            : e.code === "GENERATION_MISMATCH"
              ? "quarantined"
              : e.code === "NETWORK_ERROR"
                ? "offline"
                : "failed",
        code: e.code,
        message: e.message,
      });
      if (
        !["AUTH_REQUIRED", "GENERATION_MISMATCH"].includes(e.code) &&
        !stopped
      ) {
        const delay =
          Math.min(60000, 1000 * 2 ** Math.min(++failures, 6)) *
          (0.75 + Math.random() * 0.5);
        timer = setTimeout(() => trigger(), delay);
      }
    }
  }
  function trigger() {
    if (stopped) return Promise.resolve();
    if (!running)
      running = run().finally(() => {
        running = null;
      });
    return running;
  }
  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (request && request.cancel) request.cancel();
  }
  return { trigger, stop, apply };
}
module.exports = { createWorker };
