const { resolveTheme } = require('../../utils/theme');
const { buildSettingsGroups } = require('../../utils/settings-summary');

Page({
  data: { groups: buildSettingsGroups(null), themeClass: 'light' },
  onLoad() {
    if (getCurrentPages().length === 1) {
      this.redirectingToFocus = true;
      wx.reLaunch({ url: '/pages/focus/focus', success: () => setTimeout(() => wx.navigateTo({ url: '/pages/settings/settings' }), 0) });
    }
  },
  async onShow() {
    if (this.redirectingToFocus) return;
    const app = getApp();
    if (!app.globalData.ready) await app.globalData.readyPromise;
    const prefs = await app.globalData.service.getPrefs();
    const themeClass = resolveTheme(prefs && prefs.theme || 'system', prefs && prefs.lightTheme);
    const groups = buildSettingsGroups(prefs), patch = require('../../utils/theme').pageThemeData(themeClass);
    Object.keys(patch).forEach(key => { if (this.data[key] === patch[key]) delete patch[key]; });
    if (JSON.stringify(groups) !== JSON.stringify(this.data.groups)) patch.groups = groups;
    if (Object.keys(patch).length) this.setData(patch);
    try { wx.setNavigationBarColor(require('../../utils/theme').navigationBarOptions(themeClass)); } catch (e) {}
  },
  openSection(e) {
    const key = e.currentTarget.dataset.key;
    if (!this.data.groups.some(group => group.items.some(item => item.key === key))) return;
    if (key === 'guide') { wx.navigateTo({ url: '/pages/guide/guide' }); return; }
    if (key === 'projects') { wx.navigateTo({ url: '/pages/manage/manage' }); return; }
    if (key === 'account') { wx.navigateTo({ url: '/pages/account/account' }); return; }
    if (key === 'privacy') { wx.navigateTo({ url: '/pages/privacy/privacy' }); return; }
    wx.navigateTo({ url: '/pages/settings-detail/settings-detail?section=' + key });
  }
});
