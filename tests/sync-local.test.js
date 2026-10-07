const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAdapter } = require("../storage/adapter");
const { createAccountAdapter } = require("../storage/account-adapter");
const { createService } = require("../core/service");
const { uuid } = require("../core/ids");
const local = require("../sync/local");
const { createWorker } = require("../sync/worker");
async function fixture() {
  const raw = createMemoryAdapter(),
    adapter = createAccountAdapter(raw, "account"),
    clock = { now: 1800000000 };
  await adapter.set(local.STATE, {
    spaceId: uuid(),
    userId: uuid(),
    generation: "1",
    nextOrder: 0,
  });
  const service = createService(adapter, { clock: () => clock.now });
  assert.equal((await service.init()).ok, true);
  return { raw, adapter, clock, service };
}
test("timer commands and automatic settlement remain offline; only completion queues session", async () => {
  const f = await fixture(),
    p = await f.service.createProject({ operationId: uuid(), name: "数学" });
  assert.equal(p.ok, true);
  const id = p.data.project.id;
  await f.service.start({
    operationId: uuid(),
    projectId: id,
    targetSeconds: 60,
  });
  f.clock.now += 10;
  const current = await f.service.getCurrent();
  await f.service.pause({
    operationId: uuid(),
    sessionId: current.data.sessionId,
  });
  f.clock.now += 20;
  await f.service.resume({
    operationId: uuid(),
    sessionId: current.data.sessionId,
  });
  let tasks = await local.pending(f.adapter);
  assert.equal(
    tasks.filter((t) => t.kind === "session.createCompleted").length,
    0,
  );
  f.clock.now += 60;
  await f.service.getCurrent();
  await f.service.getStatistics({ preset: "today" });
  tasks = await local.pending(f.adapter);
  const completed = tasks.filter((t) => t.kind === "session.createCompleted");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.durationSeconds, 60);
  assert.equal(completed[0].payload.pauses[0].durationSeconds, 20);
  const restarted = createService(f.adapter, { clock: () => f.clock.now });
  await restarted.init();
  assert.equal(
    (await local.pending(f.adapter)).filter(
      (t) => t.kind === "session.createCompleted",
    ).length,
    1,
  );
});
test("fact/outbox failure recovers together; descriptor failure leaves neither", async () => {
  for (const stage of ["descriptor", "fact", "outbox", "cleanup"]) {
    const f = await fixture();
    const match =
      stage === "descriptor"
        ? (k) => k.includes("/yotick/c/")
        : stage === "fact"
          ? (k) => k.endsWith("/yotick/projects")
          : stage === "outbox"
            ? (k) => k.includes("/yotick/outbox/")
            : (k) => k.includes("/yotick/c/");
    f.raw.inject(
      match,
      1,
      new Error(stage),
      stage === "cleanup" ? "remove" : "set",
    );
    const result = await f.service.createProject({
      operationId: uuid(),
      name: "物理",
    });
    const restarted = createService(f.adapter, { clock: () => f.clock.now });
    assert.equal((await restarted.init()).ok, true);
    const projects = (await f.adapter.get("yotick/projects")) || {},
      tasks = await local.pending(f.adapter);
    if (stage === "descriptor") {
      assert.equal(result.ok, false);
      assert.equal(Object.keys(projects).length, 0);
      assert.equal(tasks.length, 0);
    } else {
      assert.equal(Object.keys(projects).length, 1);
      assert.equal(tasks.length, 1);
    }
  }
});
test("device preferences excluded; consecutive offline changes retain order and dependencies", async () => {
  const f = await fixture(),
    p = await f.service.createProject({ operationId: uuid(), name: "英语" }),
    id = p.data.project.id;
  await f.service.renameProject({
    operationId: uuid(),
    projectId: id,
    name: "阅读",
  });
  await f.service.setProjectAppearance({
    operationId: uuid(),
    projectId: id,
    color: "#123456",
    shortName: "阅",
  });
  await f.service.savePrefs({
    theme: "dark",
    lastProjectId: id,
    defaultMinutes: 45,
    startupMode: "remember",
  });
  const tasks = await local.pending(f.adapter);
  assert.deepEqual(
    tasks.map((t) => t.kind),
    ["project.create", "project.patch", "project.patch", "prefs.patch"],
  );
  assert.equal(tasks[1].dependsOn, tasks[0].operationId);
  assert.deepEqual(tasks[3].payload, {
    defaultMinutes: 45,
    startupMode: "remember",
  });
});
test("slow network never blocks a local timer command; frozen upload survives lost response", async () => {
  const f = await fixture(),
    p = await f.service.createProject({ operationId: uuid(), name: "音乐" });
  let resolve;
  const network = new Promise((r) => (resolve = r));
  const worker = createWorker({
    service: f.service,
    deviceId: uuid(),
    request: async () => network,
  });
  const sync = worker.trigger();
  const start = await Promise.race([
    f.service.start({ operationId: uuid(), projectId: p.data.project.id }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("local command waited network")), 500),
    ),
  ]);
  assert.equal(start.ok, true);
  worker.stop();
  resolve({ changes: [], hasMore: false, cursor: "cursor" });
  await sync;
  assert.equal((await local.pending(f.adapter)).length, 1);
});
test("pull preserves dirty local project and commits conflict with cursor", async () => {
  const f = await fixture(),
    p = await f.service.createProject({ operationId: uuid(), name: "历史" }),
    id = p.data.project.id;
  const worker = createWorker({
    service: f.service,
    deviceId: uuid(),
    request: async () => {},
  });
  await worker.apply(
    [
      {
        entityType: "project",
        entityId: id,
        serverVersion: "2",
        data: { ...p.data.project, name: "云端历史" },
        deleted: false,
      },
    ],
    "signed-cursor",
  );
  assert.equal((await f.adapter.get("yotick/projects"))[id].name, "历史");
  assert.equal((await f.adapter.get(local.STATE)).cursor, "signed-cursor");
  assert.equal((await local.pending(f.adapter))[0].status, "conflict");
  worker.stop();
});
test("acknowledgement and cursor faults survive forced restart without false confirmation", async () => {
  for (const stage of ["descriptor", "shadow", "cursor", "ack-remove"]) {
    const f = await fixture(),
      created = await f.service.createProject({
        operationId: uuid(),
        name: "故障确认",
      }),
      task = (await local.pending(f.adapter))[0],
      change = {
        entityType: "project",
        entityId: task.entityId,
        serverVersion: "1",
        data: created.data.project,
      },
      ack = {
        operationId: task.operationId,
        status: "applied",
        changes: [change],
      };
    const match =
      stage === "descriptor"
        ? (k) => k.includes("/yotick/c/")
        : stage === "shadow"
          ? (k) => k.includes("/yotick/shadow/")
          : stage === "cursor"
            ? (k) => k.endsWith("/yotick/sync/state")
            : (k) => k.includes("/yotick/outbox/");
    f.raw.inject(
      match,
      2,
      new Error("crash"),
      stage === "ack-remove" ? "remove" : "set",
    );
    const worker = createWorker({
      service: f.service,
      request: async () => {},
      deviceId: uuid(),
    });
    try {
      await worker.apply([change], "next-cursor", [ack]);
    } catch (e) {}
    worker.stop();
    f.raw.clearFaults();
    const restarted = createService(f.adapter, { clock: () => f.clock.now });
    assert.equal((await restarted.init()).ok, true);
    if (stage === "descriptor") {
      assert.equal((await local.pending(f.adapter)).length, 1);
      assert.equal((await f.adapter.get(local.STATE)).cursor, undefined);
    } else {
      assert.equal((await local.pending(f.adapter)).length, 0);
      assert.equal((await f.adapter.get(local.STATE)).cursor, "next-cursor");
      assert.equal(
        (await f.adapter.get(local.receiptKey(task.operationId))).status,
        "applied",
      );
    }
  }
});
test("remote project deletion preserves ACTIVE context and queues completed record for recovery", async () => {
  const f = await fixture(),
    created = await f.service.createProject({
      operationId: uuid(),
      name: "被删项目",
    }),
    task = (await local.pending(f.adapter))[0],
    p = created.data.project,
    worker = createWorker({
      service: f.service,
      request: async () => {},
      deviceId: uuid(),
    });
  await worker.apply(
    [{ entityType: "project", entityId: p.id, serverVersion: "1", data: p }],
    null,
    [
      {
        operationId: task.operationId,
        status: "applied",
        changes: [
          {
            entityType: "project",
            entityId: p.id,
            serverVersion: "1",
            data: p,
          },
        ],
      },
    ],
  );
  await f.service.start({ operationId: uuid(), projectId: p.id });
  await worker.apply(
    [
      {
        entityType: "project",
        entityId: p.id,
        serverVersion: "2",
        data: p,
        deleted: true,
      },
    ],
    "deleted-cursor",
  );
  f.clock.now += 20;
  const current = await f.service.getCurrent();
  assert.ok(current.data.sessionId);
  const stopped = await f.service.stop({
    operationId: uuid(),
    sessionId: current.data.sessionId,
  });
  assert.equal(stopped.ok, true);
  assert.equal(
    (await local.pending(f.adapter)).filter(
      (t) => t.kind === "session.createCompleted",
    ).length,
    1,
  );
  assert.equal(
    (await f.service.start({ operationId: uuid(), projectId: p.id })).error
      .code,
    "ENTITY_DELETED",
  );
  worker.stop();
});
test('generation mismatch quarantines all old operations without deleting timer facts',async()=>{const f=await fixture(),p=await f.service.createProject({operationId:uuid(),name:'旧代次'});const worker=createWorker({service:f.service,deviceId:uuid(),request:async()=>{throw Object.assign(new Error('generation mismatch'),{code:'GENERATION_MISMATCH'});}});await worker.trigger();assert.equal((await f.adapter.get(local.STATE)).quarantined,true);assert.equal((await local.pending(f.adapter)).length,1);assert.ok((await f.adapter.get('yotick/projects'))[p.data.project.id]);worker.stop();});
test('expired cursor restores lower server versions and preserves dirty missing entities',async()=>{const f=await fixture(),a=await f.service.createProject({operationId:uuid(),name:'恢复A'}),b=await f.service.createProject({operationId:uuid(),name:'恢复B'});const tasks=await local.pending(f.adapter),worker=createWorker({service:f.service,deviceId:uuid(),request:async(method,path,data)=>{if(path==='/sync/pull'){if(data.cursor==='expired')throw Object.assign(new Error('expired'),{code:'CURSOR_EXPIRED'});return {changes:[],cursor:'fresh',hasMore:false};}if(path==='/sync/snapshots')return {id:'snapshot'};if(path==='/sync/snapshots/snapshot')return {changes:[{entityType:'project',entityId:a.data.project.id,serverVersion:'1',data:{...a.data.project,name:'恢复点A'}}],cursor:'fresh',hasMore:false,nextOffset:1};throw new Error('Unexpected upload');}});const changes=[a,b].map(e=>({entityType:'project',entityId:e.data.project.id,serverVersion:'3',data:e.data.project}));await worker.apply(changes,'expired',tasks.map((t,i)=>({operationId:t.operationId,status:'applied',changes:[changes[i]]})));await f.service.renameProject({operationId:uuid(),projectId:b.data.project.id,name:'未上传B'});await worker.trigger();const projects=await f.adapter.get('yotick/projects');assert.equal(projects[a.data.project.id].name,'恢复点A');assert.equal(projects[b.data.project.id].name,'未上传B');assert.equal((await f.adapter.get(local.shadowKey('project',a.data.project.id))).serverVersion,'1');assert.equal((await local.pending(f.adapter))[0].status,'conflict');assert.equal((await f.adapter.get(local.STATE)).cursor,'fresh');worker.stop();});
