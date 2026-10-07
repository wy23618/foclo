const { uuid } = require("../core/ids");
const repo = require("../core/repository");
const PREF_KEYS = [
  "startupMode",
  "defaultMinutes",
  "commonMinutes",
  "confirmEnd",
  "dailyGoalEnabled",
  "dailyGoalMinutes",
  "weekStartsSunday",
  "restEnabled",
  "shortBreakMinutes",
  "longBreakMinutes",
  "longBreakEvery",
];
const STATE = "yotick/sync/state";
const itemKey = (id) => "yotick/outbox/" + id;
const shadowKey = (type, id) => "yotick/shadow/" + type + "/" + id;
const conflictKey = (id) => "yotick/conflicts/" + id;
const receiptKey = (id) => "yotick/receipts/" + id;
function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}
function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function pickPrefs(p) {
  const out = {};
  PREF_KEYS.forEach((k) => {
    if (p && p[k] !== undefined) out[k] = p[k];
  });
  return out;
}
function projectPayload(p) {
  return {
    id: p.id,
    name: p.name,
    parentId: p.parentId,
    archived: p.archived,
    color: p.color || require("../utils/color").colorOf(p.id),
    shortName: p.shortName || "",
    creationOrder: p.creationOrder,
    createdAtSec: p.createdAtSec,
    updatedAtSec: p.updatedAtSec,
  };
}
function sessionPayload(s) {
  return {
    id: s.id,
    projectId: s.projectId,
    status: s.status,
    startedAtSec: s.startedAtSec,
    endedAtSec: s.endedAtSec,
    durationSeconds: s.durationSeconds,
    targetSeconds: s.targetSeconds,
    pauses: clone(s.pauses),
    createdAtSec: s.createdAtSec,
    updatedAtSec: s.updatedAtSec,
  };
}
async function pending(adapter) {
  const keys = (await adapter.keys()).filter(
      (k) => k.indexOf("yotick/outbox/") === 0,
    ),
    out = [];
  for (const k of keys) {
    const v = await adapter.get(k);
    if (v) {
      const status = await adapter.get("yotick/outbox-state/" + v.operationId);
      out.push(status ? { ...v, status } : v);
    }
  }
  return out.sort(
    (a, b) => a.order - b.order || a.operationId.localeCompare(b.operationId),
  );
}
// Called only from the service command queue, before its recoverable descriptor is written.
async function prepareOutbox(adapter, ops, oldProjects, oldPrefs) {
  const sync = await adapter.get(STATE);
  if (!sync || sync.quarantined) return [];
  const tasks = [],
    order = sync.nextOrder || 0;
  let next = order;
  function add(kind, id, payload, related) {
    tasks.push({
      operationId: uuid(),
      kind,
      entityId: id,
      payload: clone(payload),
      related: related || [],
      dependsOn: null,
      order: ++next,
      status: "queued",
      generation: sync.generation,
    });
  }
  const projectOp = ops.find((op) => op.k === repo.PROJECTS && op.t === "set");
  if (projectOp) {
    const before = oldProjects || {},
      after = projectOp.v;
    const removed = Object.keys(before).filter((id) => !after[id]);
    for (const id of removed.filter(
      (id) => !removed.includes(before[id].parentId),
    )) {
      const related = removed.filter((other) => {
        let cur = other;
        while (cur) {
          if (cur === id) return true;
          cur = before[cur] && before[cur].parentId;
        }
        return false;
      });
      add("project.deleteSubtree", id, { expectedVersions: {} }, related);
    }
    for (const id of Object.keys(after)) {
      const p = after[id],
        old = before[id];
      if (!old) add("project.create", id, projectPayload(p));
      else {
        const patch = {};
        ["name", "color", "shortName"].forEach((k) => {
          if (!equal(p[k], old[k]))
            patch[k] =
              k === "color"
                ? p[k] || require("../utils/color").colorOf(id)
                : p[k] || "";
        });
        if (Object.keys(patch).length) add("project.patch", id, patch);
      }
    }
    const archived = Object.keys(after).filter(
      (id) => before[id] && before[id].archived !== after[id].archived,
    );
    for (const id of archived.filter(
      (id) => !archived.includes(after[id].parentId),
    )) {
      const related = Object.keys(after).filter((other) => {
        let cur = other;
        while (cur) {
          if (cur === id) return true;
          cur = after[cur] && after[cur].parentId;
        }
        return false;
      });
      add(
        after[id].archived ? "project.archive" : "project.restore",
        id,
        { expectedVersions: {} },
        related,
      );
    }
    const groups = new Set();
    for (const id of Object.keys(after))
      if (before[id] && before[id].creationOrder !== after[id].creationOrder)
        groups.add(JSON.stringify([after[id].parentId, after[id].archived]));
    for (const key of groups) {
      const [parentId, archived] = JSON.parse(key),
        siblings = Object.values(after)
          .filter((p) => p.parentId === parentId && p.archived === archived)
          .sort((a, b) => a.creationOrder - b.creationOrder);
      if (siblings.length)
        add(
          "project.reorder",
          siblings[0].id,
          { orderedIds: siblings.map((p) => p.id), expectedVersions: {} },
          siblings.map((p) => p.id),
        );
    }
  }
  for (const op of ops) {
    if (op.k.indexOf("yotick/s/") === 0) {
      const id = op.k.slice("yotick/s/".length),
        old = await adapter.get(op.k);
      if (
        op.t === "set" &&
        op.v.status === "COMPLETED" &&
        (!old || old.status !== "COMPLETED")
      )
        add("session.createCompleted", id, sessionPayload(op.v));
      else if (
        op.t === "remove" &&
        old &&
        old.status === "COMPLETED" &&
        !tasks.some(
          (t) =>
            t.kind === "project.deleteSubtree" &&
            t.related.includes(old.projectId),
        )
      )
        add("session.delete", id, {});
    }
    if (op.k === repo.PREFS && op.t === "set") {
      const p = pickPrefs(op.v),
        before = pickPrefs(oldPrefs),
        patch = {};
      Object.keys(p).forEach((k) => {
        if (!equal(p[k], before[k])) patch[k] = p[k];
      });
      if (Object.keys(patch).length) add("prefs.patch", "account", patch);
    }
  }
  if (!tasks.length) return [];
  // Starting, pausing and resuming only change local facts. Scan the durable
  // upload backlog only when this command actually creates a cloud operation.
  const list = await pending(adapter);
  for (let i = 0; i < tasks.length; i++) {
    const previous = i ? tasks[i - 1] : list[list.length - 1];
    tasks[i].dependsOn = previous ? previous.operationId : null;
    const task = tasks[i],
      type = task.kind.split(".")[0],
      ids = [task.entityId].concat(
        task.related.filter((id) => id !== task.entityId),
      );
    task.bases = {};
    task.dependencies = {};
    for (const id of ids) {
      const key = type + "/" + id,
        shadow = await adapter.get(shadowKey(type, id));
      task.bases[key] = shadow ? shadow.serverVersion : "0";
      const prior = list
        .concat(tasks.slice(0, i))
        .filter(
          (t) =>
            t.kind.split(".")[0] === type &&
            (t.entityId === id || t.related.includes(id)),
        )
        .pop();
      if (prior) task.dependencies[key] = prior.operationId;
    }
  }
  return tasks
    .map((t) => ({ t: "set", k: itemKey(t.operationId), v: t }))
    .concat([{ t: "set", k: STATE, v: { ...sync, nextOrder: next } }]);
}
async function durable(adapter, id, ops) {
  const desc = { operationId: id, ops };
  await adapter.set(repo.commitKey(id), desc);
  for (const op of ops) {
    if (op.t === "set") await adapter.set(op.k, op.v);
    else await adapter.remove(op.k);
  }
  await adapter.remove(repo.commitKey(id));
}
module.exports = {
  STATE,
  itemKey,
  shadowKey,
  conflictKey,
  receiptKey,
  PREF_KEYS,
  pickPrefs,
  projectPayload,
  sessionPayload,
  prepareOutbox,
  pending,
  durable,
  clone,
};
