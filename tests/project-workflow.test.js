const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../core/service');
const { createMemoryAdapter } = require('../storage/adapter');
const { createAccountAdapter } = require('../storage/account-adapter');
const { uuid } = require('../core/ids');
const local = require('../sync/local');
const demo = require('../utils/demo-context');
const event = id => ({ currentTarget: { dataset: { id } } });
const sessions = [];

test.beforeEach(() => {
  global.wx = { showToast() {}, getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844 }), nextTick: fn => fn(), pageScrollTo() {} };
  global.getApp = () => { throw Error('Tests must never access a real account'); };
});
test.afterEach(() => { delete global.wx; delete global.getApp; delete global.Component; });
test.after(() => sessions.forEach(session => demo.release(session)));

async function scene() {
  const session = demo.createSession('projects');
  sessions.push(session);
  await session.app.globalData.readyPromise;
  return session;
}
async function picker(session) {
  let definition;
  global.Component = value => { definition = value; };
  delete require.cache[require.resolve('../components/project-sheet/project-sheet')];
  require('../components/project-sheet/project-sheet');
  const changes = [];
  const component = Object.assign({}, definition.methods, {
    properties: { demoSession: session.id, opened: true, selected: session.projectIds.calculus, topInset: 78, bottomNav: true },
    data: structuredClone(definition.data), triggerEvent: (name, data) => changes.push({ name, data })
  });
  component.setData = patch => Object.assign(component.data, patch);
  await component.load();
  return { component, changes };
}
function manage(session) {
  const navigation = [];
  const definition = require('../pages/manage/manage-definition')(session.app, { platform: { navigateTo: value => navigation.push(value.url) } });
  const page = Object.assign({}, definition, { data: structuredClone(definition.data) });
  page.setData = (patch, done) => { Object.assign(page.data, patch); if (done) done(); };
  return { page, navigation };
}

test('project picker expands every branch, selects only leaves, and never selects while organizing', async () => {
  const session = await scene(), { component: c, changes } = await picker(session);
  const branch = c.all.find(row => row.parentId && c.childCounts[row.projectId]);
  assert.ok(branch, 'fixture includes an intermediate branch');
  c.rowTap(event(branch.projectId));
  assert.equal(c.collapsed[branch.projectId], true);
  c.rowTap(event(branch.projectId));
  assert.equal(c.collapsed[branch.projectId], false);
  assert.equal(changes.length, 0);
  c.toggleOrganize();
  await c.rowTap(event(session.projectIds.calculus));
  assert.equal(changes.length, 0);
  assert.equal(await c.select(branch.projectId), false);
  c.toggleOrganize();
  await c.rowTap(event(session.projectIds.calculus));
  assert.deepEqual(changes, [{ name: 'selected', data: { projectId: session.projectIds.calculus } }]);
});

test('picker adds and deletes in place, preserves organization and scroll, and clears deleted selection', async () => {
  const session = await scene(), { component: c, changes } = await picker(session);
  c.toggleOrganize();
  c.onListScroll({ detail: { scrollTop: 97 } });
  const parent = c.all.find(row => c.childCounts[row.projectId]);
  c.newProject(event(parent.projectId));
  assert.equal(c.data.editorId, parent.projectId);
  assert.equal(c.data.newOpen, true);
  c.inputName({ detail: { value: '新建的示例子项目' } });
  await c.create();
  const created = c.byId[c.data.createdId];
  assert.equal(created.name, '新建的示例子项目');
  assert.equal(created.parentId, parent.projectId);
  assert.equal(c.collapsed[parent.projectId], false);
  assert.equal(c.data.listScrollTop, 97);
  assert.equal(c.data.organizing, true);
  assert.equal(changes.filter(change => change.name === 'selected').length, 0);
  c.properties.selected = created.projectId;
  await session.app.globalData.service.savePrefs({ lastProjectId: created.projectId });
  await c.askDelete(event(created.projectId));
  assert.equal(c.data.editorMode, 'delete');
  assert.match(c.data.deleteText, /1 个项目和 0 条/);
  await c.confirmDelete();
  assert.equal(c.byId[created.projectId], undefined);
  assert.equal((await session.app.globalData.service.getPrefs()).lastProjectId, null);
  assert.equal(c.data.organizing, true);
});

test('picker editors stay within short phone and tablet windows', async () => {
  const session = await scene(), { component: c } = await picker(session);
  for (const info of [{ windowWidth: 320, windowHeight: 568 }, { windowWidth: 932, windowHeight: 430 }, { windowWidth: 1024, windowHeight: 768 }]) {
    global.wx.getWindowInfo = () => info;
    c.measureLayout();
    c.newProject(event(''));
    assert.ok(c.data.cardHeight <= c.data.cardMaxHeight);
    assert.ok(c.data.bodyHeight > 0);
    assert.equal(c.data.editorMode, 'create');
    c.cancelNew();
  }
});

test('management opens an editor, creates under a branch, saves all fields and keeps statistics explicit', async () => {
  const session = await scene(), { page, navigation } = manage(session);
  await page.load();
  const row = page.data.active.find(row => row.startable);
  page.openEditor(event(row.projectId));
  assert.equal(page.data.editorOpen, true);
  assert.equal(navigation.length, 0);
  page.inputEditorName({ detail: { value: '重新整理的示例项目' } });
  page.inputEditorShortName({ detail: { value: '示例' } });
  page.chooseEditorColor({ currentTarget: { dataset: { color: '#3976C5' } } });
  await page.saveEditor();
  const saved = page.findRow(row.projectId);
  assert.equal(saved.name, '重新整理的示例项目');
  assert.equal(saved.shortName, '示例');
  assert.equal(saved.color, '#3976C5');
  assert.equal(saved.parentId, row.parentId);
  page.openEditor(event(row.projectId));
  page.editorStats();
  assert.match(navigation[0], /project-stats/);
  page.editorAddChild();
  assert.equal(page.data.editorKind, 'create');
  assert.equal(page.data.parentOptions[page.data.parentIndex].projectId, row.projectId);
  page.inputEditorName({ detail: { value: '管理页添加的下级' } });
  await page.saveEditor();
  const child = page.data.active.find(row => row.name === '管理页添加的下级');
  assert.equal(child.parentId, row.projectId);
  assert.ok(page.data.visibleRows.some(row => row.projectId === child.projectId));
});

test('normal scrolling cannot start sorting and invalid custom colors keep the draft open', async () => {
  const session = await scene(), { page } = manage(session);
  await page.load();
  page.sortLongPress(event(page.data.active[0].projectId));
  assert.equal(page.data.draggingId, '');
  page.toggleSorting();
  assert.equal(page.data.sorting, true);
  page.toggleSearch();
  assert.equal(page.data.sorting, false);
  page.openEditor(event(page.data.active[0].projectId));
  const original = page.data.active[0].name;
  page.inputEditorName({ detail: { value: '这个草稿不能部分保存' } });
  page.inputEditorHex({ detail: { value: '#nope' } });
  await page.saveEditor();
  assert.equal(page.data.editorOpen, true);
  assert.equal(page.findRow(page.data.editorId).name, original);
});

test('canceling a nested child editor restores every parent draft and its scroll without closing editing', async () => {
  const session = await scene(), { page } = manage(session);
  await page.load();
  const row = page.data.active.find(row => row.startable);
  page.openEditor(event(row.projectId));
  page.inputEditorName({ detail: { value: '还没保存的父项名称' } });
  page.inputEditorShortName({ detail: { value: '草稿' } });
  page.chooseEditorColor({ currentTarget: { dataset: { color: '#3976C5' } } });
  page.toggleEditorPalette();
  page.editorScrolled({ detail: { scrollTop: 112 } });
  for (const cancel of ['closeEditor', 'onEditorHistoryLeave']) {
    page.editorAddChild();
    assert.equal(page.data.editorNested, true);
    page.inputEditorName({ detail: { value: '决定不添加的下级' } });
    page[cancel]();
    if (cancel === 'onEditorHistoryLeave') {
      page.onEditorHistoryLeave(); // Re-arming may emit its own leave callback.
      assert.equal(page.data.editorKind, 'edit');
      assert.equal(page.data.editorOpen, true);
      page.onEditorHistoryEnter();
    }
    assert.equal(page.data.editorOpen, true);
    assert.equal(page.data.editorKind, 'edit');
    assert.equal(page.data.editorId, row.projectId);
    assert.equal(page.data.editorName, '还没保存的父项名称');
    assert.equal(page.data.editorShortName, '草稿');
    assert.equal(page.data.editorColor, '#3976C5');
    assert.equal(page.data.editorPaletteExpanded, true);
    assert.equal(page.data.editorScrollTop, 112);
  }
  assert.equal(page.findRow(row.projectId).name, row.name);
  assert.equal(page.data.active.length, 10);
  page.onEditorHistoryLeave();
  assert.equal(page.data.editorOpen, false);
});

test('saving a child returns to the unsaved parent and editing preserves the list search', async () => {
  const session = await scene(), { page } = manage(session);
  await page.load();
  const row = page.data.active.find(row => row.startable);
  page.setData({ searchOpen: true, searchQuery: row.name });
  page.openEditor(event(row.projectId));
  page.inputEditorName({ detail: { value: '父项草稿' } });
  page.editorAddChild();
  page.inputEditorName({ detail: { value: '实际添加的下级' } });
  await page.saveEditor();
  assert.equal(page.data.editorOpen, true);
  assert.equal(page.data.editorKind, 'edit');
  assert.equal(page.data.editorName, '父项草稿');
  assert.equal(page.findRow(row.projectId).name, row.name);
  assert.equal(page.data.active.find(p => p.name === '实际添加的下级').parentId, row.projectId);
  assert.equal(page.data.searchQuery, row.name);
  assert.equal(page.data.searchOpen, true);
  await page.saveEditor();
  assert.equal(page.findRow(row.projectId).name, '父项草稿');
  assert.equal(page.data.searchQuery, row.name);
  assert.equal(page.data.searchOpen, true);
});

test('failed child saves keep the parent context, and busy native back cannot discard either layer', async () => {
  const session = await scene(), { page } = manage(session);
  await page.load();
  const row = page.data.active[0];
  page.openEditor(event(row.projectId));
  page.inputEditorName({ detail: { value: '保留这份编辑' } });
  page.editorAddChild();
  page.inputEditorName({ detail: { value: row.name } });
  await page.saveEditor();
  assert.equal(page.data.editorKind, 'create');
  assert.equal(page.editorReturnStack.length, 1);
  page.setData({ editorSaving: true });
  page.onEditorHistoryLeave();
  assert.equal(page.data.editorHistoryOpen, true);
  assert.equal(page.data.editorKind, 'create');
  assert.equal(page.editorReturnStack.length, 1);
  page.setData({ editorSaving: false });
  page.closeEditor();
  assert.equal(page.data.editorName, '保留这份编辑');
  page.setData({ editorSaving: true });
  page.onEditorHistoryLeave();
  assert.equal(page.data.editorOpen, true);
  assert.equal(page.data.editorHistoryOpen, true);
});

test('a child-add tap during reload never inserts a phantom parent editor into history', async () => {
  const session = await scene(), { page } = manage(session);
  await page.load();
  const row = page.data.active[0];
  page.openEditor(event(row.projectId));
  page.setData({ loading: true });
  page.editorAddChild();
  assert.equal(page.data.editorKind, 'edit');
  assert.equal(page.editorReturnStack.length, 0);
  page.setData({ loading: false });
  page.editorAddChild();
  assert.equal(page.editorReturnStack.length, 1);
  page.closeEditor();
  assert.equal(page.data.editorKind, 'edit');
  page.closeEditor();
  assert.equal(page.data.editorOpen, false);
  page.editorAddChild();
  assert.equal(page.data.editorOpen, false);
});

test('native back from picker creation or deletion returns to its organized list only', async () => {
  const session = await scene(), { component: c, changes } = await picker(session);
  c.toggleOrganize();
  c.newProject(event(''));
  c.close();
  assert.equal(c.data.newOpen, false);
  assert.equal(c.data.organizing, true);
  assert.equal(changes.length, 0);
  await c.askDelete(event(session.projectIds.calculus));
  c.close();
  assert.equal(c.data.editorMode, '');
  assert.ok(c.byId[session.projectIds.calculus]);
  assert.equal(changes.length, 0);
});

test('advanced color edits return a draft and cancellation never writes project facts', async () => {
  const session = await scene();
  const { page } = manage(session);
  await page.load();
  const row = page.data.active[0];
  const definition = require('../pages/project-appearance/project-appearance-definition')(session.app);
  const appearance = Object.assign({}, definition, { data: structuredClone(definition.data) });
  appearance.setData = patch => Object.assign(appearance.data, patch);
  let returned, closed = false;
  appearance.getOpenerEventChannel = () => ({ emit: (name, data) => { assert.equal(name, 'appearanceSelected'); returned = data; } });
  appearance.closeAppearance = () => { closed = true; };
  await appearance.onLoad({ id: row.projectId, draft: '1', color: '%233976C5', shortName: encodeURIComponent('草稿') });
  assert.equal(appearance.data.appearanceColor, '#3976C5');
  appearance.chooseAppearanceColor({ currentTarget: { dataset: { color: '#C64458' } } });
  await appearance.saveAppearance();
  assert.equal(closed, true);
  assert.deepEqual(returned, { color: '#C64458', shortName: '草稿' });
  const actual = (await session.app.globalData.service.getManageData()).data.active.find(p => p.projectId === row.projectId);
  assert.equal(actual.color, row.color);
  assert.equal(actual.shortName, row.shortName);
});

test('interrupted project editor commits recover together and retry returns the saved project', async () => {
  const adapter = createMemoryAdapter();
  let service = createService(adapter);
  await service.init();
  const p = (await service.createProject({ operationId: uuid(), name: '待编辑项目' })).data.project;
  const input = { operationId: uuid(), projectId: p.id, name: '完整恢复', color: '#3976C5', shortName: '恢复' };
  adapter.inject(key => key === 'yotick/projects', 2, new Error('interrupted write'), 'set');
  assert.equal((await service.updateProjectDetails(input)).ok, false);
  service = createService(adapter);
  assert.equal((await service.init()).ok, true);
  const recovered = await service.updateProjectDetails(input);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.data.recovered, true);
  assert.equal(recovered.data.project.name, input.name);
  assert.equal(recovered.data.project.color, input.color);
  assert.equal(recovered.data.project.shortName, input.shortName);
});

test('project details commit atomically, preserve records, and queue one compatible cloud patch', async () => {
  const raw = createMemoryAdapter(), adapter = createAccountAdapter(raw, 'editor-test');
  await adapter.set(local.STATE, { spaceId: uuid(), userId: uuid(), generation: '1', nextOrder: 0 });
  let now = 1800000000;
  const service = createService(adapter, { clock: () => now });
  await service.init();
  const p = (await service.createProject({ operationId: uuid(), name: '原项目' })).data.project;
  const started = await service.start({ operationId: uuid(), projectId: p.id });
  now += 60;
  await service.stop({ operationId: uuid(), sessionId: started.data.sessionId });
  const before = (await service.createBackup()).data.sessions;
  const bad = await service.updateProjectDetails({ operationId: uuid(), projectId: p.id, name: '不应保存', color: '#bad', shortName: '简称' });
  assert.equal(bad.ok, false);
  assert.equal((await service.getManageData()).data.active[0].name, '原项目');
  const id = uuid();
  const saved = await service.updateProjectDetails({ operationId: id, projectId: p.id, name: '新名称', shortName: '新简称', color: '#3976c5' });
  assert.equal(saved.ok, true);
  assert.equal(saved.data.project.color, '#3976C5');
  assert.equal((await service.updateProjectDetails({ operationId: id, projectId: p.id, name: '新名称', shortName: '新简称', color: '#3976c5' })).ok, true);
  const patches = (await local.pending(adapter)).filter(task => task.kind === 'project.patch');
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].payload, { name: '新名称', color: '#3976C5', shortName: '新简称' });
  assert.deepEqual((await service.createBackup()).data.sessions, before);
});
