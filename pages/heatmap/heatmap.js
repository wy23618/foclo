Page({
  data: { themeClass: 'light', scope: '', opened: false, topInset: 78, scopePickerOpen: false },
  onLoad(options) { this.setData({ scope: options && options.scope || '', opened: true }); },
  onShow() { require('../../utils/theme').applyPageTheme(this); },
  onNavHeightChange(e) { this.setData({ topInset: e.detail.height }); },
  onScopePickerChange(e) { this.setData({ scopePickerOpen: !!e.detail.open }); },
  onScopeHistoryLeave() { const card=this.selectComponent('#heatmapCard');if(this.data.scopePickerOpen&&card)card.closeScopePicker(); },
  back() { const card=this.selectComponent&&this.selectComponent('#heatmapCard');if(card&&card.data.scopePickerOpen){card.closeScopePicker();return;}wx.navigateBack({ fail: () => require('../../utils/main-navigation').openMainTab(1) }); }
});
