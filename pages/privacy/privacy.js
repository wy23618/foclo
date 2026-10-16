const { resolveTheme, navigationBarOptions, pageThemeData } = require('../../utils/theme');

Page({
  data: { themeClass: 'light' },
  async onShow() {
    const app = getApp();
    if (!app.globalData.ready) await app.globalData.readyPromise;
    const prefs = await app.globalData.service.getPrefs();
    const themeClass = resolveTheme(prefs && prefs.theme || 'system', prefs && prefs.lightTheme);
    this.setData(Object.assign({ themeClass }, pageThemeData(themeClass)));
    wx.setNavigationBarColor(navigationBarOptions(themeClass));
  },
  openAccount() { wx.navigateTo({ url: '/pages/account/account' }); },
  openTerms() { wx.navigateTo({ url: '/pages/terms/terms' }); },
  openPrivacyContract() {
    if (typeof wx.openPrivacyContract !== 'function') {
      wx.showToast({ title: '平台指引暂时无法打开', icon: 'none' });
      return;
    }
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: '平台指引暂时无法打开', icon: 'none' }) });
  }
});
