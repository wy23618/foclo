const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryAdapter } = require('../storage/adapter');
const { createAccountAdapter } = require('../storage/account-adapter');
const { pendingGuest } = require('../sync/guest-pending');
const session = (id, projectId='p') => ({ id, projectId, status:'COMPLETED', startedAtSec:10, endedAtSec:30, durationSeconds:20, pauses:[] });
async function setup() {
  const raw=createMemoryAdapter(), guest=createAccountAdapter(raw,'guest'), account=createMemoryAdapter();
  await guest.set('yotick/projects',{p:{id:'p',name:'数学',parentId:null}});
  await account.set('yotick/projects',{p:{id:'p',name:'数学',parentId:null}});
  return {raw,guest,account};
}
test('already saved and deleted guest records produce no save prompt',async()=>{
  const {raw,guest,account}=await setup();
  for(const id of ['saved','deleted']) {
    await guest.set('yotick/s/'+id,session(id));
    await account.set('yotick/shadow/session/'+id,{entityId:id,deleted:id==='deleted',data:session(id)});
  }
  assert.deepEqual(await pendingGuest(raw,account),{projectCount:0,sessionCount:0,hasData:false});
  await guest.set('yotick/s/new',{...session('new'),startedAtSec:40,endedAtSec:60});
  assert.deepEqual(await pendingGuest(raw,account),{projectCount:0,sessionCount:1,hasData:true});
});
test('same facts with other IDs and deleted project subtrees are excluded',async()=>{
  const {raw,guest,account}=await setup();
  await guest.set('yotick/s/source',session('source'));
  await account.set('yotick/shadow/session/other',{entityId:'other',deleted:true,data:session('other')});
  assert.equal((await pendingGuest(raw,account)).hasData,false);
  await guest.set('yotick/projects',{p:{id:'p',name:'数学'},child:{id:'child',name:'高数',parentId:'p'}});
  await account.set('yotick/projects',{});
  await account.set('yotick/shadow/project/p',{deleted:true});
  await guest.set('yotick/s/child',session('child-session','child'));
  assert.equal((await pendingGuest(raw,account)).hasData,false);
});
test('same name maps inside parent while genuinely new projects remain visible',async()=>{
  const {raw,guest,account}=await setup();
  await account.set('yotick/projects',{other:{id:'other',name:'数学',parentId:null}});
  await guest.set('yotick/s/s',session('s'));
  await account.set('yotick/s/existing',session('existing','other'));
  assert.equal((await pendingGuest(raw,account)).hasData,false);
  await guest.set('yotick/projects',{p:{id:'p',name:'数学'},new:{id:'new',name:'英语'}});
  assert.deepEqual(await pendingGuest(raw,account),{projectCount:1,sessionCount:0,hasData:true});
});

test('independent overlapping guest records warn before import while exact duplicates remain excluded', async () => {
  const {raw,guest,account} = await setup();
  await account.set('yotick/s/account', { ...session('account'), startedAtSec: 10, endedAtSec: 100, durationSeconds: 90 });
  await guest.set('yotick/s/independent', { ...session('independent'), startedAtSec: 20, endedAtSec: 40, durationSeconds: 20 });
  await guest.set('yotick/s/exact-copy', { ...session('exact-copy'), startedAtSec: 10, endedAtSec: 100, durationSeconds: 90 });
  assert.deepEqual(await pendingGuest(raw,account), {projectCount:0,sessionCount:1,hasData:true,overlapSessionCount:1});
});

test('guest records inside an account pause are not falsely flagged as overlapping focus', async () => {
  const {raw,guest,account} = await setup();
  await account.set('yotick/s/account', { ...session('account'), startedAtSec:10, endedAtSec:100, durationSeconds:70,
    pauses:[{startedAtSec:20,endedAtSec:40,durationSeconds:20}] });
  await guest.set('yotick/s/independent', { ...session('independent'), startedAtSec:20, endedAtSec:40,durationSeconds:20 });
  assert.deepEqual(await pendingGuest(raw,account), {projectCount:0,sessionCount:1,hasData:true});
});
