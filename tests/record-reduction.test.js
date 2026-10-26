const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../core/service');
const { createMemoryAdapter } = require('../storage/adapter');
const { uuid } = require('../core/ids');
const local = require('../sync/local');
const { createWorker } = require('../sync/worker');
const { reductionPreview, managementRows } = require('../utils/record-management');

async function fixture(start = Date.parse('2026-10-21T10:00:00+08:00') / 1000, sync = false) {
  const adapter = createMemoryAdapter(), clock = { now: start };
  if (sync) await adapter.set(local.STATE, { generation: '1', nextOrder: 0 });
  const service = createService(adapter, { clock: () => clock.now });
  assert.equal((await service.init()).ok, true);
  const project = (await service.createProject({ operationId: uuid(), name: '记录调整' })).data.project;
  const started = await service.start({ operationId: uuid(), projectId: project.id });
  const id = started.data.sessionId;
  const input = () => ({ operationId: uuid(), sessionId: id });
  const reduce = (durationSeconds, extra = {}) => service.reduceSessionDuration({ ...input(), durationSeconds, ...extra });
  return { adapter, clock, service, project, id, input, reduce };
}

test('reducing a completed record updates statistics, facts and restart without creating another record', async () => {
  const f = await fixture(); f.clock.now += 1800; await f.service.stop(f.input());
  const before = await f.adapter.get('yotick/s/' + f.id);
  assert.equal((await f.reduce(1201)).ok, true);
  const fact = await f.adapter.get('yotick/s/' + f.id);
  assert.equal(fact.startedAtSec, before.startedAtSec);
  assert.equal(fact.endedAtSec, before.startedAtSec + 1201);
  assert.equal(fact.durationSeconds, 1201);
  assert.equal(fact.revision, before.revision + 1);
  assert.equal((await f.service.getStatistics({preset:'today'})).data.totalSeconds, 1201);
  const reboot = createService(f.adapter, {clock:()=>f.clock.now}); await reboot.init();
  const rows = (await reboot.getRecords()).data.rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].sessionId, f.id); assert.equal(rows[0].seconds, 1201);
});

test('midnight reductions retain early study and pauses, then remove obsolete daily indexes', async () => {
  const f = await fixture(Date.parse('2026-10-21T23:58:00+08:00') / 1000);
  f.clock.now += 60; await f.service.pause(f.input());
  f.clock.now += 120; await f.service.resume(f.input());
  f.clock.now += 120; await f.service.stop(f.input());
  assert.equal((await f.reduce(90)).ok, true);
  const fact = await f.adapter.get('yotick/s/' + f.id);
  assert.equal(fact.pauses.length, 1); assert.equal(fact.pauses[0].durationSeconds, 120);
  assert.equal((await f.service.getStatistics({startDate:'2026-10-21',endDate:'2026-10-21'})).data.totalSeconds, 60);
  assert.equal((await f.service.getStatistics({startDate:'2026-10-22',endDate:'2026-10-22'})).data.totalSeconds, 30);
  assert.equal((await f.reduce(60)).ok, true);
  assert.equal((await f.adapter.get('yotick/s/' + f.id)).pauses.length, 0);
  assert.equal(await f.adapter.get('yotick/d/2026-10-22'), undefined);
  assert.equal((await f.service.getRecords({date:'2026-10-22'})).data.rows.length, 0);
});

test('increases, equal amounts, invalid values and active records cannot be submitted', async () => {
  const f = await fixture();
  assert.equal((await f.reduce(0)).error.code, 'SESSION_IN_PROGRESS');
  f.clock.now += 120; await f.service.stop(f.input());
  const before = await f.adapter.get('yotick/s/' + f.id);
  for (const value of [121,120,-1,1.5,'60',true,NaN,Infinity]) {
    assert.equal((await f.reduce(value)).ok, false, String(value));
    assert.deepEqual(await f.adapter.get('yotick/s/' + f.id), before);
  }
  assert.equal((await f.reduce(0)).ok, true);
  assert.equal((await f.service.getRecords({includeZeroCompleted:true})).data.rows.length, 1);
  assert.equal((await f.service.getStatistics({preset:'today'})).data.totalSeconds, 0);
  assert.equal((await f.reduce(1)).ok, false);
});

test('stale dialogs and retired accounts cannot change records; another active timer is preserved', async () => {
  const f = await fixture(); f.clock.now += 120; await f.service.stop(f.input());
  const revision = f.service.peekCurrent().dataRevision;
  const active = await f.service.start({operationId:uuid(),projectId:f.project.id});
  assert.equal((await f.reduce(60,{expectedDataRevision:revision})).error.code, 'STALE_COMMAND');
  assert.equal((await f.reduce(60)).ok, true);
  assert.equal(f.service.peekCurrent().data.sessionId, active.data.sessionId);
  f.service.retire(); assert.equal((await f.reduce(30)).error.code, 'SPACE_CHANGED');
  assert.equal((await f.adapter.get('yotick/s/' + f.id)).durationSeconds, 60);
});

test('retries and interrupted commits cannot deduct twice or drop the durable sync operation', async () => {
  const f = await fixture(undefined,true); f.clock.now += 180; await f.service.stop(f.input());
  const operationId = uuid();
  f.adapter.inject(key=>key.startsWith('yotick/c/'),1,new Error('descriptor failed'),'set');
  assert.equal((await f.reduce(120,{operationId})).error.code, 'STORAGE_WRITE_FAILED');
  assert.equal((await f.adapter.get('yotick/s/'+f.id)).durationSeconds,180);
  f.adapter.inject(key=>key==='yotick/s/'+f.id,1,new Error('fact failed'),'set');
  assert.equal((await f.reduce(120,{operationId})).ok,true);
  assert.equal((await f.reduce(120,{operationId})).ok,true);
  const tasks=await local.pending(f.adapter), changes=tasks.filter(t=>t.kind==='session.reduceDuration');
  assert.equal(changes.length,1);assert.equal(changes[0].payload.durationSeconds,120);
  assert.equal(changes[0].dependencies['session/'+f.id],tasks.find(t=>t.kind==='session.createCompleted').operationId);
  assert.equal((await f.adapter.get('yotick/s/'+f.id)).durationSeconds,120);
});

test('recovered command results preserve a separately running timer and are idempotent after restart', async () => {
  const f=await fixture();f.clock.now+=180;await f.service.stop(f.input());
  const operationId=uuid();await f.reduce(100,{operationId});
  const fact=await f.adapter.get('yotick/s/'+f.id);
  const active=await f.service.start({operationId:uuid(),projectId:f.project.id});
  await f.adapter.set('yotick/c/'+operationId,{operationId,ops:[{t:'set',k:'yotick/s/'+f.id,v:fact}]});
  const reboot=createService(f.adapter,{clock:()=>f.clock.now});await reboot.init();
  const result=await reboot.reduceSessionDuration({operationId,sessionId:f.id,durationSeconds:100});
  assert.equal(result.ok,true);assert.equal(result.data.recovered,true);assert.equal(result.data.durationSeconds,100);
  assert.equal(reboot.peekCurrent().data.sessionId,active.data.sessionId);
});

test('remote reduction removes old-day indexes and refreshes actual statistics', async () => {
  const f=await fixture(Date.parse('2026-10-21T23:59:00+08:00')/1000);
  f.clock.now+=180;await f.service.stop(f.input());
  await f.adapter.set(local.STATE,{generation:'1',nextOrder:0});
  const fact=await f.adapter.get('yotick/s/'+f.id);
  const shortened=require('../core/session-reduction').reduceSession(fact,30);
  const worker=createWorker({service:f.service});
  await worker.apply([{entityType:'session',entityId:f.id,serverVersion:'2',data:shortened}],'cursor');
  assert.deepEqual(await f.adapter.get('yotick/d/2026-10-22'),[]);
  assert.equal((await f.service.getStatistics({startDate:'2026-10-22',endDate:'2026-10-22'})).data.totalSeconds,0);
  assert.equal((await f.service.getStatistics({startDate:'2026-10-21',endDate:'2026-10-21'})).data.totalSeconds,30);
  worker.stop();
});

test('reduction inputs support seconds, reject invalid values and hide the option for zero/active records', () => {
  assert.equal(reductionPreview(120,'1','30').remainingText,'30秒');
  assert.equal(reductionPreview(3601,'0','1').remainingText,'1小时');
  assert.equal(reductionPreview(30,'0','30').remainingText,'0秒');
  for(const [m,s] of [['',''],['-1','0'],['0','60'],['0','0'],['1','0'],['1.5','0']])
    assert.equal(reductionPreview(30,m,s).valid,false);
  const base={id:'s',projectName:'数学',startTime:1800000000000,endTime:1800000030000,status:'COMPLETED',durationSec:30};
  assert.equal(managementRows([base])[0].canReduce,false);
  assert.equal(managementRows([{...base,durationSec:60}])[0].canReduce,true);
  assert.equal(managementRows([{...base,durationSec:0}])[0].canReduce,false);
  assert.equal(managementRows([{...base,status:'ACTIVE'}])[0].canReduce,false);
});

function component(file) {
  let definition;
  global.Component = value => { definition = value; };
  delete require.cache[require.resolve(file)]; require(file);
  const properties = {};
  for (const [name, spec] of Object.entries(definition.properties || {})) properties[name] = spec.value;
  const instance = { ...definition.methods, properties, data: structuredClone(definition.data), events: [],
    setData(patch) { Object.assign(this.data, patch); },
    triggerEvent(name, detail) { this.events.push({ name, detail }); } };
  return { definition, instance };
}

test('record menu keeps deletion and offers reduction only for completed positive durations', () => {
  try {
    const {instance}=component('../components/study-timeline/index');
    let sheet;global.wx={showActionSheet:options=>{sheet=options;}};
    instance.data.managementRows=[{id:'done',canDelete:true,canReduce:true},{id:'zero',canDelete:true,canReduce:false},{id:'active',canDelete:false}];
    instance.onRecordMenu({currentTarget:{dataset:{id:'done'}}});
    assert.deepEqual(sheet.itemList,['调整专注时长','删除这条记录']);
    sheet.success({tapIndex:0});sheet.success({tapIndex:1});
    assert.deepEqual(instance.events.map(e=>e.name),['reducerecord','deleterecord']);
    instance.onRecordMenu({currentTarget:{dataset:{id:'zero'}}});assert.deepEqual(sheet.itemList,['删除这条记录']);
    sheet=null;instance.onRecordMenu({currentTarget:{dataset:{id:'active'}}});assert.equal(sheet,null);
  } finally {delete global.Component;delete global.wx;}
});

test('the daily management flow prevents duplicate saves and refreshes parent statistics after a reduction', async () => {
  const f=await fixture();f.clock.now+=180;await f.service.stop(f.input());
  try {
    global.getApp=()=>({globalData:{service:f.service,readyPromise:Promise.resolve()}});
    global.wx={showToast(){},showModal(){}};
    const {instance}=component('../components/day-detail/day-detail');
    Object.assign(instance.properties,{date:'2026-10-21',mode:'realtime',scope:'',summary:false,distribution:false});
    instance.attachedFlag=true;await instance.load(true);
    instance.openRecordReduction({detail:{sessionId:f.id}});
    assert.equal(instance.data.reductionOpen,true);
    const save=f.service.reduceSessionDuration.bind(f.service);let writes=0,release;
    const gate=new Promise(resolve=>{release=resolve;});
    f.service.reduceSessionDuration=async input=>{writes++;await gate;return save(input);};
    const first=instance.confirmRecordReduction({detail:{durationSeconds:120}});
    await instance.confirmRecordReduction({detail:{durationSeconds:120}});
    instance.closeRecordReduction();assert.equal(instance.data.reductionOpen,true);
    assert.equal(writes,1);release();await first;
    assert.equal(instance.data.reductionOpen,false);assert.equal(instance.data.recordReducing,false);
    assert.equal(instance.data.timelineRecords[0].durationSec,120);
    assert.equal(instance.events.filter(e=>e.name==='recordchanged').length,1);
    assert.equal(instance.events.filter(e=>e.name==='recorddeleted').length,0);
  } finally {delete global.Component;delete global.wx;delete global.getApp;}
});



test('hour/minute wheels choose the final duration and submit that value directly', () => {
 try {
  global.wx={getWindowInfo:()=>({windowHeight:844})};
  const {definition,instance}=component('../components/record-reduction/record-reduction');
  Object.assign(instance.properties,{opened:true,durationSeconds:3194});definition.observers['opened, durationSeconds'].call(instance,true,3194);
  assert.equal(instance.data.valid,true);assert.deepEqual(instance.data.wheelValue,[0,53]);
  assert.equal(instance.data.hourOptions.length,1);assert.equal(instance.data.minuteOptions.length,54);
  assert.equal(instance.data.remainingText,'53分钟');
  instance.pick({detail:{value:[0,48]}});assert.equal(instance.data.remainingText,'48分钟');
  instance.confirm();assert.deepEqual(instance.events,[{name:'confirm',detail:{durationSeconds:48*60}}]);
 } finally {delete global.Component;delete global.wx;}
});

test('changing hours clamps the minute wheel to the record limit', () => {
 try {
  global.wx={getWindowInfo:()=>({windowHeight:844})};
  const {definition,instance}=component('../components/record-reduction/record-reduction');
  Object.assign(instance.properties,{opened:true,durationSeconds:2*3600+17*60+20});
  definition.observers['opened, durationSeconds'].call(instance,true,instance.properties.durationSeconds);
  assert.deepEqual(instance.data.wheelValue,[2,17]);
  instance.pick({detail:{value:[1,59]}});assert.equal(instance.data.minuteOptions.length,60);
  instance.pick({detail:{value:[2,59]}});assert.deepEqual(instance.data.wheelValue,[2,17]);
  assert.equal(instance.data.minuteOptions.length,18);assert.equal(instance.data.remainingText,'2小时17分钟');
  instance.pick({detail:{value:[1,17]}});assert.equal(instance.data.minuteOptions.length,60);
  const before=structuredClone(instance.data);instance.pick({detail:{value:[3,0]}});instance.pick({detail:{value:[1,60]}});instance.pick({detail:{value:[1,-1]}});
  assert.deepEqual(instance.data,before);
 } finally {delete global.Component;delete global.wx;}
});

test('wheel motion and saving block submission; records below one minute cannot be reduced', () => {
 try {
  global.wx={getWindowInfo:()=>({windowHeight:844})};
  const {definition,instance}=component('../components/record-reduction/record-reduction');
  Object.assign(instance.properties,{opened:true,durationSeconds:60});definition.observers['opened, durationSeconds'].call(instance,true,60);
  instance.pickStart();instance.pick({detail:{value:[0,1]}});instance.confirm();assert.equal(instance.events.length,0);
  instance.pickEnd();instance.confirm();assert.equal(instance.events[0].detail.durationSeconds,0);
  instance.properties.busy=true;const before=structuredClone(instance.data);
  instance.pick({detail:{value:[0,0]}});instance.close();instance.confirm();assert.deepEqual(instance.data,before);assert.equal(instance.events.length,1);
  instance.properties.busy=false;instance.properties.durationSeconds=30;definition.observers['opened, durationSeconds'].call(instance,true,30);
  assert.deepEqual(instance.data.minuteOptions,[0]);instance.pick({detail:{value:[0,1]}});instance.confirm();assert.equal(instance.events.length,1);
 } finally {delete global.Component;delete global.wx;}
});

test('late panel measurements cannot overwrite the newest layout or a reopened record', () => {
 try {
  const ticks=[],callbacks=[];global.wx={getWindowInfo:()=>({windowHeight:844}),nextTick:fn=>ticks.push(fn)};
  const {definition,instance}=component('../components/record-reduction/record-reduction');
  instance.createSelectorQuery=()=>({select(){return this;},boundingClientRect(fn){callbacks.push(fn);return this;},exec(){}});
  Object.assign(instance.properties,{opened:true,durationSeconds:300});definition.observers['opened, durationSeconds'].call(instance,true,300);ticks.shift()();
  instance.measureBody();ticks.shift()();callbacks[0]({height:500});assert.equal(instance.bodyContentHeight,0);
  callbacks[1]({height:210});assert.equal(instance.data.bodyHeight,210);
  instance.measureBody();ticks.shift()();definition.observers['opened, durationSeconds'].call(instance,true,600);
  callbacks[2]({height:500});assert.equal(instance.bodyContentHeight,0);
 } finally {delete global.Component;delete global.wx;}
});
