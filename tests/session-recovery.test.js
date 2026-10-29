const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryAdapter } = require('../storage/adapter');
const { createAccountAdapter } = require('../storage/account-adapter');
const { createService } = require('../core/service');
const { createAccounts } = require('../sync/accounts');
const { uuid } = require('../core/ids');
const local = require('../sync/local');

async function fixture(options = {}) {
  const ref = { userId: uuid(), spaceId: uuid(), generation: '1' }, raw = createMemoryAdapter(), app = { globalData: {} };
  await raw.set('yotick-global/current', ref);
  if (!options.missingCredentials) await raw.set('yotick-global/credentials/' + ref.userId, { accessToken: 'expired', refreshToken: 'expired-refresh' });
  await raw.set('yotick-global/auto-login', !options.guest);
  const adapter = createAccountAdapter(raw, ref.spaceId + '@1');
  await adapter.set(local.STATE, { ...ref, nextOrder: 0 });
  let now = Math.floor(Date.now() / 1000) - 120;
  const original = createService(adapter, { clock: () => now }); await original.init();
  const project = (await original.createProject({ operationId: uuid(), name: '平板离线记录' })).data.project;
  const completed = await original.start({ operationId: uuid(), projectId: project.id, targetSeconds: 60 });
  now += 60; await original.getCurrent();
  let active;
  if (options.active) active = await original.start({ operationId: uuid(), projectId: project.id, targetSeconds: 3600 });
  const uploads = [], changes = [], counters = { logins: 0, exchanges: 0 };
  const previousWx = global.wx;
  global.wx = { login(args) { counters.logins++; if (options.login) options.login(args); else args.success({ code: 'silent-existing-user' }); } };
  const accounts = createAccounts(raw, app, { baseUrl: 'https://test.invalid/api/v1', transport: async (method, url, data, token) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/auth/wechat-mini')) { counters.exchanges++; return { accessToken: 'restored', refreshToken: 'restored-refresh' }; }
    if (route.endsWith('/auth/refresh') || token !== 'restored') throw Object.assign(new Error('登录凭证过期'), { code: 'AUTH_REQUIRED', status: 401 });
    if (route.endsWith('/me')) return typeof options.identity === 'function' ? options.identity(ref) : options.identity || ref;
    if (route.endsWith('/focus/presence')) return { otherDevices: [] };
    if (route.endsWith('/sync/pull')) return { changes, cursor: String(changes.length), hasMore: false };
    if (route.endsWith('/sync/push')) return { results: data.operations.map(operation => {
      uploads.push(operation);
      const change = { entityType: operation.kind.split('.')[0], entityId: operation.entityId, serverVersion: '1', data: operation.payload, deleted: false };
      changes.push(change); return { operationId: operation.operationId, status: 'applied', changes: [change] };
    }) };
    throw new Error('Unexpected route ' + route);
  } });
  return { accounts, raw, app, ref, completed, active, counters, uploads, async close() { accounts.suspendSync(); accounts.getRequest()?.cancel(); global.wx = previousWx; } };
}

test('expired tablet login renews automatically, uploads saved study, and preserves the running timer', async () => {
  const f = await fixture({ active: true });
  try {
    await f.accounts.init(); const service = f.app.globalData.service;
    await f.accounts.trigger();
    assert.equal(f.counters.logins, 1); assert.equal(f.counters.exchanges, 1);
    assert.equal(f.app.globalData.service, service, 'silent renewal cannot replace the active service');
    assert.equal((await service.getCurrent()).data.sessionId, f.active.data.sessionId);
    assert.equal(f.accounts.getCurrent().userId, f.ref.userId);
    assert.equal(f.app.globalData.adapter.namespace, f.ref.spaceId + '@1');
    const sessions = f.uploads.filter(op => op.kind === 'session.createCompleted');
    assert.equal(sessions.length, 1); assert.equal(sessions[0].entityId, f.completed.data.sessionId);
    assert.equal(sessions[0].payload.durationSeconds, 60);
    assert.equal((await local.pending(f.app.globalData.adapter)).length, 0);
    assert.equal(f.accounts.getStatus().state, 'synced');
    await f.accounts.refreshRecords(); assert.equal(f.counters.logins, 1);
  } finally { await f.close(); }
});

test('the previously signed-in account can recover missing credentials during a refresh', async () => {
  const f = await fixture({ missingCredentials: true });
  try {
    await f.accounts.init(); await f.accounts.refreshRecords();
    assert.equal(f.counters.logins, 1);
    assert.equal(f.accounts.getStatus().state, 'synced');
    assert.equal((await f.raw.get('yotick-global/credentials/' + f.ref.userId)).accessToken, 'restored');
  } finally { await f.close(); }
});

test('automatic recovery refuses a different WeChat identity without uploading or replacing the old account', async () => {
  const f = await fixture({ identity: { userId: uuid(), spaceId: uuid(), generation: '1' } });
  try {
    await f.accounts.init(); await f.accounts.trigger();
    assert.equal(f.accounts.getStatus().state, 'auth-required');
    assert.equal(f.uploads.length, 0);
    assert.equal(f.accounts.getCurrent().userId, f.ref.userId);
    assert.equal((await f.raw.get('yotick-global/credentials/' + f.ref.userId)).accessToken, 'expired');
    assert.equal((await local.pending(f.app.globalData.adapter)).length, 2);
    assert.ok(await f.app.globalData.adapter.get('yotick/s/' + f.completed.data.sessionId));
  } finally { await f.close(); }
});

test('an explicit guest choice prevents automatic account login', async () => {
  const f = await fixture({ guest: true });
  try {
    await f.accounts.init(); await f.accounts.trigger();
    assert.equal(f.counters.logins, 0); assert.equal(f.uploads.length, 0);
    assert.equal(f.accounts.getStatus().state, 'auth-required');
  } finally { await f.close(); }
});

test('silent recovery never pushes old-generation records into a restored cloud account', async () => {
  const f = await fixture({ identity: ref => ({ ...ref, generation: '2' }) });
  try {
    await f.accounts.init(); await f.accounts.trigger();
    assert.equal(f.accounts.getStatus().state, 'quarantined');
    assert.equal(f.uploads.length, 0);
    assert.equal((await local.pending(f.app.globalData.adapter)).length, 2);
    assert.ok(await f.app.globalData.adapter.get('yotick/s/' + f.completed.data.sessionId));
    assert.equal((await f.raw.get('yotick-global/credentials/' + f.ref.userId)).accessToken, 'expired');
  } finally { await f.close(); }
});

test('switching accounts during silent login cancels old recovery without replacing credentials or uploading its queue', async () => {
  let held, started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture({ login(args) { held = args; started(); } });
  try {
    await f.accounts.init(); const oldRun = f.accounts.trigger(); await entered;
    const oldAdapter = f.app.globalData.adapter, next = { userId: uuid(), spaceId: uuid(), generation: '1' };
    await f.raw.set('yotick-global/credentials/' + next.userId, { accessToken: 'restored', refreshToken: 'b-refresh' });
    await f.accounts.activate(next);
    held.success({ code: 'late-old-user' }); await oldRun;
    assert.equal(f.accounts.getCurrent().userId, next.userId);
    assert.equal(f.counters.exchanges, 0);
    assert.equal(f.uploads.length, 0);
    assert.equal((await local.pending(oldAdapter)).length, 2);
    assert.equal((await f.raw.get('yotick-global/credentials/' + f.ref.userId)).accessToken, 'expired');
  } finally { await f.close(); }
});
