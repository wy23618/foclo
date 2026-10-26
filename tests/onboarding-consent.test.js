const test = require('node:test');
const assert = require('node:assert/strict');
const { loginAndImport } = require('../sync/login-flow');

function entry() {
  let definition;
  global.Component = value => { definition = value; };
  delete require.cache[require.resolve('../components/account-entry/account-entry')];
  require('../components/account-entry/account-entry');
  const component = Object.assign({ data:structuredClone(definition.data) }, definition.methods);
  component.setData = patch => Object.assign(component.data, patch);
  component.triggerEvent = () => {};
  return component;
}
test.afterEach(() => { delete global.Component; delete global.wx; });

test('first-entry login cannot reach account authentication until consent is checked', async () => {
  const component = entry(), calls = [];
  global.wx = { showToast:() => calls.push('hint') };
  const pending = loginAndImport({
    login:async () => calls.push('login'),
    getGuestSummary:async () => ({ hasData:false }),
  }, () => assert.fail('no guest import expected'), () => component.request());
  component.login();
  await Promise.resolve();
  assert.equal(component.data.opened, true);
  assert.deepEqual(calls, ['hint']);
  component.toggleAgreement();
  component.login();
  assert.deepEqual(await pending, { imported:false });
  assert.deepEqual(calls, ['hint', 'login']);
});

test('guest choice needs no consent and never authenticates', async () => {
  const component = entry(), calls = [];
  const pending = loginAndImport({
    login:async () => assert.fail('guest must not log in'),
    stayGuest:async () => calls.push('guest'),
  }, null, () => component.request());
  component.experience();
  assert.equal((await pending).cancelled, true);
  assert.deepEqual(calls, ['guest']);
});

test('reopening the entry resets consent; opening legal pages keeps the choice pending', async () => {
  const component = entry(), urls = [];
  global.wx = { navigateTo:options => urls.push(options.url) };
  const first = component.request();
  component.toggleAgreement();
  component.experience();
  await first;
  const second = component.request();
  assert.equal(component.data.agreementAccepted, false);
  component.openTerms(); component.openPrivacy();
  assert.equal(component.data.opened, true);
  assert.equal(component.data.agreementAccepted, false);
  assert.deepEqual(urls, ['/pages/terms/terms', '/pages/privacy/privacy']);
  component.experience();
  await second;
});

test('guest reminder can be dismissed and cannot start login during focus or rest', async () => {
  const page = require('../pages/focus/focus-definition')({ globalData:{} });
  page.data = structuredClone(page.data);
  page.setData = patch => Object.assign(page.data, patch);
  let logins = 0;
  page.loginWechat = async () => logins++;
  page.dismissGuestHint();
  assert.equal(page.data.guestHintDismissed, true);
  for (const state of ['STUDYING', 'PAUSED']) {
    page.data.cur = { state };
    await page.onGuestLogin();
  }
  page.data.cur = { state:'IDLE' };
  page.data.restState = 'RUNNING';
  await page.onGuestLogin();
  assert.equal(logins, 0);
  page.data.restState = null;
  await page.onGuestLogin();
  assert.equal(logins, 1);
});

test('main pages share only the public entry, without project or account parameters', () => {
  for (const scene of ['focus', 'stats', 'settings']) {
    const definition = require('../utils/share').withShare(require('../pages/' + scene + '/' + scene + '-definition')({ globalData:{} }));
    assert.deepEqual(definition.onShareAppMessage(), {
      title:'Foclo · 把专注留给自己', path:'/pages/focus/focus', imageUrl:'/assets/share/foclo-cover.jpg',
    });
  }
});
