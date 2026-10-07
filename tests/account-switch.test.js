const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAdapter } = require("../storage/adapter");
const { createAccounts } = require("../sync/accounts");
const { uuid } = require("../core/ids");

test('plain WeChat storage failures show the login stage and retain the guest space', async () => {
  const previousWx = global.wx;
  try {
    global.wx = { login: options => options.success({ code: 'test-code' }) };
    for (const stage of ['credentials', 'space']) {
      const raw = createMemoryAdapter(), app = { globalData: {} };
      const ref = { userId: uuid(), spaceId: uuid(), generation: '1' };
      const accounts = createAccounts(raw, app, {
        baseUrl: 'https://test.invalid/api/v1',
        transport: async (method, url) => url.endsWith('/me') ? ref : { accessToken: 'test-access', refreshToken: 'test-refresh' },
      });
      await accounts.init();
      const guestService = app.globalData.service;
      const guestKeys = await raw.keys();
      if (stage === 'credentials') {
        const originalSet = raw.set.bind(raw);
        raw.set = async (key, value) => {
          if (key.startsWith('yotick-global/credentials/')) throw { errMsg: 'setStorage:fail quota exceeded' };
          return originalSet(key, value);
        };
        await assert.rejects(accounts.login(), /保存登录信息失败：setStorage:fail quota exceeded/);
      } else {
        const originalGet = raw.get.bind(raw);
        raw.get = async key => {
          if (key.startsWith('yotick-space/') && !key.startsWith('yotick-space/guest/')) {
            throw { errMsg: 'readFile:fail permission denied, open wxfile://private-account-path' };
          }
          return originalGet(key);
        };
        await assert.rejects(accounts.login(), error => /打开账号空间失败：readFile:fail permission denied/.test(error.message) && !error.message.includes('private-account-path'));
      }
      assert.equal(accounts.getCurrent(), null);
      assert.equal(app.globalData.service, guestService);
      for (const key of guestKeys) assert.ok(raw._map.has(key));
    }
  } finally {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});

async function setup() {
  const raw = createMemoryAdapter(),
    app = { globalData: {} },
    accounts = createAccounts(raw, app);
  await accounts.init();
  const project = await app.globalData.service.createProject({
    operationId: uuid(),
    name: "切换期间计时",
  });
  return {
    raw,
    app,
    accounts,
    project: project.data.project,
    oldService: app.globalData.service,
  };
}
test("slow account initialization rechecks newly started focus and keeps the original space", async () => {
  const f = await setup(),
    ref = { userId: uuid(), spaceId: uuid(), generation: "1" },
    get = f.raw.get.bind(f.raw);
  let release,
    entered,
    held = false;
  const gate = new Promise((r) => (release = r)),
    started = new Promise((r) => (entered = r));
  f.raw.get = async (key) => {
    if (
      !held &&
      key.startsWith(
        "yotick-space/" + encodeURIComponent(ref.spaceId + "@1") + "/",
      )
    ) {
      held = true;
      entered();
      await gate;
    }
    return get(key);
  };
  const switching = f.accounts.activate(ref),
    rejected = assert.rejects(switching, /计时进行中/);
  await started;
  const active = await f.oldService.start({
    operationId: uuid(),
    projectId: f.project.id,
    targetSeconds: 60,
  });
  assert.equal(active.ok, true);
  release();
  await rejected;
  assert.equal(f.app.globalData.service, f.oldService);
  assert.equal(f.app.globalData.adapter.namespace, "guest");
  assert.equal(
    (await f.oldService.getCurrent()).data.sessionId,
    active.data.sessionId,
  );
  assert.equal(await f.raw.get("yotick-global/current"), null);
});
test("commands queued behind the final account switch refuse writes to the retired service", async () => {
  const f = await setup(),
    ref = { userId: uuid(), spaceId: uuid(), generation: "1" },
    set = f.raw.set.bind(f.raw);
  let release, entered;
  const gate = new Promise((r) => (release = r)),
    started = new Promise((r) => (entered = r));
  f.raw.set = async (key, value) => {
    if (key === "yotick-global/current" && value?.spaceId === ref.spaceId) {
      entered();
      await gate;
    }
    return set(key, value);
  };
  const switching = f.accounts.activate(ref);
  await started;
  const stale = f.oldService.start({
    operationId: uuid(),
    projectId: f.project.id,
    targetSeconds: 60,
  });
  release();
  await switching;
  assert.equal((await stale).error.code, "SPACE_CHANGED");
  assert.equal(
    (await f.app.globalData.service.getCurrent()).data.sessionId,
    null,
  );
  assert.equal(f.app.globalData.adapter.namespace, ref.spaceId + "@1");
});
