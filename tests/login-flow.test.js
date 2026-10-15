const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryAdapter } = require('../storage/adapter');
const { createAccountAdapter } = require('../storage/account-adapter');
const { createAccounts } = require('../sync/accounts');
const { loginAndImport, importGuestWithConfirmation, confirmGuestImport } = require('../sync/login-flow');
const { uuid } = require('../core/ids');

test('guest import confirmation fits native WeChat button limits and awaits consent before upload', async () => {
  const oldWx = global.wx;
  let modal;
  global.wx = { showModal: options => {
    for (const label of [options.confirmText, options.cancelText]) assert.ok([...label].length <= 4);
    modal = options;
  } };
  const calls = [];
  const accounts = {
    getGuestSummary:async () => ({ hasData:true, shouldAsk:true, projectCount:2, sessionCount:3 }),
    migrateGuest:async () => { calls.push('upload'); return { conflicts:[] }; },
    commitGuestMigration:async () => calls.push('commit'),
  };
  try {
    const pending = importGuestWithConfirmation(accounts, confirmGuestImport);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(modal);
    assert.deepEqual(calls, []);
    modal.success({ confirm:true });
    assert.equal((await pending).imported, true);
    assert.deepEqual(calls, ['upload', 'commit']);
  } finally { global.wx = oldWx; }
});

test('a native confirmation failure has a readable error and never uploads guest records', async () => {
  const oldWx = global.wx;
  global.wx = { showModal: options => options.fail({ errMsg:'showModal:fail native error' }) };
  try {
    const accounts = {
      getGuestSummary:async () => ({ hasData:true, shouldAsk:true }),
      migrateGuest:async () => { throw new Error('must not upload'); },
    };
    await assert.rejects(() => importGuestWithConfirmation(accounts, confirmGuestImport), error =>
      error.code === 'IMPORT_CONFIRM_FAILED' && error.message.includes('迁移确认提示') && error.loggedIn);
  } finally { global.wx = oldWx; }
});

async function fixture({ guest = true, conflicts = [], loseCommit = false } = {}) {
  const raw = createMemoryAdapter(), app = { globalData: {} }, calls = [], jobs = new Map();
  let ref = { userId: uuid(), spaceId: uuid(), generation: '1' }, commitCount = 0;
  const transport = async (method, url, data) => {
    const route = new URL(url).pathname.replace('/api/v1', '');
    calls.push({ method, route, data });
    if (route === '/auth/wechat-mini') return { accessToken:'test', refreshToken:'test' };
    if (route === '/auth/logout') return {};
    if (route === '/me') return ref;
    if (route === '/sync/pull') return { changes:[], cursor:'0', hasMore:false };
    if (route === '/imports' && method === 'POST') {
      if (!jobs.has(data.jobId)) jobs.set(data.jobId, { received:[], result:null });
      return {};
    }
    if (route === '/imports/preview') return { mergePolicy:'KEEP_ACCOUNT', projectCount:1, sessionCount:0, digest:'snapshot', conflicts };
    const match = route.match(/^\/imports\/([^/]+)(?:\/(chunks)\/(\d+)|\/(commit))?$/);
    if (match) {
      const job = jobs.get(match[1]);
      if (method === 'GET') return job;
      if (match[2]) { job.received.push({ chunk_index:Number(match[3]) }); return {}; }
      if (match[4]) {
        job.result ||= { committed:true };
        commitCount++;
        if (loseCommit && commitCount === 1) throw Object.assign(new Error('response lost'), { code:'NETWORK_ERROR' });
        return job.result;
      }
    }
    throw new Error('Unexpected route: ' + route);
  };
  const accounts = createAccounts(raw, app, { baseUrl:'https://test.invalid/api/v1', transport });
  await accounts.init();
  if (guest) assert.equal((await app.globalData.service.createProject({ operationId:uuid(), name:'游客英语' })).ok, true);
  return { raw, app, accounts, calls, jobs, transport, setRef(next) { ref = next; } };
}
test('first login asks before uploading, imports without extra steps, and keeps the guest copy', async () => {
  const oldWx = global.wx;
  global.wx = { login:({ success }) => success({ code:'test' }) };
  const f = await fixture();
  try {
    const result = await loginAndImport(f.accounts, async summary => {
      assert.ok(f.accounts.getCurrent());
      assert.equal(summary.projectCount, 1);
      assert.equal(f.calls.filter(c => c.route.startsWith('/imports')).length, 0);
      return true;
    });
    assert.equal(result.imported, true);
    const summary = await f.accounts.getGuestSummary();
    assert.equal(summary.imported, true);
    assert.equal(summary.shouldAsk, false);
    assert.equal(Object.keys(await createAccountAdapter(f.raw, 'guest').get('yotick/projects')).length, 1);
    await loginAndImport(f.accounts, () => { throw new Error('must not ask twice'); });
    assert.equal(f.jobs.size, 1);
  } finally { await f.accounts.activate(null); global.wx = oldWx; }
});
test('deferring survives restart without uploading; explicit import remains available', async () => {
  const oldWx = global.wx;
  global.wx = { login:({ success }) => success({ code:'test' }) };
  const f = await fixture();
  try {
    assert.equal((await loginAndImport(f.accounts, async () => false)).deferred, true);
    assert.equal(f.jobs.size, 0);
    await f.accounts.activate(null);
    f.app = { globalData:{} };
    f.accounts = createAccounts(f.raw, f.app, { baseUrl:'https://test.invalid/api/v1', transport:f.transport });
    await f.accounts.init();
    await loginAndImport(f.accounts, () => { throw new Error('deferred history should not prompt again'); });
    assert.equal((await importGuestWithConfirmation(f.accounts, async () => true, true)).imported, true);
  } finally { await f.accounts.activate(null); global.wx = oldWx; }
});
test('a guest import decision belongs to one account; another account must confirm for itself', async () => {
  const oldWx = global.wx;
  global.wx = { login:({ success }) => success({ code:'test' }) };
  const f = await fixture();
  try {
    await loginAndImport(f.accounts, async () => false);
    f.setRef({ userId:uuid(), spaceId:uuid(), generation:'1' });
    let asked = false;
    await loginAndImport(f.accounts, async summary => { asked = true; assert.equal(summary.hasData, true); return false; });
    assert.equal(asked, true);
    assert.equal(f.jobs.size, 0);
  } finally { await f.accounts.activate(null); global.wx = oldWx; }
});
test('guest summary excludes the active timer without reading every record file', async () => {
  const f = await fixture();
  const guest = f.app.globalData.adapter;
  const meta = await guest.get('yotick/meta');
  const activeId = uuid(), completedId = uuid();
  await guest.set('yotick/meta', { ...meta, activeSessionId:activeId });
  await guest.set('yotick/s/' + activeId, { status:'ACTIVE' });
  await guest.set('yotick/s/' + completedId, { status:'COMPLETED' });
  f.raw.inject(key => key.includes('/yotick/s/'), 1, new Error('summary must not read individual facts'), 'get');
  assert.equal((await f.accounts.getGuestSummary()).sessionCount, 1);
  f.raw.clearFaults();
});
test('existing account records are handled automatically without a second choice screen', async () => {
  const oldWx = global.wx;
  global.wx = { login:({ success }) => success({ code:'test' }) };
  const f = await fixture({ conflicts:[{ type:'NAME_CONFLICT', sourceId:uuid(), cloud:{ name:'英语' } }] });
  try {
    const result = await loginAndImport(f.accounts, async () => true);
    assert.equal(result.imported, true);
    assert.equal(result.preview, undefined);
    const commits = f.calls.filter(c => c.route.endsWith('/commit'));
    assert.equal(commits.length, 1);
    assert.equal(commits[0].data.mergePolicy, 'KEEP_ACCOUNT');
  } finally { await f.accounts.activate(null); global.wx = oldWx; }
});

test('guest saving waits for account edits to reach the server before comparing old copies', async () => {
  const oldWx = global.wx;
  global.wx = { login:({ success }) => success({ code:'test' }) };
  const f = await fixture();
  try {
    await f.accounts.login();
    await f.app.globalData.service.createProject({ operationId:uuid(), name:'尚未保存的账号修改' });
    await assert.rejects(() => f.accounts.migrateGuest(), /账号还有更改未保存/);
    assert.equal(f.jobs.size,0);
    assert.equal((await f.accounts.getGuestSummary()).hasData,true);
  } finally { await f.accounts.activate(null); global.wx = oldWx; }
});
test('lost import response can retry the same job; the guest source is preserved', async () => {
  const oldWx = global.wx;
  global.wx = { login:({ success }) => success({ code:'test' }) };
  const f = await fixture({ loseCommit:true });
  try {
    await assert.rejects(() => loginAndImport(f.accounts, async () => true), error => error.loggedIn && /response lost/.test(error.message));
    assert.equal((await f.accounts.getGuestSummary()).hasData, true);
    assert.equal((await importGuestWithConfirmation(f.accounts, async () => true, true)).imported, true);
    assert.equal(f.jobs.size, 1);
    assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  } finally { await f.accounts.activate(null); global.wx = oldWx; }
});
test('an empty guest install has no import prompt', async () => {
  const oldWx = global.wx;
  global.wx = { login:({ success }) => success({ code:'test' }) };
  const f = await fixture({ guest:false });
  try {
    await loginAndImport(f.accounts, () => { throw new Error('empty guest should not prompt'); });
    assert.equal(f.jobs.size, 0);
  } finally { await f.accounts.activate(null); global.wx = oldWx; }
});
test('explicit logout persists guest mode across restart and a later login enables account access again', async () => {
  const oldWx = global.wx;
  global.wx = { login:({ success }) => success({ code:'test' }) };
  const f = await fixture();
  try {
    await loginAndImport(f.accounts, async () => false);
    const oldRef = f.accounts.getCurrent();
    await f.accounts.logout();
    assert.equal(f.accounts.getCurrent(), null);
    assert.equal(f.app.globalData.guestSession, true);
    assert.equal(await f.raw.get('yotick-global/credentials/' + oldRef.userId), undefined);
    const nextApp = { globalData:{} };
    const next = createAccounts(f.raw, nextApp, { baseUrl:'https://test.invalid/api/v1', transport:f.transport });
    await next.init();
    assert.equal(nextApp.globalData.guestSession, true);
    assert.equal(Object.keys(await nextApp.globalData.adapter.get('yotick/projects')).length, 1);
    await next.login();
    assert.equal(next.getCurrent().userId, oldRef.userId);
    assert.equal(nextApp.globalData.guestSession, false);
    assert.equal(await f.raw.get('yotick-global/auto-login'), true);
    await next.activate(null);
  } finally { await f.accounts.activate(null); global.wx = oldWx; }
});
