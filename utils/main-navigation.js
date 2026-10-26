const MAIN_ROUTES = ['/pages/focus/focus', '/pages/stats/stats', '/pages/settings/settings'];

// Native tab navigation avoids the full-page push/back animation between main screens.
function openMainTab(tab, complete) {
  const url = MAIN_ROUTES[tab];
  if (!url) return;
  const pages = getCurrentPages();
  if (pages.length && '/' + pages[pages.length - 1].route === url) {
    if (complete) complete();
    return;
  }
  const fail = () => wx.showToast({ title: '暂时无法打开，请重试', icon: 'none' });
  wx.switchTab({ url, fail, complete });
}

module.exports = { openMainTab };
