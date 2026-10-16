const demo = require('./demo-context');
const factories = {
  focus: require('../pages/focus/focus-definition'),
  stats: require('../pages/stats/stats-definition'),
  settings: require('../pages/settings/settings-definition'),
  'settings-detail': require('../pages/settings-detail/settings-detail-definition'),
  manage: require('../pages/manage/manage-definition'),
  'project-stats': require('../pages/project-stats/project-stats-definition'),
  'day-stats': require('../pages/day-stats/day-stats-definition'),
  records: require('../pages/records/records-definition'),
  'project-appearance': require('../pages/project-appearance/project-appearance-definition'),
  'chart-full': require('../pages/chart-full/chart-full-definition')
};

function prepareDefinition(scene, session) {
  const native = factories[scene](session.app, demo.runtimeFor(session));
  if (scene === 'focus') {
    native.loginWechat = () => demo.info('功能演示', '演示使用固定样例，无需登录。返回日常使用页面后可以连接自己的微信账号。');
    native.maybeShowWelcome = function() {};
    native.goFocus = function() {};
  }
  if (scene === 'stats') native.goFocus = () => demo.openMainTab(session.id, 0);
  if (scene === 'project-stats') native.chooseSubject = function(e) {
    if (e.detail.projectId) this.drill(e);
    else { this.closeSubjects(); demo.openMainTab(session.id, 1); }
  };
  if (scene === 'settings-detail') {
    native.exportBackup = async function() {
      const result = await session.app.globalData.service.createBackup();
      if (result.ok) demo.info('示例备份', '本次演示有 ' + result.data.projects.length + ' 个项目、' + result.data.sessions.length + ' 条记录。正式使用时，这个按钮会生成可恢复的备份文件。');
    };
    native.importBackup = () => demo.info('恢复备份', '正式使用时，可在这里选择备份文件并预览恢复内容。本次演示只使用固定样例。');
    native.exportCsv = () => demo.info('导出统计表', '正式使用时，可在这里导出项目、时间与时长，方便用表格整理。统计表和可恢复的备份文件各有用途。');
    native.clearAllData = () => demo.info('数据管理', '账号维护与清空操作请在日常使用页面中进行。演示结束后，样例修改会自动丢弃。');
    native.copyFeedback = () => demo.info('功能演示', '当前为独立演示环境。实际反馈请返回设置中的“反馈与建议”。');
  }
  return native;
}

function create(scene) {
  const shape = factories[scene]({ globalData: {} });
  const definition = { data: Object.assign({}, shape.data, { demoReady: false, demoError: '', demoSession: '', demoEntryFeature: '' }) };
  for (const name of Object.keys(shape)) {
    if (typeof shape[name] !== 'function') continue;
    definition[name] = function(...args) {
      const native = this.sceneDefinition;
      if (native && typeof native[name] === 'function') return native[name].apply(this, args);
    };
  }
  definition.onLoad = function(options) {
    this.demoAlive = true;
    this.demoSession = options && options.demoSession;
    this.demoEntry = options && options.entry;
    let session;
    try { session = demo.getSession(this.demoSession); }
    catch (error) { this.setData({ demoError: error.message }); return; }
    this.demoContext = session;
    session.pages++;
    clearTimeout(session.releaseTimer);
    const nativeSetData = this.setData;
    this.setData = function(patch, done) { if (this.demoAlive) return nativeSetData.call(this, patch, done); };
    const render = patch => new Promise(resolve => {
      if (!this.demoAlive) { resolve(false); return; }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        setTimeout(() => resolve(this.demoAlive), 0);
      };
      // Some base-library versions can lose a render callback while components
      // mount. Data is already committed; do not wait forever for that callback.
      const fallback = setTimeout(finish, 120);
      // Leave the component update stack before issuing any subsequent patch.
      nativeSetData.call(this, patch, finish);
    });
    // The real page must finish onLoad and its first data query before mounting
    // components. Native setData callbacks can arrive after the platform onShow.
    this.demoBoot = session.app.globalData.readyPromise.then(async () => {
      if (!this.demoAlive) return;
      this.sceneDefinition = prepareDefinition(scene, session);
      await render(Object.assign({}, this.sceneDefinition.data, { demoSession: session.id, demoReady: false, demoEntryFeature: this.demoEntry || '' }));
      if (!this.demoAlive) return;
      const loaded = this.sceneDefinition.onLoad && this.sceneDefinition.onLoad.call(this, options || {});
      this.demoLoaded = true;
      await loaded;
      if (!this.demoAlive) return;
      if (this.demoVisible) await this.showScene();
      await require('./theme').applyPageTheme(this);
      if (!this.demoAlive) return;
      await render({ demoReady: true });
      if (!this.demoAlive) return;
      this.demoMounted = true;
      if (this.demoPageReady) this.readyScene();
      await this.presentFeature();
    }).catch(error => { if (this.demoAlive) this.setData({ demoError: error.message || '演示暂时无法准备，请返回指南重试' }); });
  };
  definition.showScene = function() {
    if (this.demoShowPromise) return this.demoShowPromise;
    const native = this.sceneDefinition;
    this.demoShowPromise = Promise.resolve().then(() => native.onShow && native.onShow.call(this))
      .then(() => this.presentFeature()).finally(() => { this.demoShowPromise = null; });
    return this.demoShowPromise;
  };
  definition.presentFeature = function() {
    if (!this.demoMounted || !this.demoAlive || !this.demoVisible || this.demoFeatureShown) return;
    if (this.demoFeatureTask) return this.demoFeatureTask;
    this.demoFeatureTask = new Promise(resolve => setTimeout(() => {
      try {
        if (!this.demoAlive || !this.demoVisible || this.demoFeatureShown) return;
        this.demoFeatureShown = true;
        if (this.demoEntry === 'projects' && scene === 'focus') this.goPicker();
        if (this.demoEntry === 'timeline' && scene === 'stats') this.goHeatmap();
        if (this.demoEntry === 'slots' && scene === 'stats') wx.pageScrollTo({ selector: '.time-slot-card', offsetTop: -(this.data.filterTop + 98), duration: 0 });
      } finally { this.demoFeatureTask = null; resolve(); }
    }, 0));
    return this.demoFeatureTask;
  };
  definition.onShow = function() {
    this.demoVisible = true;
    if (this.demoMounted) return this.showScene().catch(error => {
      if (this.demoAlive) this.setData({ demoError: error.message || '请返回指南重试' });
    });
  };
  definition.readyScene = function() {
    if (this.demoNativeReady) return;
    this.demoNativeReady = true;
    setTimeout(() => { if (this.demoAlive && this.sceneDefinition.onReady) this.sceneDefinition.onReady.call(this); }, 0);
  };
  definition.onReady = function() { this.demoPageReady = true; if (this.demoMounted) this.readyScene(); };
  definition.onHide = function() {
    this.demoVisible = false;
    if (this.demoLoaded && this.sceneDefinition.onHide) this.sceneDefinition.onHide.call(this);
  };
  definition.onUnload = function() {
    if (this.demoLoaded && this.sceneDefinition.onUnload) this.sceneDefinition.onUnload.call(this);
    this.demoAlive = false;
    if (this.demoContext) { this.demoContext.pages--; demo.release(this.demoContext); }
  };
  definition.exitDemo = function() { demo.exit(this.demoSession); };
  return definition;
}

module.exports = { create, prepareDefinition };
