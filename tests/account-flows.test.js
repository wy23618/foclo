const test = require("node:test");
const assert = require("node:assert/strict");

const { createMemoryAdapter } = require("../storage/adapter");
const { createAccountAdapter } = require("../storage/account-adapter");
const { createService } = require("../core/service");
const { createAccounts } = require("../sync/accounts");
const migration = require("../sync/migration");
const { uuid } = require("../core/ids");
const local = require("../sync/local");

async function accountFixture() {
  const raw = createMemoryAdapter(),
    app = { globalData: {} },
    accounts = createAccounts(raw, app);
  await accounts.init();
  await accounts.activate({ userId: uuid(), spaceId: uuid(), generation: "1" });
  return {
    raw,
    app,
    accounts,
    adapter: app.globalData.adapter,
    service: app.globalData.service,
  };
}

async function clearOutbox(adapter) {
  for (const task of await local.pending(adapter))
    await adapter.remove(local.itemKey(task.operationId));
}

async function addConflict(adapter, id, cloud, task) {
  await adapter.set(local.conflictKey(id), {
    id,
    code: "VERSION_CONFLICT",
    cloud,
    local: task
      ? { kind: task.kind, payload: task.payload, related: task.related }
      : null,
    operationIds: task ? [task.operationId] : [],
    createdAt: Date.now(),
  });
}

async function seedProjectShadows(adapter, ids, projects, version = "5") {
  for (const id of ids) {
    const project = projects[id];
    assert.ok(project, "fixture must include related project " + id);
    await adapter.set(local.shadowKey("project", id), {
      entityType: "project",
      entityId: id,
      serverVersion: version,
      data: local.projectPayload(project),
      deleted: false,
    });
  }
}

test("preference conflict resolution requeues only account preferences and preserves the original operation", async () => {
  const f = await accountFixture();
  await f.service.savePrefs({
    theme: "dark",
    defaultMinutes: 45,
    startupMode: "remember",
  });
  const original = (await local.pending(f.adapter)).find(
    (task) => task.kind === "prefs.patch",
  );
  assert.ok(original);
  const id = uuid();
  const localProjects = await f.adapter.get("yotick/projects");
  await seedProjectShadows(f.adapter, original.related, localProjects);
  await addConflict(
    f.adapter,
    id,
    {
      entityType: "prefs",
      entityId: "account",
      serverVersion: "4",
      data: { defaultMinutes: 30, startupMode: "today" },
    },
    original,
  );

  await f.accounts.resolveConflict(id, "local");

  const tasks = await local.pending(f.adapter);
  assert.equal(tasks.length, 1);
  assert.notEqual(tasks[0].operationId, original.operationId);
  assert.equal(tasks[0].kind, "prefs.patch");
  assert.equal(tasks[0].entityId, "account");
  assert.deepEqual(tasks[0].payload, {
    defaultMinutes: 45,
    startupMode: "remember",
  });
  assert.equal(await f.adapter.get(local.conflictKey(id)), undefined);
  const recovery = await f.adapter.get("yotick/recovery/" + id);
  assert.equal(recovery.preservedTasks[0].operationId, original.operationId);
  assert.equal(recovery.preservedTasks[0].payload.startupMode, "remember");
});

test("project order conflict resolution requeues the full local sibling order", async () => {
  const f = await accountFixture();
  const a = await f.service.createProject({
    operationId: uuid(),
    name: "排序甲",
  });
  const b = await f.service.createProject({
    operationId: uuid(),
    name: "排序乙",
  });
  await clearOutbox(f.adapter);
  await f.service.moveProjectOrder({
    operationId: uuid(),
    projectId: b.data.project.id,
    direction: "up",
  });
  const original = (await local.pending(f.adapter)).find(
    (task) => task.kind === "project.reorder",
  );
  assert.ok(original);
  assert.deepEqual(original.payload.orderedIds, [
    b.data.project.id,
    a.data.project.id,
  ]);
  assert.deepEqual(original.related, [b.data.project.id, a.data.project.id]);

  const id = uuid();
  const localProjects = await f.adapter.get("yotick/projects");
  await seedProjectShadows(f.adapter, original.related, localProjects);
  await addConflict(
    f.adapter,
    id,
    {
      entityType: "project",
      entityId: original.entityId,
      serverVersion: "5",
      data: { ...b.data.project, creationOrder: 2 },
    },
    original,
  );
  await f.accounts.resolveConflict(id, "local");

  const tasks = await local.pending(f.adapter);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, "project.reorder");
  assert.deepEqual(tasks[0].payload, original.payload);
  assert.deepEqual(tasks[0].related, original.related);
  assert.equal(
    (await f.adapter.get("yotick/recovery/" + id)).preservedTasks[0]
      .operationId,
    original.operationId,
  );
});

test("project archive conflict resolution preserves the archive operation and entire subtree scope", async () => {
  const f = await accountFixture();
  const parent = await f.service.createProject({
    operationId: uuid(),
    name: "归档父级",
  });
  const child = await f.service.createProject({
    operationId: uuid(),
    name: "归档子级",
    parentId: parent.data.project.id,
  });
  await clearOutbox(f.adapter);
  await f.service.archiveProject({
    operationId: uuid(),
    projectId: parent.data.project.id,
  });
  const original = (await local.pending(f.adapter)).find(
    (task) => task.kind === "project.archive",
  );
  assert.ok(original);
  assert.deepEqual(
    new Set(original.related),
    new Set([parent.data.project.id, child.data.project.id]),
  );

  const id = uuid();
  const localProjects = await f.adapter.get("yotick/projects");
  await seedProjectShadows(f.adapter, original.related, localProjects);
  await addConflict(
    f.adapter,
    id,
    {
      entityType: "project",
      entityId: parent.data.project.id,
      serverVersion: "2",
      data: parent.data.project,
    },
    original,
  );
  await f.accounts.resolveConflict(id, "local");

  const tasks = await local.pending(f.adapter);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, "project.archive");
  assert.deepEqual(tasks[0].payload, original.payload);
  assert.deepEqual(new Set(tasks[0].related), new Set(original.related));
  assert.equal(
    (await f.adapter.get("yotick/projects"))[parent.data.project.id].archived,
    true,
  );
});

test("cached cloud preference conflict applies without credentials or a worker", async () => {
  const f = await accountFixture();
  assert.equal(f.accounts.getStatus().state, "auth-required");
  await f.service.savePrefs({
    theme: "dark",
    defaultMinutes: 45,
    startupMode: "remember",
  });
  const original = (await local.pending(f.adapter)).find(
    (task) => task.kind === "prefs.patch",
  );
  const id = uuid();
  await addConflict(
    f.adapter,
    id,
    {
      entityType: "prefs",
      entityId: "account",
      serverVersion: "7",
      data: { defaultMinutes: 30, startupMode: "today" },
    },
    original,
  );

  await f.accounts.resolveConflict(id, "cloud");

  assert.deepEqual(await f.service.getPrefs(), {
    theme: "dark",
    defaultMinutes: 30,
    startupMode: "today",
  });
  assert.equal((await local.pending(f.adapter)).length, 0);
  assert.equal(await f.adapter.get(local.conflictKey(id)), undefined);
  assert.ok(await f.adapter.get("yotick/recovery/" + id));
});

test("project group cloud choice applies every shadow and resumes after interrupted resolve", async () => {
  const f = await accountFixture();
  const a = await f.service.createProject({
    operationId: uuid(),
    name: "组内甲",
  });
  const b = await f.service.createProject({
    operationId: uuid(),
    name: "组内乙",
  });
  await clearOutbox(f.adapter);
  await f.service.moveProjectOrder({
    operationId: uuid(),
    projectId: b.data.project.id,
    direction: "up",
  });
  const original = (await local.pending(f.adapter)).find(
    (task) => task.kind === "project.reorder",
  );
  const projects = await f.adapter.get("yotick/projects");
  await seedProjectShadows(f.adapter, original.related, projects, "6");

  const remoteB = {
    entityType: "project",
    entityId: b.data.project.id,
    serverVersion: "7",
    deleted: false,
    data: {
      ...local.projectPayload(projects[b.data.project.id]),
      name: "云端乙",
      creationOrder: 2,
    },
  };
  const remoteA = await f.adapter.get(
    local.shadowKey("project", a.data.project.id),
  );
  remoteA.serverVersion = "7";
  remoteA.data = { ...remoteA.data, name: "云端甲", creationOrder: 1 };
  await f.adapter.set(local.shadowKey("project", a.data.project.id), remoteA);
  const conflictId = uuid();
  await addConflict(f.adapter, conflictId, remoteB, original);

  // The first transaction preserves the choice and drops the old task. Fail the
  // following fact-application journal write to simulate a crash between phases.
  f.raw.inject(
    (key) => key.includes("/yotick/c/sync:"),
    1,
    new Error("resolve interrupted"),
    "set",
  );
  await assert.rejects(
    f.accounts.resolveConflict(conflictId, "cloud"),
    /保存失败|resolve interrupted/,
  );
  f.raw.clearFaults();
  const interrupted = await f.adapter.get(local.conflictKey(conflictId));
  assert.equal(interrupted.resolving, "cloud");
  assert.deepEqual(
    interrupted.resolutionChanges.map((change) => change.entityId).sort(),
    original.related.slice().sort(),
  );
  assert.equal((await local.pending(f.adapter)).length, 0);

  // Re-open the account service as after an app restart, then replay the saved
  // cloud change set without asking the server for another response.
  const restartedApp = { globalData: {} };
  const restarted = createAccounts(f.raw, restartedApp);
  await restarted.init();
  await restarted.resolveConflict(conflictId, "cloud");
  const rows = Object.values(
    await restartedApp.globalData.adapter.get("yotick/projects"),
  ).sort((left, right) => left.creationOrder - right.creationOrder);
  assert.deepEqual(
    rows.map((project) => project.name),
    ["云端甲", "云端乙"],
  );
  assert.deepEqual(
    rows.map((project) => project.id),
    [a.data.project.id, b.data.project.id],
  );
  assert.equal(
    await restartedApp.globalData.adapter.get(local.conflictKey(conflictId)),
    undefined,
  );
  assert.deepEqual(
    (
      await restartedApp.globalData.adapter.get("yotick/recovery/" + conflictId)
    ).preservedTasks.map((task) => task.operationId),
    [original.operationId],
  );
});

function largeGuestFixture(projectCount = 1500) {
  const raw = createMemoryAdapter(),
    guest = createAccountAdapter(raw, "guest");
  const projects = {};
  for (let i = 0; i < projectCount; i++) {
    const id = "00000000-0000-4000-8000-" + i.toString(16).padStart(12, "0");
    projects[id] = {
      id,
      spaceId: "legacy-guest",
      name: "项目" + i + "-" + "学".repeat(48),
      parentId: null,
      archived: false,
      creationOrder: i + 1,
      createdAtSec: 100,
      updatedAtSec: 100,
      revision: 1,
      color: "#425B42",
      shortName: "",
    };
  }
  const account = createAccountAdapter(raw, "account@1");
  return (async () => {
    await guest.set("yotick/meta", {
      id: "legacy-guest",
      schemaVersion: 1,
      dataRevision: 0,
      utcOffsetMinutes: 480,
      activeSessionId: null,
      nextCreationOrder: projectCount + 1,
      lastMonotonicSec: 100,
      createdAtSec: 100,
    });
    await guest.set("yotick/projects", projects);
    await guest.set("yotick/prefs", {});
    await account.set(local.STATE, {
      spaceId: uuid(),
      userId: uuid(),
      generation: "1",
      nextOrder: 0,
    });
    return { raw, guest, account };
  })();
}

function codedError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

test("a later explicit guest migration captures new facts and preserves the previous published mapping", async () => {
  const f = await largeGuestFixture(2),
    first = await migration.prepare(f.raw, f.account);
  const committed = {
    ...first,
    status: "committed",
    result: { mapping: { source: "destination" } },
  };
  await f.account.set("yotick/import/current", committed);
  const guestService = createService(f.guest, { syncEnabled: false });
  assert.equal((await guestService.init()).ok, true);
  assert.equal(
    (
      await guestService.createProject({
        operationId: uuid(),
        name: "迁移后的新增游客资料",
      })
    ).ok,
    true,
  );
  const next = await migration.prepare(f.raw, f.account);
  assert.notEqual(next.id, first.id);
  assert.equal(next.projectCount, 3);
  assert.deepEqual(
    await f.account.get("yotick/import-history/" + first.id),
    committed,
  );
  const chunk = await f.account.get("yotick/import/" + next.id + "/0");
  assert.ok(chunk.projects.some((p) => p.name === "迁移后的新增游客资料"));
  assert.equal(
    (await f.account.get("yotick/import/" + first.id + "/0")).projects.length,
    2,
  );
});

test("interrupted guest chunk upload resumes the same staging job and skips received chunks", async () => {
  const f = await largeGuestFixture();
  const uploaded = new Set(),
    calls = [],
    jobIds = [];
  let failOnce = true,
    chunkCount = 0;
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/imports") {
      jobIds.push(body.jobId);
      chunkCount = body.chunkCount;
      return { id: body.jobId };
    }
    const id = path.split("/")[2];
    if (method === "GET" && path === "/imports/" + id)
      return {
        received: Array.from(uploaded, (chunk_index) => ({ chunk_index })),
      };
    if (method === "PUT" && path.startsWith("/imports/")) {
      const index = Number(path.split("/").pop());
      if (failOnce && index === 1) {
        failOnce = false;
        throw codedError("NETWORK_ERROR", "interrupted upload");
      }
      uploaded.add(index);
      return { index, received: true };
    }
    if (method === "POST" && path === "/imports/preview")
      return {
        projectCount: 1500,
        sessionCount: 0,
        conflicts: [],
        digest: "stable-digest",
      };
    throw new Error("Unexpected mock request: " + method + " " + path);
  };

  await assert.rejects(
    migration.upload(f.raw, f.account, request, "1"),
    /interrupted upload/,
  );
  const staged = await f.account.get("yotick/import/current");
  assert.equal(staged.status, "prepared");
  assert.ok(staged.chunkCount > 1);
  assert.equal(uploaded.has(0), true);

  const preview = await migration.upload(f.raw, f.account, request, "1");
  assert.equal(preview.digest, "stable-digest");
  assert.deepEqual(new Set(jobIds), new Set([staged.id]));
  assert.equal(jobIds.length, 2);
  assert.equal(uploaded.size, chunkCount);
  assert.equal(
    calls.filter((call) => call.method === "PUT" && call.path.endsWith("/0"))
      .length,
    1,
  );
  assert.equal(
    (await f.account.get("yotick/import/current")).status,
    "preview",
  );
});

test("expired guest import job is rebuilt with a new job ID while reusing immutable source chunks", async () => {
  const f = await largeGuestFixture();
  const prepared = await migration.prepare(f.raw, f.account);
  assert.ok(prepared.chunkCount > 1);
  const sourceChunks = [];
  for (let i = 0; i < prepared.chunkCount; i++)
    sourceChunks.push(
      await f.account.get("yotick/import/" + prepared.id + "/" + i),
    );
  const jobIds = [],
    receivedByNewJob = new Set(),
    chunkBodies = [];
  let initialPost = true;
  const request = async (method, path, body) => {
    if (method === "POST" && path === "/imports") {
      jobIds.push(body.jobId);
      if (initialPost) {
        initialPost = false;
        throw codedError("IMPORT_EXPIRED", "expired staging job");
      }
      return { id: body.jobId };
    }
    const id = path.split("/")[2];
    if (method === "GET" && path === "/imports/" + id) return { received: [] };
    if (method === "PUT" && path.startsWith("/imports/")) {
      const index = Number(path.split("/").pop());
      chunkBodies[index] = body;
      receivedByNewJob.add(index);
      return { index, received: true };
    }
    if (method === "POST" && path === "/imports/preview")
      return {
        projectCount: prepared.projectCount,
        sessionCount: 0,
        conflicts: [],
        digest: "new-digest",
      };
    throw new Error("Unexpected mock request: " + method + " " + path);
  };

  const preview = await migration.upload(f.raw, f.account, request, "1");
  const rebuilt = await f.account.get("yotick/import/current");
  assert.equal(preview.digest, "new-digest");
  assert.notEqual(jobIds[0], jobIds[1]);
  assert.equal(rebuilt.id, jobIds[1]);
  assert.equal(rebuilt.chunkSourceId, prepared.id);
  assert.equal(rebuilt.status, "preview");
  assert.deepEqual(
    Array.from(receivedByNewJob).sort((a, b) => a - b),
    sourceChunks.map((_, i) => i),
  );
  assert.deepEqual(chunkBodies, sourceChunks);
});
