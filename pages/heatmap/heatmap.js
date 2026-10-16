Page({
  data: { themeClass: 'light', scope: '', opened: false, topInset: 78 },
  onLoad(options) { this.setData({ scope: options && options.scope || '', opened: true }); },
  onShow() { require('../../utils/theme').applyPageTheme(this); },
  onNavHeightChange(e) { this.setData({ topInset: e.detail.height }); },
  back() { wx.navigateBack({ fail: () => require('../../utils/main-navigation').openMainTab(1) }); }
});
