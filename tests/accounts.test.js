const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAdapter } = require("../storage/adapter");
const { createAccounts } = require("../sync/accounts");
const { uuid } = require("../core/ids");
const local = require("../sync/local");
const { FOCLO_API_BASE_URL } = require("../sync/environment");

test('cloud-authoritative cache refresh keeps the original view on network failure and switches atomically on success', async () => {
  const raw=createMemoryAdapter(),app={globalData:{}},ref={userId:uuid(),spaceId:uuid(),generation:'1'};
  const p={id:uuid(),name:'云端旧名称',parentId:null,archived:false,color:'#123456',shortName:'',creationOrder:1,createdAtSec:1800000000,updatedAtSec:1800000000};
  let offline=false, failSnapshot=false, firstPull=true;
  const accounts=createAccounts(raw,app,{baseUrl:'https://test.invalid/api/v1',transport:async(method,url)=>{
    if(offline)throw Object.assign(new Error('offline'),{code:'NETWORK_ERROR'});
    const route=new URL(url).pathname;
    if(route.endsWith('/sync/pull')){
      const changes=firstPull?[{entityType:'project',entityId:p.id,serverVersion:'1',deleted:false,data:p}]:[];
      firstPull=false;return{changes,cursor:'current',hasMore:false};
    }
    if(route.endsWith('/sync/snapshots')){
      if(failSnapshot)throw Object.assign(new Error('snapshot unavailable'),{code:'NETWORK_ERROR'});
      return{id:'snapshot',upperSeq:'2'};
    }
    if(route.endsWith('/sync/snapshots/snapshot'))return{
      changes:[{entityType:'project',entityId:p.id,serverVersion:'2',deleted:false,data:{...p,name:'云端新名称'}}],
      cursor:'snapshot-current',nextOffset:1,hasMore:false,
    };
    throw new Error('Unexpected route '+route);
  }});
  try{
    await accounts.init();await raw.set('yotick-global/credentials/'+ref.userId,{accessToken:'synthetic-access'});
    await accounts.activate(ref);await accounts.trigger();
    const namespace=app.globalData.adapter.namespace;
    assert.equal((await app.globalData.adapter.get('yotick/projects'))[p.id].name,'云端旧名称');
    offline=true;await assert.rejects(()=>accounts.clearCache(),/尚未连上/);
    assert.equal(app.globalData.adapter.namespace,namespace);
    assert.equal((await app.globalData.adapter.get('yotick/projects'))[p.id].name,'云端旧名称');
    offline=false;failSnapshot=true;await assert.rejects(()=>accounts.clearCache(),/重新下载尚未完成/);
    assert.equal(await app.globalData.adapter.get('yotick/fact-view'),undefined);
    assert.equal((await app.globalData.adapter.get('yotick/projects'))[p.id].name,'云端旧名称');
    failSnapshot=false;await accounts.clearCache();
    assert.equal(app.globalData.adapter.namespace,namespace);
    assert.ok(await app.globalData.adapter.get('yotick/fact-view'));
    assert.equal((await app.globalData.adapter.get('yotick/projects'))[p.id].name,'云端新名称');
    assert.equal((await app.globalData.adapter.forView(null).get('yotick/projects'))[p.id].name,'云端旧名称');
    assert.equal(accounts.getStatus().state,'synced');
  }finally{await accounts.activate(null);}
});

test('DevTools cloud switch preserves old test cache and requires fresh cloud login', async () => {
  const previousWx=global.wx;
  const raw=createMemoryAdapter(),app={globalData:{}},ref={userId:uuid(),spaceId:uuid(),generation:'1'};
  const {createAccountAdapter}=require('../storage/account-adapter');
  const old=createAccountAdapter(raw,ref.spaceId+'@1');
  await old.set('yotick/outbox/old',{operationId:'old',kind:'project.delete'});
  await raw.set('yotick-global/current',ref);
  await raw.set('yotick-global/credentials/'+ref.userId,{accessToken:'local-test'});
  global.wx={getAccountInfoSync:()=>({miniProgram:{envVersion:'develop'}}),getSystemInfoSync:()=>({platform:'devtools'})};
  let requests=0;
  const accounts=createAccounts(raw,app,{baseUrl:FOCLO_API_BASE_URL,transport:async()=>{requests++;return {};}});
  try {
    await accounts.init();
    assert.equal(accounts.getCurrent(),null);
    assert.equal(requests,0);
    assert.deepEqual(await raw.get('yotick-global/previous-local-account'),ref);
    assert.equal((await old.get('yotick/outbox/old')).kind,'project.delete');
  }finally{global.wx=previousWx;await accounts.activate(null);}
});
test("successful retry clears the old offline message and error code", async () => {
  const raw = createMemoryAdapter(), app = { globalData: {} };
  let offline = true;
  const accounts = createAccounts(raw, app, {
    baseUrl: "https://test.invalid/api/v1",
    transport: async () => {
      if (offline) throw Object.assign(new Error("previous timeout"), { code: "NETWORK_ERROR" });
      return { changes: [], cursor: "recovered", hasMore: false };
    },
  });
  await accounts.init();
  const ref = { userId: uuid(), spaceId: uuid(), generation: "1" };
  await raw.set("yotick-global/credentials/" + ref.userId, { accessToken: "test", refreshToken: "test-refresh" });
  try {
    await accounts.activate(ref);
    await accounts.trigger();
    assert.equal(accounts.getStatus().state, "offline");
    assert.equal(accounts.getStatus().message, "previous timeout");
    assert.equal(accounts.getStatus().code, "NETWORK_ERROR");
    offline = false;
    await accounts.trigger();
    assert.equal(accounts.getStatus().state, "synced");
    assert.equal(accounts.getStatus().message, "");
    assert.equal(accounts.getStatus().code, undefined);
    assert.equal(accounts.getStatus().pending, 0);
  } finally {
    await accounts.activate(null);
  }
});
test("switching accounts rejects delayed old response and preserves old outbox", async () => {
  const raw = createMemoryAdapter(),
    app = { globalData: {} },
    pending = [];
  const transport = (method, url, data) => {
    if (url.includes("/sync/pull"))
      return new Promise((resolve) => pending.push(resolve));
    return Promise.resolve({});
  };
  const accounts = createAccounts(raw, app, {
    baseUrl: "https://test.invalid/api/v1",
    transport,
  });
  await accounts.init();
  const a = { userId: uuid(), spaceId: uuid(), generation: "1" },
    b = { userId: uuid(), spaceId: uuid(), generation: "1" };
  await raw.set("yotick-global/credentials/" + a.userId, {
    accessToken: "access",
    refreshToken: "refresh",
  });
  await accounts.activate(a);
  await new Promise((r) => setTimeout(r, 10));
  const old = app.globalData.adapter;
  const p = await app.globalData.service.createProject({
    operationId: uuid(),
    name: "A待上传",
  });
  await accounts.activate(b);
  assert.equal(accounts.getCurrent().userId, b.userId);
  const id = uuid();
  pending[0]({
    changes: [
      {
        entityType: "project",
        entityId: id,
        serverVersion: "1",
        data: {
          id,
          name: "旧响应",
          parentId: null,
          archived: false,
          color: "#123456",
          creationOrder: 1,
          revision: 1,
          createdAtSec: 1,
        },
      },
    ],
    cursor: "old",
    hasMore: false,
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    (await app.globalData.adapter.get("yotick/projects")) || {},
    {},
  );
  assert.equal((await local.pending(old)).length, 1);
  assert.equal(
    (await old.get("yotick/projects"))[p.data.project.id].name,
    "A待上传",
  );
  await accounts.activate(null);
});
test("active focus and rest prevent account replacement; guest history never merges on login", async () => {
  const raw = createMemoryAdapter(),
    app = { globalData: {} },
    accounts = createAccounts(raw, app);
  await accounts.init();
  const p = await app.globalData.service.createProject({
    operationId: uuid(),
    name: "游客",
  });
  await app.globalData.service.start({
    operationId: uuid(),
    projectId: p.data.project.id,
  });
  await assert.rejects(
    () =>
      accounts.activate({ userId: uuid(), spaceId: uuid(), generation: "1" }),
    /专注/,
  );
  assert.equal(accounts.getCurrent(), null);
  const current = await app.globalData.service.getCurrent();
  await app.globalData.service.stop({
    operationId: uuid(),
    sessionId: current.data.sessionId,
  });
  await app.globalData.adapter.set("yotick/rest-break/v1", {
    status: "PAUSED",
  });
  await assert.rejects(
    () =>
      accounts.activate({ userId: uuid(), spaceId: uuid(), generation: "1" }),
    /休息/,
  );
  await app.globalData.adapter.remove("yotick/rest-break/v1");
  await accounts.activate({ userId: uuid(), spaceId: uuid(), generation: "1" });
  assert.deepEqual(
    (await app.globalData.adapter.get("yotick/projects")) || {},
    {},
  );
  await accounts.activate(null);
  assert.equal(
    Object.keys(await app.globalData.adapter.get("yotick/projects")).length,
    1,
  );
});
test("clear-cache refuses unsent operations and recovery export includes frozen queue", async () => {
  const raw = createMemoryAdapter(),
    app = { globalData: {} },
    accounts = createAccounts(raw, app);
  await accounts.init();
  await accounts.activate({ userId: uuid(), spaceId: uuid(), generation: "1" });
  await app.globalData.service.createProject({
    operationId: uuid(),
    name: "保全",
  });
  await assert.rejects(() => accounts.clearCache(), /未上传|同步|导出/);
  const backup = await accounts.exportRecovery();
  assert.equal(backup.formatVersion, 2);
  assert.equal(backup.localBackup.projects.length, 1);
  assert.ok(
    Object.keys(backup.syncRecovery).some((k) =>
      k.startsWith("yotick/outbox/"),
    ),
  );
  await accounts.activate(null);
});
test('low capacity defers namespace upgrade while preserving original offline timer',async()=>{const raw=createMemoryAdapter(),original=require('../core/service').createService(raw);await original.init();const p=await original.createProject({operationId:uuid(),name:'旧资料'});raw.capacity=async()=>({usedBytes:1000,limitBytes:1001});const app={globalData:{}},accounts=createAccounts(raw,app);await accounts.init();assert.equal(accounts.getStatus().state,'upgrade-required');assert.equal(app.globalData.adapter.namespace,'legacy');const started=await app.globalData.service.start({operationId:uuid(),projectId:p.data.project.id});assert.equal(started.ok,true);assert.equal((await raw.get('yotick/projects'))[p.data.project.id].name,'旧资料');await assert.rejects(()=>accounts.activate({userId:uuid(),spaceId:uuid(),generation:'1'}),/升级/);});
test('interrupted orphan-record recovery reuses destination IDs and never counts the source twice',async()=>{const raw=createMemoryAdapter(),app={globalData:{}},accounts=createAccounts(raw,app);await accounts.init();await accounts.activate({userId:uuid(),spaceId:uuid(),generation:'1'});const p=await app.globalData.service.createProject({operationId:uuid(),name:'旧项目'});const active=await app.globalData.service.start({operationId:uuid(),projectId:p.data.project.id});await app.globalData.service.stop({operationId:uuid(),sessionId:active.data.sessionId});const adapter=app.globalData.adapter,tasks=await local.pending(adapter),task=tasks.find(t=>t.kind==='session.createCompleted'),id=uuid();await adapter.set(local.conflictKey(id),{id,code:'ENTITY_DELETED',local:task,cloud:null,operationIds:[task.operationId]});raw.inject(k=>k.includes('/yotick/recovery/'),2,new Error('recovery crash'),'set');await assert.rejects(()=>accounts.recoverConflict(id,null,'恢复项目'));raw.clearFaults();const nextApp={globalData:{}},next=createAccounts(raw,nextApp);await next.init();const first=await next.recoverConflict(id,null,'恢复项目'),retry=await next.recoverConflict(id,null,'恢复项目');assert.deepEqual(first,retry);const backup=await nextApp.globalData.service.createBackup();assert.equal(backup.data.sessions.length,1);assert.equal(backup.data.sessions[0].id,first.sessionId);assert.equal(backup.data.sessions[0].projectId,first.projectId);assert.notEqual(first.sessionId,task.entityId);assert.ok(await nextApp.globalData.adapter.get('yotick/recovery/'+id));});
