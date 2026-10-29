function openHeatmap() {
  if (this.data.heatmapOpen || this.data.scopeOpen || this.openingHeatmap || this.openingSubjectPicker || this.data.chartObscured) return;
  this.openingHeatmap = true;
  const token = this.heatmapOpenToken = (this.heatmapOpenToken || 0) + 1;
  const chart = this.selectComponent && this.selectComponent('#distributionChart');
  const open = () => {
    if (token !== this.heatmapOpenToken) return;
    this.pageOverlayKind = 'heatmap';
    this.setData({ heatmapOpen: true }, () => {
      this.openingHeatmap = false;
      if (this.triggerEvent) this.triggerEvent('navhiddenchange', { hidden: true });
    });
  };
  // Native canvas can ignore modal z-order. Its existing pixel-identical image
  // keeps the same geometry; the daily scroll chart stays mounted and untouched.
  if (chart && chart.captureSnapshot) chart.captureSnapshot(ready => {
    if (token !== this.heatmapOpenToken) return;
    if (!ready) {
      this.openingHeatmap = false;
      wx.showToast({ title: '图表正在准备，请再试一次', icon: 'none' });
      return;
    }
    this.setData({ chartObscured: true }, open);
  });
  else open();
}
function closeHeatmap() {
  this.heatmapOpenToken = (this.heatmapOpenToken || 0) + 1;
  this.openingHeatmap = false;
  this.setData({ heatmapOpen: false }, () => {
    if (this.triggerEvent) this.triggerEvent('navhiddenchange', {
      hidden: !!(this.data.scopeOpen || this.data.rangeOpen || this.data.chartFull)
    });
  });
}
function afterHeatmapLeave() {
  if (this.data.heatmapOpen) closeHeatmap.call(this);
  if (this.data.chartObscured) this.setData({ chartObscured: false });
  if (this.pendingSyncRefresh) {
    this.pendingSyncRefresh = false;
    const reload = this.refresh || this.load;
    if (reload) Promise.resolve(reload.call(this)).catch(() => {});
  }
}
module.exports = { openHeatmap, closeHeatmap, afterHeatmapLeave };
