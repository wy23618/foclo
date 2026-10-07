function openHeatmap() {
  if (this.data.heatmapOpen || this.openingHeatmap || this.data.chartObscured) return;
  this.openingHeatmap = true;
  const chart = this.selectComponent('#distributionChart');
  const open = () => {
    this.openingHeatmap = false;
    this.setData({ heatmapOpen: true, chartObscured: !!chart }, () => {
      if (this.triggerEvent) this.triggerEvent('navhiddenchange', { hidden: !!(this.data.rangeOpen || this.data.chartFull) });
    });
  };
  if (chart && chart.data.drawReady) chart.captureSnapshot(() => open());
  else open();
}
function closeHeatmap() {
    this.setData({ heatmapOpen: false, chartObscured: false }, () => {
    if (this.triggerEvent) this.triggerEvent('navhiddenchange', {
      hidden: !!(this.data.scopeOpen || this.data.rangeOpen || this.data.chartFull)
    });
  });
}
module.exports = { openHeatmap, closeHeatmap };
