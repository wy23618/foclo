const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryAdapter } = require('../storage/adapter');
const { createAccounts } = require('../sync/accounts');
const { loginAndImport } = require('../sync/login-flow');
const { keepAvatar, discardAvatar } = require('../sync/display-profile');
const { uuid } = require('../core/ids');
const selection = { nickname:'  小明  ', avatarUrl:'wxfile://tmp/chosen-avatar.png' };
async function fixture() {
  const raw = createMemoryAdapter(), app = { globalData:{} }, accounts = createAccounts(raw, app, { baseUrl:'' });
  await accounts.init();
  const a = { userId:uuid(), spaceId:uuid(), generation:'1' }, b = { userId:uuid(), spaceId:uuid(), generation:'1' };
  await accounts.activate(a);
  return { raw, app, accounts, a, b };
}
test('display profiles follow the authenticated account and survive restarting the app', async () => {
  const f = await fixture(), avatarStore = { keepAvatar:async () => 'wxfile://usr/avatar-a.jpg', discardAvatar:async () => {} };
  await f.accounts.saveDisplayProfile(selection, avatarStore);
  assert.equal((await f.accounts.getDisplayProfile()).nickname, '小明');
  await f.accounts.activate(f.b);
  assert.equal(await f.accounts.getDisplayProfile(), null);
  await f.accounts.activate(f.a);
  const next = createAccounts(f.raw, { globalData:{} }, { baseUrl:'' });
  await next.init();
  assert.deepEqual(await next.getDisplayProfile(), { userId:f.a.userId, nickname:'小明', avatarUrl:'wxfile://usr/avatar-a.jpg' });
});
test('a failed profile write preserves the old display and removes only the newly copied avatar', async () => {
  const f = await fixture(), removed = [];
  const store = { keepAvatar:async () => 'wxfile://usr/old.jpg', discardAvatar:async path => removed.push(path) };
  await f.accounts.saveDisplayProfile(selection, store);
  f.raw.inject(key => key.includes('profile/'), 1, new Error('storage full'), 'set');
  await assert.rejects(() => f.accounts.saveDisplayProfile({ ...selection, nickname:'新昵称' }, { ...store, keepAvatar:async () => 'wxfile://usr/new.jpg' }), /storage full/);
  assert.equal((await f.accounts.getDisplayProfile()).nickname, '小明');
  assert.deepEqual(removed, ['wxfile://usr/new.jpg']);
});
test('switching accounts during avatar persistence never assigns the old profile to the new account', async () => {
  const f = await fixture(), removed = [];
  let resolveCopy, started;
  const copying = new Promise(resolve => { started = resolve; });
  const store = { keepAvatar:() => { started(); return new Promise(resolve => { resolveCopy = resolve; }); }, discardAvatar:async path => removed.push(path) };
  const saving = f.accounts.saveDisplayProfile(selection, store);
  await copying;
  await f.accounts.activate(f.b);
  resolveCopy('wxfile://usr/new.jpg');
  await assert.rejects(saving, /账号已切换/);
  assert.equal(await f.accounts.getDisplayProfile(), null);
  assert.equal(await f.raw.get('yotick-global/profile/' + f.a.userId), undefined);
  assert.deepEqual(removed, ['wxfile://usr/new.jpg']);
});
test('WeChat login succeeds without any display profile and asks before importing guest records', async () => {
  const calls = [];
  const accounts = {
    login:async () => calls.push('login'),
    saveDisplayProfile:async () => { throw new Error('profile must remain optional'); },
    getGuestSummary:async () => { calls.push('summary'); return { hasData:true, shouldAsk:true }; },
    deferGuestImport:async () => calls.push('retain-guest'),
  };
  await loginAndImport(accounts, async () => { calls.push('import-choice'); return false; }, async () => { calls.push('login-choice'); return true; });
  assert.deepEqual(calls, ['login-choice','login','summary','import-choice','retain-guest']);
});
test('choosing to experience as a guest neither logs in nor uploads any guest data', async () => {
  let stayed = false;
  const accounts = { stayGuest:async () => { stayed = true; }, login:async () => { throw new Error('must not log in'); } };
  assert.equal((await loginAndImport(accounts, () => { throw new Error('must not import'); }, async () => null)).cancelled, true);
  assert.equal(stayed, true);
});
test('failed WeChat authentication never starts guest migration or profile persistence', async () => {
  const accounts = { login:async () => { throw new Error('wechat unavailable'); },
    saveDisplayProfile:async () => { throw new Error('must not save profile'); },
    getGuestSummary:async () => { throw new Error('must not import'); } };
  await assert.rejects(() => loginAndImport(accounts, async () => true, async () => true), /wechat unavailable/);
});
test('avatars are copied to managed permanent files; cleanup cannot delete arbitrary files', async () => {
  const copied = [], removed = [], api = { env:{ USER_DATA_PATH:'wxfile://usr' }, getFileSystemManager:() => ({
    getFileInfo:({ success }) => success({ size:1024 }),
    copyFile:({ srcPath, destPath, success }) => { copied.push({ srcPath,destPath }); success(); },
    unlink:({ filePath, success }) => { removed.push(filePath); success(); },
  }) };
  const saved = await keepAvatar(selection.avatarUrl, api);
  assert.match(saved, /^wxfile:\/\/usr\/yotick-avatar-[a-f0-9-]+\.jpg$/);
  assert.equal(copied[0].srcPath, selection.avatarUrl);
  await discardAvatar('wxfile://usr/important.json', api);
  assert.deepEqual(removed, []);
  await discardAvatar(saved, api);
  assert.deepEqual(removed, [saved]);
});
