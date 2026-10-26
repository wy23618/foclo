const repo = require("../core/repository");
const local = require("./local");
const { uuid } = require("../core/ids");
const time = require("../core/time");
const { isFactKey, FACT_VIEW_KEY } = require("../storage/account-adapter");

// Download staging is invisible. The service queue captures the latest local
// facts only after all network pages arrive; the final journal switches a pointer.
async function buildSnapshotView(ctx, pageKeys, cursor) {
  const adapter = ctx.adapter;
  if (!adapter.forView) throw new Error("当前存储适配器不支持安全全量恢复");
  const viewId = uuid(),
    target = adapter.forView(viewId),
    tasks = await local.pending(adapter),
    seen = new Set(),
    blocked = new Set(),
    keys = await adapter.keys();
  const protectedProjects = new Set(),
    dirtySessions = new Set();
  for (const t of tasks) {
    if (t.kind.startsWith("project.")) {
      protectedProjects.add(t.entityId);
      t.related.forEach((id) => protectedProjects.add(id));
    }
    if (t.kind.startsWith("session.")) {
      dirtySessions.add(t.entityId);
      const fact = t.payload?.projectId ? t.payload : await adapter.get(repo.sessionKey(t.entityId));
      if (fact?.projectId) protectedProjects.add(fact.projectId);
    }
  }
  if (ctx.active) protectedProjects.add(ctx.active.projectId);
  for (const id of Array.from(protectedProjects)) {
    let cur = ctx.projects[id]?.parentId;
    while (cur) {
      protectedProjects.add(cur);
      cur = ctx.projects[cur]?.parentId;
    }
  }
  const projects = {};
  for (const id of protectedProjects)
    if (ctx.projects[id]) projects[id] = local.clone(ctx.projects[id]);
  let prefs = { ...ctx.prefs };
  for (const key of keys)
    if (
      isFactKey(key) &&
      !key.startsWith("yotick/d/") &&
      !key.startsWith("yotick/p/") &&
      !["yotick/meta", "yotick/projects", "yotick/prefs"].includes(key)
    )
      await target.set(key, await adapter.get(key));
  async function conflict(c, code, dirty, localFact) {
    if (dirty.some((t) => t.frozen)) return;
    const id = uuid();
    await target.set(local.conflictKey(id), {
      id,
      code,
      cloud: c,
      local: localFact,
      operationIds: dirty.map((t) => t.operationId),
      createdAt: Date.now(),
    });
    for (const t of dirty) blocked.add(t.operationId);
  }
  // Apply project/preferences first: UUID snapshot order is not a tree order.
  for (const pageKey of pageKeys)
    for (const original of await adapter.get(pageKey)) {
      if (original.entityType === "session") continue;
      const c = { ...original, restoring: true },
        previous = await adapter.get(local.shadowKey(c.entityType, c.entityId));
      seen.add(c.entityType + "/" + c.entityId);
      await target.set(local.shadowKey(c.entityType, c.entityId), c);
      const dirty = tasks.filter(
        (t) =>
          t.kind.split(".")[0] === c.entityType &&
          (t.entityId === c.entityId || t.related.includes(c.entityId)),
      );
      if (dirty.length) {
        if (
          !previous ||
          previous.serverVersion !== c.serverVersion ||
          previous.deleted !== c.deleted
        )
          await conflict(
            c,
            c.deleted ? "ENTITY_DELETED" : "VERSION_CONFLICT",
            dirty,
            c.entityType === "project" ? ctx.projects[c.entityId] : ctx.prefs,
          );
        continue;
      }
      if (c.entityType === "prefs") {
        if (!c.deleted) prefs = { ...prefs, ...local.pickPrefs(c.data) };
        continue;
      }
      if (c.deleted) {
        if (protectedProjects.has(c.entityId))
          await conflict(
            c,
            "ACTIVE_PROJECT_DELETED",
            [],
            ctx.projects[c.entityId],
          );
        continue;
      }
      const same = Object.values(projects).find(
        (p) => p.id !== c.entityId && p.name === c.data.name,
      );
      if (same) {
        await conflict(c, "NAME_CONFLICT", [], same);
        continue;
      }
      projects[c.entityId] = {
        ...c.data,
        lastUsedAtSec: ctx.projects[c.entityId]?.lastUsedAtSec || null,
        spaceId: ctx.meta.id,
        revision: (ctx.projects[c.entityId]?.revision || 0) + 1,
      };
    }
  for (const pageKey of pageKeys)
    for (const original of await adapter.get(pageKey)) {
      if (original.entityType !== "session") continue;
      const c = { ...original, restoring: true },
        previous = await adapter.get(local.shadowKey("session", c.entityId)),
        old = await adapter.get(repo.sessionKey(c.entityId));
      seen.add("session/" + c.entityId);
      await target.set(local.shadowKey("session", c.entityId), c);
      const dirty = tasks.filter(
        (t) => t.kind.startsWith("session.") && t.entityId === c.entityId,
      );
      if (dirty.length || old?.status === "ACTIVE") {
        if (
          !previous ||
          previous.serverVersion !== c.serverVersion ||
          previous.deleted !== c.deleted
        )
          await conflict(
            c,
            c.deleted ? "ENTITY_DELETED" : "VERSION_CONFLICT",
            dirty,
            old,
          );
        continue;
      }
      if (c.deleted) await target.remove(repo.sessionKey(c.entityId));
      else if (projects[c.data.projectId])
        await target.set(repo.sessionKey(c.entityId), {
          ...c.data,
          spaceId: ctx.meta.id,
          revision: c.data.revision || 1,
        });
      else {
        await target.remove(repo.sessionKey(c.entityId));
        await conflict(c, "ORPHAN_SESSION", [], old);
      }
    }
  for (const key of keys)
    if (key.startsWith("yotick/shadow/")) {
      const old = await adapter.get(key);
      if (!old || seen.has(old.entityType + "/" + old.entityId)) continue;
      const c = { ...old, deleted: true, restoredMissing: true };
      await target.set(key, c);
      const dirty = tasks.filter(
        (t) =>
          t.kind.split(".")[0] === old.entityType &&
          (t.entityId === old.entityId || t.related.includes(old.entityId)),
      );
      if (dirty.length)
        await conflict(
          c,
          "ENTITY_DELETED",
          dirty,
          old.entityType === "project"
            ? ctx.projects[old.entityId]
            : old.entityType === "session"
              ? await adapter.get(repo.sessionKey(old.entityId))
              : ctx.prefs,
        );
    }
  const dayIndexes = {},
    projectIndexes = {};
  let processed = 0;
  if (
    !seen.has("prefs/account") &&
    !tasks.some((t) => t.kind === "prefs.patch")
  )
    for (const key of local.PREF_KEYS) delete prefs[key];
  for (const key of await target.keys())
    if (key.startsWith("yotick/s/")) {
      const s = await target.get(key);
      if (!s) continue;
      if (
        s.status !== "ACTIVE" &&
        !dirtySessions.has(s.id) &&
        !seen.has("session/" + s.id)
      ) {
        await target.remove(key);
        continue;
      }
      if (!projects[s.projectId]) {
        await conflict(
          { entityType: "session", entityId: s.id, data: s },
          "ORPHAN_SESSION",
          [],
          s,
        );
        await target.remove(key);
        continue;
      }
      const end =
        s.status === "ACTIVE" ? Math.floor(Date.now() / 1000) : s.endedAtSec;
      for (
        let d = time.dayIndex(s.startedAtSec);
        d <= time.dayIndex(Math.max(s.startedAtSec, end - 1));
        d++
      ) {
        const dk = time.dayKeyOfIndex(d);
        if (!dayIndexes[dk]) dayIndexes[dk] = [];
        dayIndexes[dk].push(s.id);
      }
      if (!projectIndexes[s.projectId]) projectIndexes[s.projectId] = [];
      projectIndexes[s.projectId].push(s.id);
      if (++processed % 100 === 0)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
  // Retain ancestry needed by preserved dirty/active contexts; no orphan registry.
  for (const p of Object.values(projects)) {
    let cur = p.parentId;
    while (cur && !projects[cur]) {
      if (!ctx.projects[cur])
        throw new Error("快照项目层级不完整，原视图未修改");
      projects[cur] = local.clone(ctx.projects[cur]);
      cur = ctx.projects[cur].parentId;
    }
  }
  if (prefs.lastProjectId && !projects[prefs.lastProjectId])
    delete prefs.lastProjectId;
  for (const [dk, ids] of Object.entries(dayIndexes))
    await target.set(repo.dayIndexKey(dk), ids.sort());
  for (const [id, ids] of Object.entries(projectIndexes))
    await target.set(repo.projectSessionsKey(id), ids.sort());
  await target.set(repo.PROJECTS, projects);
  await target.set(repo.PREFS, prefs);
  await target.set(repo.META, {
    ...ctx.meta,
    dataRevision: ctx.meta.dataRevision + 1,
    nextCreationOrder: Math.max(
      ctx.meta.nextCreationOrder,
      ...Object.values(projects).map((p) => p.creationOrder + 1),
    ),
  });
  const sync = await adapter.get(local.STATE),
    ops = Array.from(blocked, (id) => ({
      t: "set",
      k: "yotick/outbox-state/" + id,
      v: "conflict",
    }));
  ops.push(
    { t: "set", k: FACT_VIEW_KEY, v: viewId },
    {
      t: "set",
      k: local.STATE,
      v: {
        ...sync,
        cursor,
        lastSyncedAt: Date.now(),
        snapshotViewId: viewId,
        snapshotProgress: null,
      },
    },
  );
  try {
    await ctx.commit("snapshot-switch:" + uuid(), ops);
  } catch (error) {
    if (error.code === "LOCAL_CHANGED") {
      // Only this incomplete, invisible view is discarded. The active view and
      // immutable download remain untouched for a fresh build.
      for (const key of await target.keys())
        if (isFactKey(key)) await target.remove(key);
    }
    throw error;
  }
  return {
    viewId,
    projects: Object.keys(projects).length,
    sessions: processed,
  };
}
module.exports = { buildSnapshotView };
