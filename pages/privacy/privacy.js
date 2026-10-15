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
  openPrivacyContract() {
    if (typeof wx.openPrivacyContract !== 'function') {
      wx.showToast({ title: '微信平台隐私指引暂未配置', icon: 'none' });
      return;
    }
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: '微信平台隐私指引暂未配置', icon: 'none' }) });
  }
});
