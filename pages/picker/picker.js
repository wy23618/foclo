Page({
  data: { opened: false, selected: '', themeClass: 'light' },
  async onLoad() {
    await getApp().globalData.readyPromise;
    await require('../../utils/theme').applyPageTheme(this);
    const e = await getApp().globalData.service.getCurrent();
    this.setData({ selected: e.ok ? e.data.projectId || '' : '', opened: true });
  },
  onShow() {
    require('../../utils/theme').applyPageTheme(this);
    const sheet = this.selectComponent('#projectSheet');
    if (sheet && this.data.opened) sheet.load();
  },
  close() { wx.navigateBack({ fail: () => require('../../utils/main-navigation').openMainTab(0) }); },
  selected(e) { this.setData({ selected: e.detail.projectId }); this.close(); },
  openAppearance(e) { wx.navigateTo({ url: '/pages/project-appearance/project-appearance?id=' + encodeURIComponent(e.detail.projectId) }); },
  openManage() { wx.navigateTo({ url: '/pages/manage/manage' }); }
});
