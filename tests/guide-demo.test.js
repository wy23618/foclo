const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const demo = require('../utils/demo-context');
const { GUIDE_CARDS } = require('../utils/user-guide');
const { createService } = require('../core/service');
const { createMemoryAdapter } = require('../storage/adapter');
const created = [];

async function session(feature = 'stats') {
  const value = demo.createSession(feature);
  created.push(value);
  await value.app.globalData.readyPromise;
  return value;
}

function wxStub() {
  return {
    nextTick: fn => fn(), setNavigationBarTitle() {}, setNavigationBarColor() {},
    setKeepScreenOn() {}, showToast() {}, showModal() {}, pageScrollTo() {},
    getAccountInfoSync: () => ({ miniProgram: { version: 'test' } }),
    getSystemInfoSync: () => ({ platform: 'devtools', theme: 'light' }),
    getStorage() { throw Error('A demonstration accessed real storage'); },
    setStorage() { throw Error('A demonstration wrote to real storage'); },
    request() { throw Error('A demonstration made a network request'); },
    login() { throw Error('A demonstration initiated a real login'); }
  };
}

test.beforeEach(() => {
  global.wx = wxStub();
  global.getApp = () => { throw Error('A demonstration accessed the real app'); };
});
test.afterEach(() => { delete global.wx; delete global.getApp; delete global.getCurrentPages; });
test.after(() => { created.forEach(value => demo.release(value)); });

test('guide tiles open a static preview first, then try-it enters an isolated example scene', async () => {
  const targets = [];
  global.wx.navigateTo = options => { targets.push(options.url); if (options.success) options.success(); if (options.complete) options.complete(); };
  let guide;
  global.Page = definition => { guide = definition; };
  delete require.cache[require.resolve('../pages/guide/guide')];
  require('../pages/guide/guide');
  delete global.Page;
  guide = Object.assign({}, guide, { data: structuredClone(guide.data) });
  guide.setData = patch => Object.assign(guide.data, patch);
  for (const card of GUIDE_CARDS) {
    assert.equal(guide.data.previewOpen, false);
    guide.openPreview({ currentTarget: { dataset: { id: card.id } } });
    assert.equal(guide.data.previewOpen, true);
    assert.equal(guide.data.selectedId, card.id);
    assert.equal(targets.length, 0);
    await guide.tryDemo();
    assert.equal(guide.data.previewOpen, false);
    const url = targets.pop();
    assert.ok(url.startsWith('/pages/guide-demo/' + demo.FEATURES[card.id].scene + '?'));
    const query = new URL('https://example.invalid' + url).searchParams;
    const value = demo.getSession(query.get('demoSession'));
    created.push(value);
    await value.app.globalData.readyPromise;
    assert.equal(value.feature, card.id);
    assert.ok(value.app.globalData.ready);
  }
});

test('new users receive identical example facts and all real UI scenes reuse the original templates', async () => {
  const first = await session(), second = await session();
  const a = (await first.app.globalData.service.createBackup()).data;
  const b = (await second.app.globalData.service.createBackup()).data;
  assert.deepEqual(a.projects, b.projects);
  assert.deepEqual(a.sessions, b.sessions);
  assert.ok(a.sessions.length > 200);
  for (const name of ['数学', '英语', '阅读', '游泳', '冥想']) assert.ok(a.projects.some(project => project.name === name));
  for (const scene of demo.SCENES) {
    const root = path.join(__dirname, '../pages/guide-demo/' + scene);
    const markup = fs.readFileSync(root + '.wxml','utf8');
    const realMarkup = fs.readFileSync(path.join(__dirname, '../pages/' + scene + '/' + scene + '.wxml'), 'utf8');
    const body = fs.readFileSync(path.join(__dirname, '../pages/' + scene + '/' + scene + '-body.wxml'), 'utf8');
    assert.match(markup, /^<page-meta\b/);
    assert.match(realMarkup, /^<page-meta\b/);
    assert.doesNotMatch(body, /<page-meta\b/);
    assert.ok(markup.includes('src="../' + scene + '/' + scene + '-body.wxml"'));
    assert.ok(realMarkup.includes('src="./' + scene + '-body.wxml"'));
    assert.ok(fs.readFileSync(root + '.wxss','utf8').includes('@import "../' + scene + '/' + scene + '.wxss"'));
  }
  const stats = await first.app.globalData.service.getStatistics({ preset: 'last7' });
  assert.equal(stats.data.dailySeries.at(-1).date, demo.TODAY);
  assert.ok(stats.data.totalSeconds > 0);
});

test('every demo scene shows a visible loading state and a recoverable error state', () => {
  for (const scene of demo.SCENES) {
    const markup = fs.readFileSync(path.join(__dirname, '../pages/guide-demo/' + scene + '.wxml'), 'utf8');
    assert.match(markup, /wx:elif="\{\{!demoReady && !demoError\}\}"/);
    assert.match(markup, /正在准备演示/);
    assert.match(markup, /wx:else class="demo-loading demo-loading-error"/);
    assert.match(markup, /bindtap="exitDemo"/);
  }
  const styles = fs.readFileSync(path.join(__dirname, '../pages/guide-demo/scene.wxss'), 'utf8');
  assert.match(styles, /demo-loading-card/);
  assert.match(styles, /demo-loading-spin/);
});

test('project edits, timer controls and settings in the actual UI only modify the demonstration', async () => {
  const control = createService(createMemoryAdapter());
  await control.init();
  const before = (await control.createBackup()).data;
  const beforePrefs = await control.getPrefs();
  const value = await session('runtime');
  const service = value.app.globalData.service;
  assert.equal((await service.renameProject({ operationId:'demo-rename', projectId:value.projectIds.reading, name:'阅读示例' })).ok, true);
  const active = (await service.getCurrent()).data;
  assert.equal(active.state, 'PAUSED');
  assert.equal((await service.resume({ operationId:'demo-resume', sessionId:active.sessionId })).ok, true);
  assert.equal((await service.pause({ operationId:'demo-pause', sessionId:active.sessionId })).ok, true);
  const { prepareDefinition } = require('../utils/demo-scene');
  const page = prepareDefinition('settings-detail', value);
  page.data = structuredClone(page.data);
  page.setData = (patch, done) => { Object.assign(page.data, patch); if (done) done(); };
  page.onLoad({ section:'stats' });
  await page.loadPrefs();
  await page.save({ dailyGoalMinutes: 150, theme:'dark' });
  assert.equal((await service.getPrefs()).dailyGoalMinutes, 150);
  assert.equal((await service.getPrefs()).theme, 'dark');
  assert.deepEqual((await control.createBackup()).data.projects, before.projects);
  assert.deepEqual((await control.createBackup()).data.sessions, before.sessions);
  assert.deepEqual(await control.getPrefs(), beforePrefs);
  const other = await session();
  assert.equal((await other.app.globalData.service.getPrefs()).dailyGoalMinutes, 120);
});

test('component data and drill-down navigation remain inside the same example space', async () => {
  const value = await session('timeline');
  const component = { properties: { demoSession: value.id } };
  assert.equal(demo.appFor(component), value.app);
  assert.equal(demo.todayFor(component), demo.TODAY);
  assert.throws(() => demo.appFor({ properties: { demoSession:'expired' } }), /演示已结束/);
  let url;
  global.wx.navigateTo = options => { url=options.url; if (options.complete) options.complete(); };
  demo.navigateFor(component, { url:'/pages/day-stats/day-stats?date=2026-10-15&scope=' + value.projectIds.math });
  assert.ok(url.startsWith('/pages/guide-demo/day-stats?'));
  assert.ok(url.includes('demoSession=' + value.id));
  assert.ok(url.includes('scope=' + value.projectIds.math));
  url = '';
  demo.navigateFor(component, { url:'/pages/account/account' });
  assert.equal(url, '');
});

test('the original statistics and detail handlers render complete records from the same demonstration', async () => {
  const value = await session('stats');
  const { prepareDefinition } = require('../utils/demo-scene');
  global.getCurrentPages = () => [{ route:'pages/guide/guide' }, { route:'pages/guide-demo/stats' }];
  const make = (scene, options) => {
    const page = prepareDefinition(scene, value);
    page.data = structuredClone(page.data);
    page.setData = (patch, done) => { Object.assign(page.data, patch); if (done) done(); };
    page.selectComponent = () => null;
    page.onLoad(options || {});
    return page;
  };
  const stats = make('stats');
  await stats.onShow();
  assert.ok(stats.data.distRows.length > 0);
  assert.ok(stats.data.timeSlots.some(slot => slot.averageSeconds > 0 || slot.seconds > 0 || slot.height > 0));
  const project = make('project-stats', { id:value.projectIds.math, preset:'last7' });
  await project.load();
  assert.equal(project.data.name,'数学');
  assert.ok(project.data.listRows.length >= 2);
  const day = make('day-stats', { date:demo.TODAY });
  await day.load();
  assert.ok(day.data.rows.length > 0);
  const manage = make('manage');
  await manage.load();
  assert.equal(manage.data.active.length,10);
  assert.ok(manage.data.visibleRows.length > 0);
});

test('the demo page lifecycle stops the real focus ticker and returns to the guide', async () => {
  const value = await session('runtime');
  const wrapper = require('../utils/demo-scene').create('focus');
  const page = Object.assign({}, wrapper, { data: structuredClone(wrapper.data) });
  page.setData = (patch, done) => { Object.assign(page.data, patch); if (done) done(); };
  page.selectComponent = () => null;
  global.getCurrentPages = () => [{ route:'pages/guide/guide' }, page];
  try {
    page.onLoad({ demoSession:value.id, entry:'runtime' });
    page.onShow();
    page.onReady();
    await page.demoBoot;
    assert.equal(page.runtimeApp, value.app);
    assert.equal(page.data.demoReady, true);
    assert.equal(page.data.cur.state, 'PAUSED');
    await page.onResume();
    assert.ok(page.timer);
    page.onHide();
    assert.equal(page.timer, null);
    let delta;
    global.wx.navigateBack = options => { delta=options.delta; };
    page.exitDemo();
    assert.equal(delta, 1);
  } finally { page.onUnload(); }
});

test('all guide entries reveal populated first frames even when render callbacks are delayed', async () => {
  const { create } = require('../utils/demo-scene');
  global.getCurrentPages = () => [{ route:'pages/guide/guide' }, { route:'pages/guide-demo/test' }];
  for (const [feature, target] of Object.entries(demo.FEATURES)) {
    const value = await session(feature);
    const definition = create(target.scene);
    const page = Object.assign({}, definition, { data:structuredClone(definition.data) });
    let firstFrame;
    page.selectComponent = () => null;
    page.setData = (patch, done) => {
      Object.assign(page.data, patch);
      if (patch.demoReady === true) firstFrame = structuredClone(page.data);
      if (done) setTimeout(done, 2);
    };
    try {
      page.onLoad({ demoSession:value.id, entry:feature, section:target.section });
      page.onShow();
      page.onReady();
      await new Promise(resolve => setTimeout(resolve, 1));
      // onShow may precede completion of the first setData render callback.
      page.onShow();
      assert.equal(page.data.demoReady, false, feature);
      await page.demoBoot;
      assert.equal(page.data.demoError, '', feature);
      assert.ok(firstFrame, feature);
      assert.equal(firstFrame.demoSession, value.id);
      if (target.scene === 'focus') {
        assert.ok(firstFrame.ready && firstFrame.cur, feature);
        assert.equal(firstFrame.cur.state, feature === 'runtime' ? 'PAUSED' : 'IDLE');
        if (feature === 'projects') assert.equal(page.data.pickerOpen, true);
      } else if (target.scene === 'stats') {
        assert.equal(firstFrame.loading, false);
        assert.equal(firstFrame.sumZero, false);
        assert.ok(firstFrame.chartTree.length > 0);
        assert.ok(firstFrame.timeSlots.some(slot => slot.height > 0));
        if (feature === 'timeline') assert.equal(page.data.heatmapOpen, true);
      } else {
        assert.equal(firstFrame.loading, false);
        assert.equal(firstFrame.page, target.section);
      }
    } finally { page.onHide(); page.onUnload(); }
  }
});

test('actual project and heatmap components load populated samples without accessing the real app', async () => {
  const value = await session('projects');
  function component(file, properties) {
    let definition;
    global.Component = input => { definition = input; };
    delete require.cache[require.resolve(file)];
    require(file);
    delete global.Component;
    const instance = Object.assign({}, definition.methods, { properties, data:structuredClone(definition.data) });
    instance.setData = (patch, done) => { Object.assign(instance.data, patch); if (done) done(); };
    instance.createSelectorQuery = () => ({ select() { return this; }, boundingClientRect() { return this; }, exec() {} });
    return instance;
  }
  const projects = component('../components/project-sheet/project-sheet', {
    demoSession:value.id, opened:true, selected:value.projectIds.calculus, topInset:78, bottomNav:true
  });
  await projects.load();
  assert.equal(projects.data.error, '');
  assert.equal(projects.all.length, 10);
  assert.ok(projects.data.rows.some(row => row.name === '高等数学'));
  assert.ok(projects.data.rows.some(row => row.name === '学习'));
  const heatmap = component('../components/heatmap-card/heatmap-card', {
    demoSession:value.id, opened:true, theme:'light', scopeId:''
  });
  heatmap.seq = 0;
  await heatmap.open();
  assert.equal(heatmap.data.error, '');
  assert.equal(heatmap.data.loading, false);
  assert.ok(heatmap.data.grid.flat().some(cell => cell.seconds > 0));
  assert.ok(heatmap.data.activeDays > 0);
});

test('a lost mount callback cannot stall the populated page or automatic feature entry', async () => {
  const value = await session('projects');
  const definition = require('../utils/demo-scene').create('focus');
  const page = Object.assign({}, definition, { data:structuredClone(definition.data) });
  page.selectComponent = () => null;
  page.setData = (patch, done) => {
    Object.assign(page.data, patch);
    if (patch.demoReady !== true && done) setTimeout(done, 1);
  };
  global.wx.nextTick = () => {}; // No later view update/user tap to wake this queue.
  global.getCurrentPages = () => [{ route:'pages/guide/guide' }, page];
  try {
    page.onLoad({ demoSession:value.id, entry:'projects' });
    page.onShow();
    page.onReady();
    await page.demoBoot;
    assert.equal(page.data.demoError, '');
    assert.equal(page.data.demoReady, true);
    assert.equal(page.demoMounted, true);
    assert.equal(page.data.pickerOpen, true);
    assert.ok(page.data.cur);
  } finally { page.onHide(); page.onUnload(); }
});
