const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadPage(file, app = { globalData: {} }) {
  let definition;
  global.getApp = () => app;
  global.Page = value => { definition = value; };
  delete require.cache[require.resolve(file)];
  require(file);
  const page = Object.assign({}, definition, { data: structuredClone(definition.data) });
  page.setData = (patch, done) => { Object.assign(page.data, patch); if (done) done(); };
  page.selectComponent = () => null;
  return page;
}
test.afterEach(() => {
  for (const key of ['getApp', 'Page', 'Component', 'wx', 'getCurrentPages']) delete global[key];
});

test('all page and component markup handlers exist', () => {
  const root = path.resolve(__dirname, '..');
  let checked = 0;
  function markup(file) {
    return fs.readFileSync(file, 'utf8').replace(/<include\s+src="([^"]+)"\s*\/?>/g,
      (_, ref) => markup(path.resolve(path.dirname(file), ref)));
  }
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!file.endsWith('.wxml')) continue;
      const source = file.slice(0, -5) + '.js';
      if (!fs.existsSync(source)) continue;
      let definition;
      global.getApp = () => ({ globalData: {} });
      global.Page = global.Component = d => { definition = d; };
      delete require.cache[require.resolve(source)];
      require(source);
      const methods = definition.methods || definition;
      for (const match of markup(file).matchAll(/\b(?:bind|catch|capture-bind|capture-catch):?[\w-]+\s*=\s*"([A-Za-z_$][\w$]*)"/g)) {
        assert.equal(typeof methods[match[1]], 'function', path.relative(root, file) + ': ' + match[1]);
        checked++;
      }
    }
  }
  walk(path.join(root, 'pages')); walk(path.join(root, 'components'));
  assert.ok(checked > 200);
});

test('navigation height updates occur after component mounting and coalesce repeated measurements', async () => {
  let definition;
  global.Component = value => { definition = value; };
  global.wx = { getWindowInfo: () => ({ windowWidth:390, statusBarHeight:44 }) };
  delete require.cache[require.resolve('../components/safe-nav/safe-nav')];
  require('../components/safe-nav/safe-nav');
  const updates = [];
  const component = Object.assign({}, definition.methods, {
    properties:{ theme:'light' }, data:structuredClone(definition.data),
    triggerEvent: (name, value) => updates.push({ name, value })
  });
  component.setData = patch => Object.assign(component.data, patch);
  definition.lifetimes.attached.call(component);
  definition.lifetimes.ready.call(component);
  assert.equal(updates.length, 0, 'parent cannot update recursively during mounting');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].name, 'heightchange');
  component.measure();
  definition.lifetimes.detached.call(component);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(updates.length, 1);
});

test('main navigation switches tabs without stacking main screens', () => {
  const { openMainTab } = require('../utils/main-navigation');
  assert.deepEqual(require('../app.json').tabBar.list.map(item => item.pagePath), [
    'pages/focus/focus', 'pages/stats/stats', 'pages/settings/settings'
  ]);
  const calls = [];
  global.getCurrentPages = () => [{ route: 'pages/focus/focus' }, { route: 'pages/stats/stats' }];
  global.wx = { switchTab: o => calls.push(['tab', o.url]) };
  openMainTab(2);
  assert.deepEqual(calls.pop(), ['tab', '/pages/settings/settings']);
  global.getCurrentPages = () => [{ route: 'pages/focus/focus' }, { route: 'pages/stats/stats' }, { route: 'pages/settings/settings' }];
  openMainTab(1); assert.deepEqual(calls.pop(), ['tab', '/pages/stats/stats']);
  openMainTab(0); assert.deepEqual(calls.pop(), ['tab', '/pages/focus/focus']);
  openMainTab(2); openMainTab(99); assert.equal(calls.length, 0);
});

test('leaving focus stops the rest ticker and invalidates pending refresh', () => {
  const page = loadPage('../pages/focus/focus');
  let stopped = 0;
  page.stopTick = () => {};
  page.stopRestTick = () => { stopped++; };
  global.wx = { setKeepScreenOn() {} };
  page.visible = true;
  page.refreshVersion = 4;
  page.onHide();
  assert.equal(page.visible, false);
  assert.equal(page.refreshVersion, 5);
  assert.equal(stopped, 1);
});

test('a focus query completing after navigation cannot render stale state', async () => {
  let release;
  const page = loadPage('../pages/focus/focus', { globalData: { service: {
    getPrefs: () => new Promise(resolve => { release = resolve; }),
    getCurrent: () => { throw new Error('hidden page should not continue its refresh'); }
  } } });
  page.visible = true;
  const pending = page.refresh();
  page.visible = false;
  page.refreshVersion++;
  release({ keepScreenOn: true });
  await pending;
  assert.equal(page.data.keepScreenOn, false);
});

test('returning to statistics retains custom filters and refreshes daily details', async () => {
  let loaded = 0, detailLoaded = 0;
  const page = loadPage('../pages/stats/stats', { globalData: { ready: true, readyPromise: Promise.resolve(), service: { getPrefs: async () => ({ statsPreset: 'today', theme: 'light' }) } } });
  global.wx = { setNavigationBarColor() {} };
  page.hasShown = true;
  page.data.preset = 'custom'; page.data.startDate = '2026-09-01'; page.data.endDate = '2026-09-30';
  page.load = async () => { loaded++; };
  page.selectComponent = () => ({ load: async () => { detailLoaded++; } });
  await page.onShow();
  assert.equal(page.data.preset, 'custom'); assert.equal(page.data.startDate, '2026-09-01');
  assert.equal(loaded, 1); assert.equal(detailLoaded, 1);
});

test('heatmap opens over the current page and preserves project scope', () => {
  const events = [];
  const host = { data: { projectId: 'project/a', heatmapOpen: false, chartObscured: false },
    setData(patch, done) { Object.assign(this.data, patch); if (done) done(); },
    selectComponent() { return null; },
    triggerEvent(name, detail) { events.push([name, detail]); } };
  require('../utils/heatmap-modal').openHeatmap.call(host);
  assert.equal(host.data.heatmapOpen, true);
  assert.equal(host.data.chartObscured, false);
  assert.equal(host.openingHeatmap, false);
  assert.deepEqual(events.pop(), ['navhiddenchange', { hidden: true }]);
  require('../utils/heatmap-modal').afterHeatmapLeave.call(host);
  assert.equal(host.data.heatmapOpen, false);
});

test('rapid subject and heatmap taps cannot compete for the same chart snapshot', () => {
  let captured = 0;
  const host = { data: { heatmapOpen:false, scopeOpen:false, chartObscured:false }, openingSubjectPicker:true,
    selectComponent() { return { captureSnapshot() { captured++; } }; } };
  require('../utils/heatmap-modal').openHeatmap.call(host);
  assert.equal(captured, 0);
  const page = loadPage('../pages/stats/stats');
  page.openingHeatmap = true;
  page.selectComponent = host.selectComponent;
  page.openSubjects();
  assert.equal(captured, 0);
  assert.equal(page.data.scopeOpen, false);
});

test('an unavailable chart snapshot times out and ignores late platform completion', () => {
  let definition, timeout, pending;
  const nativeSetTimeout=global.setTimeout,nativeClearTimeout=global.clearTimeout;
  global.Component = value => { definition=value; };
  delete require.cache[require.resolve('../components/stat-donut/stat-donut')];
  require('../components/stat-donut/stat-donut');
  const chart=Object.assign({},definition.methods,{ready:true,data:structuredClone(definition.data),properties:{obscured:false},canvas:{}});
  chart.setData=(patch,done)=>{Object.assign(chart.data,patch);if(done)done();};
  global.setTimeout=callback=>{timeout=callback;return 1;};
  global.clearTimeout=()=>{};
  const results=[];
  try {
    chart.captureSnapshot(ready=>results.push(ready));
    assert.equal(chart.waitingSnapshot,true);
    timeout();
    assert.deepEqual(results,[false]);
    chart.data.drawReady=true;
    global.wx={canvasToTempFilePath(options){pending=options;}};
    chart.captureSnapshot(ready=>results.push(ready));
    timeout();
    pending.success({tempFilePath:'late-snapshot.png'});
    assert.deepEqual(results,[false,false]);
    assert.equal(chart.data.snapshotPath,'');
    assert.equal(chart.pendingSnapshotCallback,null);
  } finally {global.setTimeout=nativeSetTimeout;global.clearTimeout=nativeClearTimeout;}
});

test('rapid load-more taps cannot skip records, and failed pages can retry', async () => {
  const requests = [], pending = [];
  const page = loadPage('../pages/records/records', { globalData: { service: {
    getRecords: async spec => { requests.push(spec.page); return new Promise(resolve => pending.push(resolve)); }
  } } });
  global.wx = { showToast() {} };
  page.race = require('../utils/race').createRace();
  Object.assign(page.data, { date: '2026-10-16', hasMore: true, page: 1 });
  page.loadMore(); page.loadMore();
  assert.deepEqual(requests, [2]);
  pending.shift()({ ok: false, error: { message: 'offline' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.page, 1);
  page.loadMore();
  assert.deepEqual(requests, [2, 2]);
  pending.shift()({ ok: false, error: { message: 'offline' } });
  await new Promise(resolve => setImmediate(resolve));
});

test('completion deferred during navigation is presented once without recounting', async () => {
  let rounds = 3, releaseRound, modalCount = 0, available = true;
  const page = loadPage('../pages/focus/focus', { globalData: {
    service: { getPrefs: async () => ({ restEnabled: false }), takeNotices: () => { if (!available) return []; available = false; return [{ durationSeconds: 60 }]; } },
    adapter: { get: () => new Promise(resolve => { releaseRound = resolve; }), set: async (key, value) => { rounds = value; } }
  } });
  global.wx = { showModal: () => { modalCount++; } };
  page.visible = true;
  const pending = page.consumeNotices();
  await new Promise(resolve => setImmediate(resolve));
  page.visible = false; releaseRound(rounds); await pending;
  assert.equal(modalCount, 0); assert.equal(rounds, 4);
  page.visible = true; await page.consumeNotices();
  assert.equal(modalCount, 1); assert.equal(rounds, 4); assert.equal(page.pendingCompletion, null);
});

test('cold focus initialization restores a saved break after storage is ready', async () => {
  let ready, restored = 0, refreshed = 0;
  const app = { globalData: {
    readyPromise: new Promise(resolve => { ready = resolve; }),
    accounts: { getCurrent: () => ({ id: 'existing' }), getStatus: () => ({ state: 'synced' }) },
    service: { peekCurrent: () => ({ ok: true, data: { state: 'IDLE' } }) }
  } };
  const page = loadPage('../pages/focus/focus', app);
  page.visible = true;
  page.watchAccountSaving = () => {};
  page.restoreRest = () => { restored++; };
  page.refresh = () => { refreshed++; };
  page.onLoad({});
  assert.equal(restored, 0);
  ready(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored, 1); assert.equal(refreshed, 1);
});

test('repeated heatmap scope opening shares the in-flight project query', async () => {
  let definition, ready, calls = 0;
  global.Component = value => { definition = value; };
  global.getApp = () => ({ globalData: {
    readyPromise: new Promise(resolve => { ready = resolve; }),
    service: { getManageData: async () => { calls++; return { ok: true, data: { active: [], archived: [] } }; } }
  } });
  // Keep the same app and readiness promise across both requests.
  const app = getApp(); global.getApp = () => app;
  delete require.cache[require.resolve('../components/heatmap-card/heatmap-card')];
  require('../components/heatmap-card/heatmap-card');
  const card = Object.assign({}, definition.methods, { attachedReady: true, data: structuredClone(definition.data) });
  card.setData = (patch, done) => { Object.assign(card.data, patch); if (done) done(); };
  const first = card.loadScopeOptions(); const second = card.loadScopeOptions();
  ready(); await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(card.data.scopeLoading, false);
});
