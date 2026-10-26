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

async function cleanCloudFixture(options = {}) {
  const f = await fixture();
  const p = (await f.service.createProject({ operationId: uuid(), name: '批次同步项目' })).data.project;
  for (const task of await local.pending(f.adapter)) await f.adapter.remove(local.itemKey(task.operationId));
  const statuses = [];
  const worker = createWorker({ service: f.service, deviceId: uuid(), onStatus: s => statuses.push(s),
    request: async (method, route) => {
      assert.equal(method, 'GET'); assert.equal(route, '/sync/pull');
      return { changes: [], cursor: 'current', hasMore: false };
    }, ...options });
  const s = { id: uuid(), projectId: p.id, status: 'COMPLETED', startedAtSec: f.clock.now - 120,
    endedAtSec: f.clock.now - 60, durationSeconds: 60, targetSeconds: null, pauses: [],
    createdAtSec: f.clock.now - 120, updatedAtSec: f.clock.now - 60 };
  const change = { entityType: 'session', entityId: s.id, serverVersion: '1', data: s, deleted: false };
  return { ...f, p, s, change, worker, statuses };
}

test('one pull page applies create then delete without resurrecting facts or indexes', async () => {
  const f = await cleanCloudFixture();
  try {
    await f.worker.apply([f.change, { ...f.change, serverVersion: '2', deleted: true }], 'done');
    assert.equal(await f.adapter.get('yotick/s/' + f.s.id), undefined);
    assert.equal((await f.adapter.get(local.shadowKey('session', f.s.id))).deleted, true);
    for (const key of await f.adapter.keys())
      if (/^yotick\/[dp]\//.test(key)) assert.ok(!(await f.adapter.get(key)).includes(f.s.id));
    assert.equal((await f.adapter.get(local.STATE)).cursor, 'done');
  } finally { f.worker.stop(); }
});

test('staged shadow versions reject stale changes within the same pull page', async () => {
  const f = await cleanCloudFixture();
  try {
    await f.worker.apply([{ ...f.change, serverVersion: '3' }, { ...f.change, serverVersion: '2', deleted: true }], 'done');
    assert.ok(await f.adapter.get('yotick/s/' + f.s.id));
    assert.equal((await f.adapter.get(local.shadowKey('session', f.s.id))).serverVersion, '3');
  } finally { f.worker.stop(); }
});

test('new client reconciles deleted shadows even when the cursor already advanced', async () => {
  const f = await cleanCloudFixture();
  try {
    await f.worker.apply([f.change], 'already-advanced');
    await f.adapter.set(local.shadowKey('session', f.s.id), { ...f.change, serverVersion: '2', deleted: true });
    await f.worker.trigger();
    assert.equal(await f.adapter.get('yotick/s/' + f.s.id), undefined);
    assert.equal(f.statuses.at(-1).state, 'synced');
  } finally { f.worker.stop(); }
});

test('deleted-shadow repair preserves an unsent edit as a conflict instead of discarding it', async () => {
  const f = await cleanCloudFixture();
  try {
    await f.worker.apply([f.change], 'already-advanced');
    const operationId = uuid();
    await f.adapter.set(local.itemKey(operationId), { operationId, kind: 'session.reduceDuration',
      entityId: f.s.id, related: [], payload: { ...f.s, durationSeconds: 30 }, localOrder: 1, status: 'pending' });
    await f.adapter.set(local.shadowKey('session', f.s.id), { ...f.change, serverVersion: '2', deleted: true });
    await f.worker.trigger();
    assert.ok(await f.adapter.get('yotick/s/' + f.s.id));
    assert.equal((await f.adapter.get(local.itemKey(operationId))).status, 'conflict');
    assert.equal(f.statuses.at(-1).state, 'conflict');
    const conflicts = (await f.adapter.keys()).filter(k => k.startsWith('yotick/conflicts/'));
    assert.equal(conflicts.length, 1);
    assert.equal((await f.adapter.get(conflicts[0])).code, 'ENTITY_DELETED');
  } finally { f.worker.stop(); }
});

test('foreground polling receives other-device changes, suspends in background, and resumes immediately', async () => {
  let pulls = 0;
  const f = await cleanCloudFixture({ pollIntervalMs: 10, request: async () => {
    pulls++; return { changes: [], cursor: 'latest', hasMore: false };
  } });
  try {
    await f.worker.trigger();
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.ok(pulls >= 4);
    f.worker.suspend(); const paused = pulls;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(pulls, paused);
    await f.worker.resume(); assert.ok(pulls > paused);
  } finally { f.worker.stop(); }
});

test('a late failure from an old account does not overwrite the new account status', async () => {
  let reject, current = true;
  const delayed = new Promise((_, no) => { reject = no; });
  const statuses = [];
  const f = await cleanCloudFixture({ isCurrent: () => current, onStatus: s => statuses.push(s), request: () => delayed });
  try {
    const running = f.worker.trigger();
    await new Promise(resolve => setTimeout(resolve, 0));
    current = false; reject(Object.assign(new Error('old request failed'), { code: 'NETWORK_ERROR' }));
    await running;
    assert.deepEqual(statuses.map(s => s.state), ['syncing']);
  } finally { f.worker.stop(); }
});

test('two devices converge on identical facts and an offline device applies a remote deletion on reconnect', async () => {
  const a = await cleanCloudFixture(), b = await cleanCloudFixture();
  try {
    const project = { ...a.p, name: '共享云端项目' };
    const changes = [{ entityType: 'project', entityId: project.id, serverVersion: '1', deleted: false, data: project }, a.change];
    await a.worker.apply(changes, '1'); await b.worker.apply(changes, '1');
    assert.deepEqual(local.sessionPayload(await a.adapter.get('yotick/s/' + a.s.id)), local.sessionPayload(await b.adapter.get('yotick/s/' + a.s.id)));
    const deleted = { ...a.change, serverVersion: '2', deleted: true };
    await a.worker.apply([deleted], '2');
    assert.ok(await b.adapter.get('yotick/s/' + a.s.id), 'offline cache retains its old view until reconnect');
    await b.worker.apply([deleted], '2');
    assert.equal(await a.adapter.get('yotick/s/' + a.s.id), undefined);
    assert.equal(await b.adapter.get('yotick/s/' + a.s.id), undefined);
    assert.deepEqual(await a.adapter.get(local.shadowKey('session', a.s.id)), await b.adapter.get(local.shadowKey('session', a.s.id)));
  } finally { a.worker.stop(); b.worker.stop(); }
});
test("frozen rejected uploads refresh conflict cloud versions without losing proposals or a saved resolution", async () => {
  const f = await fixture();
  const p = await f.service.createProject({ operationId: uuid(), name: "本地提议" });
  const id = p.data.project.id, task = (await local.pending(f.adapter))[0];
  await f.adapter.set(local.itemKey(task.operationId), { ...task, status: "conflict", frozen: { operationId: task.operationId } });
  const old = { entityType: "project", entityId: id, serverVersion: "1", data: { ...p.data.project, name: "旧云端" } };
  const conflictId = uuid(), resolvingId = uuid();
  const conflict = { id: conflictId, code: "VERSION_CONFLICT", cloud: old, local: task, operationIds: [task.operationId] };
  await f.adapter.set(local.conflictKey(conflictId), conflict);
  await f.adapter.set(local.conflictKey(resolvingId), { ...conflict, id: resolvingId, resolving: "cloud", resolutionChanges: [old] });
  await f.adapter.set(local.shadowKey("project", id), old);
  const worker = createWorker({ service: f.service, request: async () => {}, deviceId: uuid() });
  const fresh = { ...old, serverVersion: "2", data: { ...old.data, name: "最新云端" } };
  await worker.apply([fresh], "cursor2");
  const updated = await f.adapter.get(local.conflictKey(conflictId));
  assert.equal(updated.cloud.data.name, "最新云端");
  assert.deepEqual(updated.local, task);
  assert.deepEqual(updated.cloudAtConflict, old);
  assert.equal((await f.adapter.get("yotick/projects"))[id].name, "本地提议");
  assert.equal((await f.adapter.get(local.conflictKey(resolvingId))).cloud.data.name, "旧云端");
  // Repair a stale conflict left by an older client whose cursor already advanced.
  await f.adapter.set(local.conflictKey(conflictId), conflict);
  await worker.apply([], "cursor2");
  assert.equal((await f.adapter.get(local.conflictKey(conflictId))).cloud.serverVersion, "2");
  await worker.apply([{ ...fresh, serverVersion: "3", deleted: true }], "cursor3");
  const deletedConflict = await f.adapter.get(local.conflictKey(conflictId));
  assert.equal(deletedConflict.code, "ENTITY_DELETED");
  assert.equal(deletedConflict.cloud.deleted, true);
  assert.deepEqual(deletedConflict.local, task);
  assert.deepEqual(deletedConflict.cloudAtConflict, old);
  assert.equal((await f.adapter.get(local.conflictKey(resolvingId))).cloud.data.name, "旧云端");
  worker.stop();
});
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
test("slow network never blocks start, pause, resume, or stop; completion queues once", async () => {
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
  const within = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("local command waited network")),
            500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const start = await within(
    f.service.start({ operationId: uuid(), projectId: p.data.project.id }),
  );
  assert.equal(start.ok, true);
  f.clock.now += 10;
  const pause = await within(
    f.service.pause({ operationId: uuid(), sessionId: start.data.sessionId }),
  );
  assert.equal(pause.ok, true);
  f.clock.now += 20;
  const resume = await within(
    f.service.resume({ operationId: uuid(), sessionId: start.data.sessionId }),
  );
  assert.equal(resume.ok, true);
  f.clock.now += 5;
  const stop = await within(
    f.service.stop({ operationId: uuid(), sessionId: start.data.sessionId }),
  );
  assert.equal(stop.ok, true);
  const completed = (await local.pending(f.adapter)).filter(
    (task) => task.kind === "session.createCompleted",
  );
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.durationSeconds, 15);
  assert.equal(completed[0].payload.pauses[0].durationSeconds, 20);
  worker.stop();
  resolve({ changes: [], hasMore: false, cursor: "cursor" });
  await sync;
  assert.equal(
    (await local.pending(f.adapter)).filter(
      (task) => task.kind === "session.createCompleted",
    ).length,
    1,
  );
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
