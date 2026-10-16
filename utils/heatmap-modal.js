function openHeatmap() {
  if (this.data.heatmapOpen || this.data.scopeOpen || this.openingHeatmap || this.openingSubjectPicker || this.data.chartObscured) return;
  this.openingHeatmap = true;
  const chart = this.selectComponent && this.selectComponent('#distributionChart');
  const open = () => {
    this.pageOverlayKind = 'heatmap';
    this.setData({ heatmapOpen: true, chartObscured: !!chart }, () => {
      this.openingHeatmap = false;
      if (this.triggerEvent) this.triggerEvent('navhiddenchange', { hidden: true });
    });
  };
  if (chart && chart.captureSnapshot) chart.captureSnapshot(() => open());
  else open();
}
function closeHeatmap() {
  this.setData({ heatmapOpen: false, chartObscured: false }, () => {
    if (this.triggerEvent) this.triggerEvent('navhiddenchange', {
      hidden: !!(this.data.scopeOpen || this.data.rangeOpen || this.data.chartFull)
    });
  });
}
function afterHeatmapLeave() {
  if (this.data.heatmapOpen) closeHeatmap.call(this);
}
module.exports = { openHeatmap, closeHeatmap, afterHeatmapLeave };
