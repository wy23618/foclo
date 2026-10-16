const { applyPageTheme } = require('../../utils/theme');

Page({
  data: { themeClass: 'light' },
  onShow() { return applyPageTheme(this); },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }); },
  openBackup() { wx.navigateTo({ url: '/pages/settings-detail/settings-detail?section=data' }); }
});
