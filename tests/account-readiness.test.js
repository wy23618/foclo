const test = require('node:test');
const assert = require('node:assert/strict');

function fixture() {
  let definition, finish, reject, current = null;
  const calls = { login:0, subscriptions:0, unsubscriptions:0, status:0, modals:[] };
  const accounts = {
    getStatus() { calls.status++; return { state:current ? 'synced' : 'guest', pending:0 }; },
    getCurrent:() => current,
    getDisplayProfile:async () => null,
    getGuestSummary:async () => ({ checked:true, hasData:false }),
    conflicts:async () => [],
    subscribe() { calls.subscriptions++; return () => calls.unsubscriptions++; },
    async login() { calls.login++; current = { userId:'test-user', spaceId:'test-space', generation:'1' }; },
  };
  const app = { globalData:{ ready:false, readyPromise:new Promise((yes,no) => { finish=yes; reject=no; }),
    service:{ getManageData:async () => ({ ok:true, data:{ active:[], archived:[] } }), getPrefs:async () => ({ theme:'light' }) } } };
  global.wx = { showToast() {}, showLoading() {}, hideLoading() {}, setNavigationBarColor() {}, showModal:o => calls.modals.push(o) };
  global.getApp = () => app;
  global.Page = value => { definition=value; };
  delete require.cache[require.resolve('../pages/account/account')];
  require('../pages/account/account');
  const page = { ...definition, data:structuredClone(definition.data) };
  page.setData = patch => Object.assign(page.data,patch);
  page.onLoad({});
  return { page, app, accounts, calls,
    ready() { app.globalData.accounts=accounts; app.globalData.ready=true; finish(); },
    fail() { reject(new Error('storage initialization failed')); } };
}
test.afterEach(() => { delete global.wx; delete global.getApp; delete global.Page; });

test('a sync callback can refresh the account page before onShow binds its service', async () => {
  const f=fixture();
  const background=f.page.refresh();
  await Promise.resolve();
  assert.equal(f.calls.status,0);
  assert.equal(f.page.data.statusMessage,'');
  f.ready(); await background; await f.page.onShow();
  assert.equal(f.page.accounts,f.accounts);
  assert.equal(f.page.data.accountReady,true);
  assert.equal(f.page.data.accountPreparing,false);
  assert.equal(f.page.data.accountLabel,'游客体验');
  assert.equal(f.page.data.statusMessage,'');
  assert.equal(f.calls.subscriptions,1);
});

test('an early login tap waits for account readiness and logs in once without an undefined service', async () => {
  const f=fixture();f.page.data.agreementAccepted=true;
  const showing=f.page.onShow();
  const login=f.page.onLogin({ currentTarget:{ dataset:{ method:'wechat' } } });
  await Promise.resolve();
  assert.equal(f.calls.login,0);
  f.ready(); await Promise.all([showing,login]);
  assert.equal(f.calls.login,1);
  assert.equal(f.page.data.hasAccount,true);
  assert.equal(f.page.data.busy,false);
  assert.equal(f.page.data.statusMessage,'');
  assert.deepEqual(f.calls.modals,[]);
  assert.equal(f.calls.subscriptions,1);
});

test('a failed initialization gives readable feedback and never invokes login', async () => {
  const f=fixture();f.page.data.agreementAccepted=true;
  const showing=f.page.onShow();f.fail();await showing;
  assert.equal(f.page.data.accountReady,false);
  assert.equal(f.page.data.accountPreparing,false);
  assert.match(f.page.data.statusMessage,/本机资料尚未准备完成/);
  await f.page.onLogin();
  assert.equal(f.calls.login,0);
  assert.equal(f.calls.modals.length,1);
  assert.doesNotMatch(f.calls.modals[0].content,/undefined|Cannot read/);
});

test('closing the account page during startup never subscribes or starts a late login', async () => {
  const f=fixture();f.page.data.agreementAccepted=true;
  const showing=f.page.onShow(),login=f.page.onLogin();
  f.page.onUnload();
  f.page.setData=() => assert.fail('closed account page must not be updated');
  f.ready();await Promise.all([showing,login]);
  assert.equal(f.calls.login,0);
  assert.equal(f.calls.subscriptions,0);
  assert.deepEqual(f.calls.modals,[]);
});
