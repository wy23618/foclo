const test = require('node:test');
const assert = require('node:assert/strict');
const routes = ['pages/focus/focus', 'pages/stats/stats', 'pages/settings/settings'];
function fixture() {
  const stack = [{ route: routes[0], state: 'kept' }], messages = [];
  global.getCurrentPages = () => stack;
  global.wx = {
    navigateTo(o) { stack.push({ route: o.url.slice(1) }); o.complete(); },
    navigateBack(o) { stack.splice(stack.length - o.delta, o.delta); o.complete(); },
    reLaunch(o) { stack.splice(0, stack.length, { route: o.url.slice(1) }); if(o.complete)o.complete(); },
    showToast(o) { messages.push(o.title); }
  };
  delete require.cache[require.resolve('../utils/main-navigation')];
  return { nav: require('../utils/main-navigation'), stack, messages };
}
test.afterEach(() => { delete global.wx; delete global.getCurrentPages; });
test('main pages retain real native history for system back and reuse existing instances', () => {
  const { nav, stack } = fixture();
  const focus = stack[0];
  nav.openMainTab(1); const stats = stack[1]; stats.filter = 'last7';
  nav.openMainTab(2);
  assert.deepEqual(stack.map(p => p.route), routes);
  // System back must work with no custom JS handler/container.
  wx.navigateBack({ delta: 1, complete() {} });
  assert.equal(stack[1], stats); assert.equal(stats.filter, 'last7');
  nav.backMainTab(); assert.deepEqual(stack, [focus]);
  nav.openMainTab(1); nav.openMainTab(2); nav.openMainTab(0);
  assert.deepEqual(stack, [focus]);
  for (let i = 0; i < 25; i++) { nav.openMainTab(1); nav.openMainTab(2); nav.openMainTab(0); }
  assert.equal(stack.length, 1);
});
test('duplicate taps and failed transitions keep native history intact', () => {
  const { nav, stack, messages } = fixture();
  nav.openMainTab(1); nav.openMainTab(1); assert.equal(stack.length, 2);
  const push = wx.navigateTo;
  wx.navigateTo = o => { o.fail(); o.complete(); };
  nav.openMainTab(2); assert.equal(stack.length, 2);
  wx.navigateTo = push;
  nav.backMainTab(); assert.equal(stack.length, 1);
  nav.backMainTab(); assert.equal(stack.length, 1);
  assert.deepEqual(messages, ['暂时无法打开，请重试', '已在起始页面']);
});
test('main pages are not native tab roots and contain no invisible back interception', () => {
  const fs = require('node:fs');
  assert.equal(require('../app.json').tabBar, undefined);
  for (const suffix of ['js', 'json', 'wxml', 'wxss']) {
    assert.equal(fs.existsSync(require('node:path').resolve(__dirname, '../custom-tab-bar/index.' + suffix)), false, 'unused native tab bar: ' + suffix);
  }
  assert.doesNotMatch(fs.readFileSync(require.resolve('../components/main-nav/main-nav.wxml'), 'utf8'), /page-container/);
});
