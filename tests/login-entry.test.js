const test = require('node:test');
const assert = require('node:assert/strict');
test('the mini program opens directly on focus and has no custom login page', () => {
  const pages = require('../app.json').pages;
  assert.equal(pages[0], 'pages/focus/focus');
  assert.ok(!pages.includes('pages/login/login'));
});
test('opening the home page never starts login before the visitor chooses it', async () => {
  const oldWx = global.wx;
  global.wx = { getWindowInfo:() => ({ windowWidth:375, windowHeight:667 }) };
  try {
    for (const account of [null, { userId:'saved' }]) {
      const app = { globalData:{ readyPromise:Promise.resolve(), accounts:{ getCurrent:() => account } } };
      const page = require('../pages/focus/focus-definition')(app);
      page.data = structuredClone(page.data);
      page.setData = patch => Object.assign(page.data, patch);
      page.updateTabletLayout = () => {};
      let logins = 0;
      page.loginWechat = async () => { logins++; };
      await page.onLoad({});
      assert.equal(page.data.ready, true);
      assert.equal(logins, 0);
      assert.equal(page.data.identityOpen, false);
    }
  } finally { global.wx = oldWx; }
});
