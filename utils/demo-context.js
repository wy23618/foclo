const { createMemoryAdapter } = require('../storage/adapter');
const { createService } = require('../core/service');
const view = require('./view-data');
const sessions = new Map();
let preparedSession = null;
let sequence = 0;
const TODAY = '2026-10-16';
const ANCHOR = Date.UTC(2026, 9, 16, 13, 45) / 1000;
const SCENES = ['focus','stats','settings','settings-detail','manage','project-stats','day-stats','records','project-appearance','chart-full'];
const FEATURES = {
  projects: { scene: 'focus' }, runtime: { scene: 'focus' },
  rest: { scene: 'settings-detail', section: 'focus' }, stats: { scene: 'stats' },
  timeline: { scene: 'stats' }, slots: { scene: 'stats' },
  data: { scene: 'settings-detail', section: 'data' },
  appearance: { scene: 'settings-detail', section: 'display' },
  goals: { scene: 'settings-detail', section: 'stats' }
};

function getSession(id) {
  const session = sessions.get(id);
  // A stale demonstration must never fall back to the user's real space.
  if (!session) throw new Error('演示已结束，请从使用指南重新进入');
  return session;
}

function appFor(component) {
  const id = component.properties && component.properties.demoSession;
  return id ? getSession(id).app : getApp();
}

function todayFor(component) {
  return component.properties && component.properties.demoSession ? TODAY : view.today();
}

function endIfUnused(session) {
  clearTimeout(session.releaseTimer);
  session.releaseTimer = setTimeout(() => {
    if (!session.pages && !session.navigating) sessions.delete(session.id);
  }, 1000);
}

function sceneUrl(id, scene, query) {
  const fields = Object.assign({}, query, { demoSession: id });
  return '/pages/guide-demo/' + scene + '?' + Object.entries(fields)
    .filter(([, value]) => value != null)
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
}

function info(title, content) {
  wx.showModal({ title, content, showCancel: false });
}

function navigate(id, options, replace) {
  const session = getSession(id);
  const [path, raw = ''] = String(options.url || '').split('?');
  const match = /^\/pages\/([^/]+)\/[^/]+$/.exec(path);
  if (path === '/pages/guide/guide') { exit(id); if (options.complete) options.complete(); return; }
  if (!match || !SCENES.includes(match[1])) {
    info('功能演示', '此处使用独立示例数据。账号连接与真实数据操作请返回日常使用页面后进行。');
    const error = { errMsg: 'navigateTo:fail action unavailable in demonstration' };
    if (options.fail) options.fail(error);
    if (options.complete) options.complete(error);
    return;
  }
  const query = {};
  raw.split('&').filter(Boolean).forEach(part => {
    const at = part.indexOf('=');
    query[decodeURIComponent(at < 0 ? part : part.slice(0, at))] = decodeURIComponent(at < 0 ? '' : part.slice(at + 1));
  });
  session.navigating++;
  const complete = options.complete;
  const args = Object.assign({}, options, { url: sceneUrl(id, match[1], query), complete(result) {
    session.navigating--;
    if (complete) complete(result);
    endIfUnused(session);
  } });
  try { (replace ? wx.redirectTo : wx.navigateTo)(args); }
  catch (error) { session.navigating--; endIfUnused(session); throw error; }
}

function navigateFor(component, options) {
  const id = component.properties && component.properties.demoSession;
  return id ? navigate(id, options) : wx.navigateTo(options);
}

function openMainTab(id, tab, complete) {
  const scene = ['focus','stats','settings'][tab];
  if (!scene) return;
  const pages = getCurrentPages();
  const index = pages.findIndex(page => page.demoSession === id && page.route === 'pages/guide-demo/' + scene);
  if (index === pages.length - 1) { if (complete) complete(); return; }
  if (index >= 0) { wx.navigateBack({ delta: pages.length - 1 - index, complete }); return; }
  navigate(id, { url: '/pages/' + scene + '/' + scene, complete });
}

function exit(id) {
  const pages = getCurrentPages();
  const first = pages.findIndex(page => page.demoSession === id);
  const fallback = () => wx.redirectTo({ url: '/pages/guide/guide' });
  if (first > 0) wx.navigateBack({ delta: pages.length - first, fail: fallback });
  else fallback();
}

function runtimeFor(session) {
  const adapter = session.app.globalData.adapter;
  const restKey = 'yotick/rest-break/v1';
  return {
    view: Object.assign({}, view, { today: () => TODAY }),
    platform: {
      navigateTo: options => navigate(session.id, options),
      redirectTo: options => navigate(session.id, options, true),
      reLaunch: options => navigate(session.id, options, true)
    },
    navigation: { openMainTab: (tab, complete) => openMainTab(session.id, tab, complete) },
    restStore: { read: () => adapter.getSync(restKey) || null, write: value => adapter.setSync(restKey, value),
      clear: () => adapter.removeSync(restKey), remaining: require('./rest-break').remaining },
    sound: { play() {}, stop() {} }
  };
}

async function seed(session, feature) {
  const service = session.app.globalData.service;
  const ensure = result => { if (!result.ok) throw new Error(result.error.message); return result.data; };
  const sourceProjects = require('./guide-demo-data').PROJECTS;
  const ids = {};
  const projects = sourceProjects.map((project, index) => {
    const id = 'demo-project-' + project.id;
    ids[project.id] = id;
    return {
      id, spaceId: 'guide-template-v1', name: project.name,
      parentId: project.parentId ? 'demo-project-' + project.parentId : null,
      archived: false, creationOrder: index + 1, createdAtSec: ANCHOR,
      updatedAtSec: ANCHOR, revision: 1
    };
  });
  const leaves = sourceProjects.filter(project => !project.children);
  const records = [];
  const time = require('../core/time');
  const midnight = time.dayStart(time.parseDayKey(TODAY) * 86400);
  let recordNumber = 0;
  for (let day = -89; day <= 0; day++) {
    if ((day + 90) % 11 < 2) continue;
    for (let slot = 0; slot < 3; slot++) {
      const index = day + 90;
      const startedAtSec = midnight + day * 86400 + [7.5, 14, 20][slot] * 3600;
      const activeMinutes = 20 + (index * 7 + slot * 13) % 41;
      const pauses = slot === 1 ? [{
        id: 'demo-pause-' + (++recordNumber), sessionId: '',
        startedAtSec: startedAtSec + activeMinutes * 60,
        endedAtSec: startedAtSec + activeMinutes * 60 + 5 * 60,
        durationSeconds: 5 * 60, status: 'COMPLETED',
        createdAtSec: startedAtSec + activeMinutes * 60
      }] : [];
      const durationSeconds = (activeMinutes + (slot === 1 ? 10 : 0)) * 60;
      const endedAtSec = startedAtSec + durationSeconds + (slot === 1 ? 5 * 60 : 0);
      const id = 'demo-session-' + String(++recordNumber).padStart(4, '0');
      if (pauses.length) pauses[0].sessionId = id;
      records.push({
        id, spaceId: 'guide-template-v1',
        projectId: ids[leaves[(index * 2 + slot) % leaves.length].id],
        startedAtSec, endedAtSec, durationSeconds, targetSeconds: null,
        status: 'COMPLETED', pauses, createdAtSec: startedAtSec,
        updatedAtSec: endedAtSec, revision: pauses.length ? 4 : 2
      });
    }
  }
  if (feature === 'runtime') {
    const startedAtSec = ANCHOR - 25 * 60;
    const pauseStartedAtSec = ANCHOR - (6 * 60 + 18);
    const id = 'demo-active-session';
    records.push({
      id, spaceId: 'guide-template-v1', projectId: ids.calculus,
      startedAtSec, endedAtSec: null, durationSeconds: null, targetSeconds: null,
      status: 'ACTIVE', pauses: [{
        id: 'demo-active-pause', sessionId: id, startedAtSec: pauseStartedAtSec,
        endedAtSec: null, durationSeconds: null, status: 'ACTIVE',
        createdAtSec: pauseStartedAtSec
      }], createdAtSec: startedAtSec, updatedAtSec: pauseStartedAtSec, revision: 2
    });
  }
  const prefs = { lastProjectId: ids.calculus, startupMode: 'stopwatch',
    theme: 'light', lightTheme: 'forest', statsPreset: 'last7', dailyGoalEnabled: true, dailyGoalMinutes: 120,
    restEnabled: true, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4 };
  ensure(await service.init());
  ensure(await service.importBackup({ operationId: 'guide-seed-' + session.id, backup: {
    formatVersion: 1, exportedAtSec: ANCHOR, spaceId: 'guide-template-v1',
    meta: { schemaVersion: 1, utcOffsetMinutes: 480 }, projects, sessions: records, prefs
  } }));
  session.projectIds = ids;
  session.wallStartedAt = Date.now();
  session.seedNow = null;
  session.app.globalData.ready = true;
  session.projectIds = ids;
}

function createSession(feature) {
  if (!FEATURES[feature]) feature = 'projects';
  const id = 'guide-' + (++sequence);
  const adapter = createMemoryAdapter();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  adapter.getSync = key => clone(adapter._map.get(key));
  adapter.setSync = (key, value) => adapter._map.set(key, clone(value));
  adapter.removeSync = key => adapter._map.delete(key);
  const session = { id, feature, pages: 0, navigating: 0, seedNow: ANCHOR };
  let generated = 0;
  const service = createService(adapter, { genId: () => 'demo-id-' + (++generated),
    syncEnabled: false,
    clock: () => session.seedNow == null ? ANCHOR + Math.max(0, Math.floor((Date.now() - session.wallStartedAt) / 1000)) : session.seedNow });
  session.app = { globalData: { ready: false, service, adapter, guestSession: true, guideWelcomeChecked: true,
    accounts: { getCurrent: () => null, getStatus: () => ({ state: 'guest' }), subscribe: () => () => {}, trigger() {} } },
    onShow() { return service.getCurrent(); } };
  sessions.set(id, session);
  session.app.globalData.readyPromise = seed(session, feature);
  // The scene reports initialization errors; no fallback to a real account.
  session.app.globalData.readyPromise.catch(() => {});
  return session;
}

function prepareFeature(feature) {
  if (preparedSession && preparedSession.feature === feature) return preparedSession.app.globalData.readyPromise;
  discardPreparedFeature();
  preparedSession = createSession(feature);
  return preparedSession.app.globalData.readyPromise;
}

function discardPreparedFeature() {
  if (preparedSession) sessions.delete(preparedSession.id);
  preparedSession = null;
}

async function openFeature(feature, options) {
  const session = preparedSession && preparedSession.feature === feature ? preparedSession : createSession(feature);
  if (session === preparedSession) preparedSession = null;
  const target = FEATURES[session.feature];
  // A fixed local template is prepared while the preview card is open. Never
  // navigate into an empty space while its facts are still being imported.
  try { await session.app.globalData.readyPromise; }
  catch (error) {
    sessions.delete(session.id);
    if (options && options.fail) options.fail(error);
    if (options && options.complete) options.complete(error);
    return;
  }
  const args = Object.assign({}, options, { url: sceneUrl(session.id, target.scene, { section: target.section, entry: session.feature }),
    fail(error) { sessions.delete(session.id); if (options && options.fail) options.fail(error); } });
  wx.navigateTo(args);
}

module.exports = { SCENES, FEATURES, TODAY, getSession, createSession, appFor, todayFor, navigateFor,
  runtimeFor, openFeature, prepareFeature, discardPreparedFeature, openMainTab, exit, info, release: endIfUnused };
