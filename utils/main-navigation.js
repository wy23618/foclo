const MAIN_ROUTES = ['/pages/focus/focus', '/pages/stats/stats', '/pages/settings/settings'];
let switching = false;

function currentTab() {
  const page = getCurrentPages().slice(-1)[0];
  return page ? MAIN_ROUTES.indexOf('/' + page.route) : -1;
}

function navigate(method, options, complete) {
  if (switching) { if (complete) complete(); return; }
  switching = true;
  wx[method](Object.assign({}, options, {
    fail() { wx.showToast({ title: '暂时无法打开，请重试', icon: 'none' }); },
    complete(result) { switching = false; if (complete) complete(result); }
  }));
}

// Reuse real pages so system gestures and buttons share the same back stack.
// Main pages occur at most once, preserving their filters, scroll and charts.
function openMainTab(tab, complete) {
  const url = MAIN_ROUTES[tab];
  if (!url) return;
  const pages = getCurrentPages();
  const index = pages.findIndex(page => '/' + page.route === url);
  if (index === pages.length - 1 && index >= 0) { if (complete) complete(); return; }
  if (index >= 0) navigate('navigateBack', { delta: pages.length - 1 - index }, complete);
  else navigate('navigateTo', { url }, complete);
}

function backMainTab(complete) {
  if (getCurrentPages().length > 1) navigate('navigateBack', { delta: 1 }, complete);
  else if (currentTab() !== 0) navigate('reLaunch', { url: MAIN_ROUTES[0] }, complete);
  else { wx.showToast({ title: '已在起始页面', icon: 'none' }); if (complete) complete(); }
}

module.exports = { openMainTab, backMainTab, currentTab };
