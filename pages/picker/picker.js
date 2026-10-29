Page({
  data: { opened: false, selected: '', themeClass: 'light', editorOpen: false, editorHistoryEnabled: true },
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
  onEditorChange(e) { this.setData({ editorOpen: !!e.detail.open }); },
  onEditorHistoryLeave() {
    if(require('../../utils/modal-history').isRearming(this,'editorHistoryEnabled'))return;
    if (!this.data.editorOpen) return;
    const sheet=this.selectComponent('#projectSheet');
    if (sheet) sheet.close();
    if (this.data.editorOpen) require('../../utils/modal-history').restoreLayer(this, 'editorHistoryEnabled', () => this.data.editorOpen);
  },
  onEditorHistoryEnter(){require('../../utils/modal-history').layerEntered(this,'editorHistoryEnabled');},
  selected(e) { this.setData({ selected: e.detail.projectId }); this.close(); },
  openAppearance(e) { wx.navigateTo({ url: '/pages/project-appearance/project-appearance?id=' + encodeURIComponent(e.detail.projectId) }); },
  openManage() { wx.navigateTo({ url: '/pages/manage/manage' }); }
});
