const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAdapter } = require("../storage/adapter");
const {
  createAccountAdapter,
  FACT_VIEW_KEY,
} = require("../storage/account-adapter");
const { createService } = require("../core/service");
const { buildSnapshotView } = require("../sync/snapshot-view");
const local = require("../sync/local");
const { uuid } = require("../core/ids");

test("slow full-view staging allows local start and refuses a stale pointer switch", async () => {
  const f = await setup(),
    page = "yotick/snapshot-pages/slow/0";
  await f.adapter.set(page, [
    {
      entityType: "project",
      entityId: f.p.id,
      serverVersion: "1",
      data: { ...f.p, name: "云端视图" },
    },
  ]);
  const set = f.raw.set.bind(f.raw);
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve)),
    started = new Promise((resolve) => (entered = resolve));
  let held = false;
  f.raw.set = async (key, value) => {
    if (!held && key.includes("/@views/")) {
      held = true;
      entered();
      await gate;
    }
    return set(key, value);
  };
  const build = f.service.buildSyncView((ctx) =>
    buildSnapshotView(ctx, [page], "fresh"),
  );
  const rejected = assert.rejects(build, { code: "LOCAL_CHANGED" });
  await started;
  const timer = await f.service.start({
    operationId: uuid(),
    projectId: f.p.id,
    targetSeconds: 60,
  });
  assert.equal(timer.ok, true);
  assert.equal((await f.adapter.get("yotick/projects"))[f.p.id].name, "旧视图");
  release();
  await rejected;
  const sessionId = (await f.service.getCurrent()).data.sessionId;
  assert.ok(sessionId);
  assert.equal((await f.adapter.get(local.STATE)).cursor, "old");
  await f.service.buildSyncView((ctx) =>
    buildSnapshotView(ctx, [page], "fresh"),
  );
  assert.equal((await f.service.getCurrent()).data.sessionId, sessionId);
  assert.equal((await f.adapter.get(local.STATE)).cursor, "fresh");
});
async function setup() {
  const raw = createMemoryAdapter(),
    adapter = createAccountAdapter(raw, "snapshot-test"),
    service = createService(adapter, { clock: () => 1800000000 });
  await adapter.set(local.STATE, {
    spaceId: uuid(),
    generation: "1",
    cursor: "old",
    nextOrder: 0,
  });
  await service.init();
  const p = await service.createProject({
    operationId: uuid(),
    name: "旧视图",
  });
  const task = (await local.pending(adapter))[0];
  await adapter.remove(local.itemKey(task.operationId));
  return { raw, adapter, service, p: p.data.project };
}
test("snapshot staging and interrupted build never expose partial facts; switch is replayable", async () => {
  for (const stage of ["build", "pointer", "cursor"]) {
    const f = await setup(),
      page = "yotick/snapshot-pages/test/0",
      remote = {
        entityType: "project",
        entityId: f.p.id,
        serverVersion: "1",
        data: { ...f.p, name: "新视图" },
      };
    await f.adapter.set(page, [remote]);
    const before = await f.adapter.get("yotick/projects");
    assert.equal(before[f.p.id].name, "旧视图");
    const match =
      stage === "build"
        ? (k) => k.includes("/@views/") && k.endsWith("/yotick/projects")
        : stage === "pointer"
          ? (k) => k.endsWith("/" + FACT_VIEW_KEY)
          : (k) => k.endsWith("/" + local.STATE);
    f.raw.inject(match, 2, new Error("snapshot crash"), "set");
    try {
      await f.service.syncTransaction((ctx) =>
        buildSnapshotView(ctx, [page], "new-cursor"),
      );
    } catch (e) {}
    f.raw.clearFaults();
    const restartedAdapter = createAccountAdapter(f.raw, "snapshot-test"),
      restarted = createService(restartedAdapter, { clock: () => 1800000000 });
    assert.equal((await restarted.init()).ok, true);
    const projects = await restartedAdapter.get("yotick/projects"),
      state = await restartedAdapter.get(local.STATE);
    if (stage === "build") {
      assert.equal(projects[f.p.id].name, "旧视图");
      assert.equal(state.cursor, "old");
    } else {
      assert.equal(projects[f.p.id].name, "新视图");
      assert.equal(state.cursor, "new-cursor");
    }
    assert.equal(Object.keys(projects).length, 1);
  }
});
test("active view keys hide abandoned staging and other namespaces", async () => {
  const raw = createMemoryAdapter(),
    adapter = createAccountAdapter(raw, "a"),
    other = createAccountAdapter(raw, "b");
  await adapter.set("yotick/projects", { old: 1 });
  await other.set("yotick/projects", { other: 1 });
  const staged = adapter.forView("new");
  await staged.set("yotick/projects", { next: 1 });
  assert.deepEqual(await adapter.get("yotick/projects"), { old: 1 });
  await adapter.set(FACT_VIEW_KEY, "new");
  assert.deepEqual(await adapter.get("yotick/projects"), { next: 1 });
  assert.ok(!(await adapter.keys()).some((k) => k.startsWith("@views/")));
  assert.deepEqual(await other.get("yotick/projects"), { other: 1 });
  assert.deepEqual(
    await createAccountAdapter(raw, "a").get("yotick/projects"),
    { next: 1 },
  );
});
