const MAIN_ROUTES = ['/pages/focus/focus', '/pages/stats/stats', '/pages/settings/settings'];

// Reuse a page already in the stack so its filters and scroll position survive.
function openMainTab(tab, complete) {
  const url = MAIN_ROUTES[tab];
  if (!url) return;
  const pages = getCurrentPages();
  const index = pages.findIndex(page => '/' + page.route === url);
  if (index === pages.length - 1) { if (complete) complete(); return; }
  const fail = () => wx.showToast({ title: '暂时无法打开，请重试', icon: 'none' });
  if (index >= 0) wx.navigateBack({ delta: pages.length - 1 - index, fail, complete });
  else wx.navigateTo({ url, fail, complete });
}

module.exports = { openMainTab };
