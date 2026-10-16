// Shared by the normal page and its isolated guide demonstration.
module.exports = function createPage(app, runtime) {
  runtime = runtime || {};
  const navigation = runtime.platform || {
    navigateTo: options => wx.navigateTo(options),
    redirectTo: options => wx.redirectTo(options),
    reLaunch: options => wx.reLaunch(options)
  };
const { resolveTheme } = require('../../utils/theme');
const { buildSettingsGroups } = require('../../utils/settings-summary');

const definition = {
  data: {
    groups: buildSettingsGroups(null), themeClass: 'light',
    settingsAccountName: '游客模式', settingsAccountHint: '项目和专注记录仅保存在本机 · 登录后可跨设备使用',
    settingsAccountStatus: '本机模式', settingsAccountAction: '登录开启同步', settingsAvatar: ''
  },
  onLoad() {
    if (getCurrentPages().length === 1) {
      this.redirectingToFocus = true;
      navigation.reLaunch({ url: '/pages/focus/focus', success: () => setTimeout(() => navigation.navigateTo({ url: '/pages/settings/settings' }), 0) });
    }
  },
  async onShow() {
    if (this.redirectingToFocus) return;
        if (!app.globalData.ready) await app.globalData.readyPromise;
    const prefs = await app.globalData.service.getPrefs();
    const themeClass = resolveTheme(prefs && prefs.theme || 'system', prefs && prefs.lightTheme);
    const groups = buildSettingsGroups(prefs), patch = require('../../utils/theme').pageThemeData(themeClass);
    const accounts = app.globalData.accounts;
    const account = accounts && accounts.getCurrent && accounts.getCurrent();
    const status = accounts && accounts.getStatus ? accounts.getStatus() : {};
    let profile = null;
    if (account && accounts.getDisplayProfile) {
      try { profile = await accounts.getDisplayProfile(); } catch (e) {}
    }
    const stateLabels = {
      syncing: '同步中', synced: '已登录', pending: '待保存', offline: '离线可用',
      failed: '保存未完成', 'auth-required': '需要重新登录', conflict: '有更改待确认',
      quarantined: '空间受限', 'upgrade-required': '等待处理'
    };
    const isDemo = !!this.demoSession;
    Object.assign(patch, {
      settingsAccountName: isDemo ? '游客模式 · 演示' : (account ? (profile && profile.nickname || '微信账号') : '游客模式'),
      settingsAccountHint: isDemo ? '固定样例数据 · 不连接真实账号' : account ? '项目与专注记录可在其他设备继续使用' : '项目和专注记录仅保存在本机 · 登录后可跨设备使用',
      settingsAccountStatus: isDemo ? '示例环境' : account ? (stateLabels[status.state] || '账号已关联') : '本机模式',
      settingsAccountAction: isDemo ? '查看说明' : account ? '账号与同步' : '登录开启同步',
      settingsAvatar: account && profile && profile.avatarUrl || ''
    });
    Object.keys(patch).forEach(key => { if (this.data[key] === patch[key]) delete patch[key]; });
    if (JSON.stringify(groups) !== JSON.stringify(this.data.groups)) patch.groups = groups;
    if (Object.keys(patch).length) this.setData(patch);
    try { wx.setNavigationBarColor(require('../../utils/theme').navigationBarOptions(themeClass)); } catch (e) {}
  },
  goBack() { wx.navigateBack({ fail: () => (runtime.navigation || require('../../utils/main-navigation')).openMainTab(0) }); },
  openAccount() {
    if (this.demoSession) {
      wx.showModal({ title:'示例账号', content:'此处使用固定演示数据，不连接真实账号。返回日常设置页后可登录并开启同步。', showCancel:false });
      return;
    }
    navigation.navigateTo({ url:'/pages/account/account' });
  },
  openSection(e) {
    const key = e.currentTarget.dataset.key;
    if (!this.data.groups.some(group => group.items.some(item => item.key === key))) return;
    if (key === 'guide') { navigation.navigateTo({ url: '/pages/guide/guide' }); return; }
    if (key === 'projects') { navigation.navigateTo({ url: '/pages/manage/manage' }); return; }
    if (key === 'account') { navigation.navigateTo({ url: '/pages/account/account' }); return; }
    if (key === 'privacy') { navigation.navigateTo({ url: '/pages/privacy/privacy' }); return; }
    navigation.navigateTo({ url: '/pages/settings-detail/settings-detail?section=' + key });
  }
};

  definition.data.demoSession = '';
  const load = definition.onLoad;
  definition.onLoad = function(options) {
    this.runtimeApp = app;
    if (load) return load.call(this, options || {});
  };
  return definition;
};
