const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDetail } = require('../utils/detail-navigation');
const { beforeStatsLeave, afterStatsLeave, recordEditorChanged, layerEntered, restoreLayer, isRearming } = require('../utils/modal-history');

function instance(definition) {
  const value = Object.assign({}, definition.methods || definition, { data: structuredClone(definition.data || {}) });
  value.setData = (patch, done) => { Object.assign(value.data, patch); if (done) done(); };
  return value;
}
function component(file) {
  let definition;
  global.Component = value => { definition = value; };
  delete require.cache[require.resolve(file)];
  require(file);
  return instance(definition);
}
test.beforeEach(() => { global.wx = { nextTick: fn => fn(), showToast() {}, setKeepScreenOn() {} }; });
test.afterEach(() => { delete global.wx; delete global.Component; delete global.Page; delete global.getCurrentPages; });

test('a stale native enter while resetting history cannot turn its synthetic leave into a second back', () => {
  const callbacks = [];
  const page = { data: { history: true }, setData(patch, done) { Object.assign(this.data, patch); if (done) callbacks.push(done); } };
  restoreLayer(page, 'history', () => true);
  assert.equal(page.data.history, false);
  layerEntered(page, 'history');
  assert.equal(isRearming(page, 'history'), true);
  callbacks.shift()();
  assert.equal(page.data.history, true);
  layerEntered(page, 'history');
  assert.equal(isRearming(page, 'history'), false);
});

test('one native back closes heatmap scope first, preserving the month, project and covered chart', () => {
  const card = component('../components/heatmap-card/heatmap-card');
  card.setData({ scopePickerOpen: true, scopeQuery: '数学', monthKey: '2026-09', scopeName: '学习' });
  const page = instance({ data: { heatmapOpen: true, chartObscured: true, overlayHistoryEnabled: true } });
  page.pageOverlayKind = 'heatmap';
  page.selectComponent = selector => selector === '#heatmapCard' ? card : null;
  beforeStatsLeave(page); afterStatsLeave(page);
  assert.equal(card.data.scopePickerOpen, false);
  assert.equal(card.data.monthKey, '2026-09');
  assert.equal(card.data.scopeName, '学习');
  assert.equal(page.data.heatmapOpen, true);
  assert.equal(page.data.chartObscured, true);
  assert.equal(page.data.overlayHistoryEnabled, true);
  beforeStatsLeave(page); afterStatsLeave(page); // Ignore the synthetic close while re-arming.
  assert.equal(page.data.heatmapOpen, true);
  layerEntered(page, 'overlayHistoryEnabled');
  beforeStatsLeave(page); afterStatsLeave(page);
  assert.equal(page.data.heatmapOpen, false);
  assert.equal(page.data.chartObscured, false);
});

test('record adjustment returns to the same records and busy saves keep their back layer', () => {
  const detail = component('../components/day-detail/day-detail');
  detail.setData({ reductionOpen: true, recordReducing: true, recordManaging: true });
  detail.reductionContext = { row: { id: 'record' } };
  const page = instance({ data: { recordEditorOpen: true, overlayHistoryEnabled: true, selectedDate: '2026-10-26' } });
  page.pageOverlayKind = 'records';
  page.selectComponent = selector => selector === '#dayDetail' ? detail : null;
  detail.triggerEvent = (name, event) => { if (name === 'editorchange') recordEditorChanged(page, { detail: event }); };
  beforeStatsLeave(page); afterStatsLeave(page);
  assert.equal(page.data.recordEditorOpen, true);
  assert.equal(page.data.overlayHistoryEnabled, true);
  assert.ok(detail.reductionContext);
  layerEntered(page, 'overlayHistoryEnabled');
  detail.setData({ recordReducing: false });
  beforeStatsLeave(page); afterStatsLeave(page);
  assert.equal(page.data.recordEditorOpen, false);
  assert.equal(detail.data.reductionOpen, false);
  assert.equal(detail.data.recordManaging, true);
  assert.equal(page.data.selectedDate, '2026-10-26');
});

test('custom date cancellation preserves applied statistics filters and its selected project', () => {
  const page = instance(require('../pages/project-stats/project-stats-definition')({ globalData: {} }));
  page.setData({ rangeOpen: true, preset: 'last7', projectId: 'math', startDate: '2026-10-20', endDate: '2026-10-26' });
  page.pageOverlayKind = 'range';
  beforeStatsLeave(page); afterStatsLeave(page);
  assert.equal(page.data.rangeOpen, false);
  assert.equal(page.data.preset, 'last7');
  assert.equal(page.data.projectId, 'math');
  assert.equal(page.data.startDate, '2026-10-20');
  assert.equal(page.data.endDate, '2026-10-26');
});

test('focus back cancels custom time without applying it, then dismisses nested project creation only', () => {
  const page = instance(require('../pages/focus/focus-definition')({ globalData: {} }));
  page.updateTabVisibility = () => {};
  page.selectComponent = () => null;
  page.setData({ targetSeconds: 1800, customOpen: true, customMinutes: '90' });
  page.onPickerAfterLeave();
  assert.equal(page.data.customOpen, false);
  assert.equal(page.data.targetSeconds, 1800);
  const picker = { close() { this.newOpen = false; }, newOpen: true };
  page.selectComponent = selector => selector === '#projectSheet' ? picker : null;
  page.setData({ pickerOpen: true });
  page.onPickerAfterLeave();
  assert.equal(picker.newOpen, false);
  assert.equal(page.data.pickerOpen, true);
  assert.equal(page.data.focusHistoryEnabled, true);
});

test('top back buttons dismiss heatmap and record editors before leaving their page', () => {
  let exits = 0;
  global.wx.navigateBack = () => { exits++; };
  const page = instance(require('../pages/project-stats/project-stats-definition')({ globalData: {} }));
  const card = component('../components/heatmap-card/heatmap-card');
  card.setData({ scopePickerOpen: true });
  card.triggerEvent = name => { if (name === 'close') page.closeHeatmap(); };
  page.selectComponent = selector => selector === '#heatmapCard' ? card : null;
  page.setData({ heatmapOpen: true });
  page.back(); assert.equal(card.data.scopePickerOpen, false); assert.equal(page.data.heatmapOpen, true);
  page.back(); assert.equal(page.data.heatmapOpen, false); assert.equal(exits, 0);
  page.back(); assert.equal(exits, 1);
});

function navigationFixture(stack) {
  const pushed = [], backs = [];
  global.getCurrentPages = () => stack;
  global.wx.navigateBack = options => { backs.push(options.delta); options.complete(); };
  return { pushed, backs, navigation: { navigateTo: options => { pushed.push(options); } } };
}
test('returning to an existing project with identical filters reuses its page and retained state', () => {
  const parent = { route: 'pages/project-stats/project-stats', data: { projectId: 'parent', preset: 'custom', mode: 'completed', startDate: '2026-10-01', endDate: '2026-10-20' }, scroll: 200 };
  const child = { route: 'pages/project-stats/project-stats', data: { projectId: 'child' } };
  const { navigation, pushed, backs } = navigationFixture([parent, child]);
  openDetail(child, navigation, '/pages/project-stats/project-stats?id=parent&preset=custom&mode=completed&startDate=2026-10-01&endDate=2026-10-20');
  assert.deepEqual(backs, [1]); assert.equal(pushed.length, 0); assert.equal(parent.scroll, 200);
});
test('different filters, a different demonstration, and an editor origin each keep a separate detail page', () => {
  for (const condition of ['range', 'demo', 'editor']) {
    const parent = { route: 'pages/project-stats/project-stats', data: { projectId: 'parent', preset: 'last30', mode: condition === 'range' ? 'completed' : 'realtime' } };
    const origin = { route: 'pages/project-stats/project-stats', data: {} };
    if (condition === 'demo') { origin.demoSession = 'guide-1'; parent.demoSession = 'guide-2'; parent.route = 'pages/guide-demo/project-stats'; }
    if (condition === 'editor') origin.data.editorOpen = true;
    const { navigation, pushed, backs } = navigationFixture([parent, origin]);
    openDetail(origin, navigation, '/pages/project-stats/project-stats?id=parent');
    assert.equal(backs.length, 0, condition); assert.equal(pushed.length, 1, condition);
  }
});

test('a matching earlier detail with its own unfinished modal is preserved rather than reused', () => {
  for (const key of ['heatmapOpen', 'editorOpen', 'scopeOpen', 'rangeOpen', 'recordEditorOpen']) {
    const parent = { route: 'pages/project-stats/project-stats', data: { projectId: 'parent', preset: 'last30', mode: 'realtime', [key]: true } };
    const origin = { route: 'pages/project-stats/project-stats', data: { projectId: 'child' } };
    const { navigation, pushed, backs } = navigationFixture([parent, origin]);
    openDetail(origin, navigation, '/pages/project-stats/project-stats?id=parent');
    assert.equal(backs.length, 0, key);
    assert.equal(pushed.length, 1, key);
    assert.equal(parent.data[key], true);
  }
});

test('standalone project selection is wired through to the selected value and one return', () => {
  let definition, exits = 0;
  global.Page = value => { definition = value; };
  global.wx.navigateBack = () => { exits++; };
  delete require.cache[require.resolve('../pages/picker/picker')];
  require('../pages/picker/picker');
  const page = instance(definition);
  const markup = fs.readFileSync(path.resolve(__dirname, '../pages/picker/picker.wxml'), 'utf8');
  const binding = markup.match(/<project-sheet\b[^>]*\bbindselected="([^"]+)"/);
  assert.ok(binding, 'component selection must be forwarded to its owner');
  page[binding[1]]({ detail: { projectId: 'selected-project' } });
  assert.equal(page.data.selected, 'selected-project');
  assert.equal(exits, 1);
});
test('rapid detail taps create one page, and completing or failing navigation permits a later retry', () => {
  const origin = { route: 'pages/stats/stats', data: {} };
  const { navigation, pushed } = navigationFixture([origin]);
  const url = '/pages/day-stats/day-stats?date=2026-10-26';
  openDetail(origin, navigation, url); openDetail(origin, navigation, url);
  assert.equal(pushed.length, 1);
  pushed[0].fail(); pushed[0].complete();
  openDetail(origin, navigation, url); assert.equal(pushed.length, 2);
});

test('each reachable page has one owner for native modal back history', () => {
  const root = path.resolve(__dirname, '..');
  function markup(file) { return fs.readFileSync(file, 'utf8').replace(/<include\s+src="([^"]+)"\s*\/?>/g, (_, ref) => markup(path.resolve(path.dirname(file), ref))); }
  function count(base, seen = new Set()) {
    if (seen.has(base)) return 0;
    seen.add(base);
    const source = markup(path.join(root, base + '.wxml'));
    let total = (source.match(/<page-container\b/g) || []).length;
    const config = JSON.parse(fs.readFileSync(path.join(root, base + '.json'), 'utf8'));
    for (const [tag, ref] of Object.entries(config.usingComponents || {})) {
      if (!new RegExp('<' + tag + '(?:\\s|/?>)').test(source)) continue;
      const target = ref.startsWith('/') ? ref.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(base), ref));
      total += count(target, seen);
    }
    return total;
  }
  for (const page of require('../app.json').pages) assert.ok(count(page) <= 1, page);
});
