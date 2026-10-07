module.exports = function showAllProjects(host) {
  const chart = host.selectComponent('#distributionChart');
  if (chart) chart.clearSelection();
  host.setData({ selectedProjectId: '', selectedDetail: null, expandedDetailChildIds: [] }, () => {
    const list = host.selectComponent('#projectList');
    if (!list) return;
    list.open();
    wx.nextTick(() => {
      const query = typeof host.createSelectorQuery === 'function' ? host.createSelectorQuery() : wx.createSelectorQuery();
      query.select('#projectList').boundingClientRect();
      query.select('.stats-sticky-controls').boundingClientRect();
      query.selectViewport().scrollOffset();
      query.exec(result => {
        const rect = result && result[0], controls = result && result[1], viewport = result && result[2];
        if (!rect || !viewport || host.data.selectedProjectId) return;
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        const top = (controls ? controls.bottom : (info.statusBarHeight || 24) + 60) + 12;
        wx.pageScrollTo({ scrollTop: Math.max(0, viewport.scrollTop + rect.top - top), duration: 200 });
      });
    });
  });
};
