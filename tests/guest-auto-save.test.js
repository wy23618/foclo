const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryAdapter } = require('../storage/adapter');
const { commit } = require('../sync/migration');

test('automatic saving refuses an old server before submitting any merge', async () => {
  const adapter = createMemoryAdapter();
  await adapter.set('yotick/import/current', { id:'job', preview:{ digest:'snapshot' } });
  let requests = 0;
  await assert.rejects(() => commit(adapter, async () => { requests++; }, 'device', {}, {}, { automatic:true }), /自动保存服务尚未更新/);
  assert.equal(requests,0);
});
test('automatic saving persists successful receipt and sends only the account-preserving policy', async () => {
  const adapter = createMemoryAdapter();
  await adapter.set('yotick/import/current', { id:'job', guestSignature:'version', preview:{ digest:'snapshot',mergePolicy:'KEEP_ACCOUNT' } });
  const result = { committed:true,addedSessionCount:0,skippedSessionCount:2 };
  await commit(adapter, async (method,path,body) => {
    assert.equal(body.mergePolicy,'KEEP_ACCOUNT');
    assert.equal(body.sourceDigest,'snapshot');
    assert.deepEqual(body.sessionMapping,{});
    return result;
  }, 'device', {}, {}, { automatic:true });
  const saved = await adapter.get('yotick/import/current');
  assert.equal(saved.status,'committed');
  assert.equal(saved.guestSignature,'version');
  assert.deepEqual(saved.result,result);
});
test('account record clearing routes to account maintenance before any guest-only operation', async () => {
  const oldPage=global.Page, oldWx=global.wx, oldGetApp=global.getApp;
  let definition,destination;
  global.Page=value=>{definition=value;};
  global.getApp=()=>({ globalData:{ accounts:{getCurrent:()=>({userId:'current'})},service:{createBackup:()=>{throw new Error('must not clear guest');}} } });
  global.wx={navigateTo:options=>{destination=options.url;}};
  try {
    delete require.cache[require.resolve('../pages/settings-detail/settings-detail')];
    require('../pages/settings-detail/settings-detail');
    await definition.clearAllData.call({fileBusy:false});
    assert.equal(destination,'/pages/account/account?tools=1');
  } finally {global.Page=oldPage;global.wx=oldWx;global.getApp=oldGetApp;}
});
