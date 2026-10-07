function selectFromChart(host, detail) {
  const projectId = detail && detail.projectId || '';
  host.setData({ selectedProjectId: projectId, selectedDetail: null, expandedDetailChildIds: [] });
}
function revealFocus(host, detail) {
  if (!detail || !detail.projectId) return;
  const id = detail.projectId;
  const reveal = (attempts, corrections = 0) => wx.nextTick(() => {
    if (host.data.selectedProjectId !== id) return;
    const chart = host.selectComponent('#distributionChart');
    if (chart && !chart.data.drawReady && attempts < 20) {
      setTimeout(() => reveal(attempts + 1, corrections), 40);
      return;
    }
    const query = typeof host.createSelectorQuery === 'function' ? host.createSelectorQuery() : wx.createSelectorQuery();
    query.select('#projectList').boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec(result => {
      if (host.data.selectedProjectId !== id) return;
      const rect = result && result[0], viewport = result && result[1];
      if (!rect || !viewport) return;
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const shift = rect.top + Math.min(rect.height, 210) - (info.windowHeight - 90);
      if (shift > 2) {
        if (typeof host.scrollProjectListBy === 'function') host.scrollProjectListBy(shift);
        else wx.pageScrollTo({ scrollTop: Math.max(0, viewport.scrollTop + shift), duration: 220 });
        if (corrections < 2) setTimeout(() => reveal(attempts, corrections + 1), 280);
      }
    });
  });
  reveal(0);
}
function clearFocus(host) {
  const chart = host.selectComponent('#distributionChart');
  if (chart) chart.clearSelection();
  selectFromChart(host, { projectId: '' });
}
function contains(tree, id) {
  return !!id && (tree || []).some(node => node.id === id || contains(node.children, id));
}
module.exports = { selectFromChart, revealFocus, clearFocus, contains };
