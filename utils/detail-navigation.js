function decode(value) { try { return decodeURIComponent(value); } catch (error) { return value; } }
function destination(url) {
  const [route, search = ''] = url.replace(/^\//, '').split('?');
  const query = {};
  search.split('&').filter(Boolean).forEach(field => {
    const index = field.indexOf('=');
    query[decode(index < 0 ? field : field.slice(0, index))] = decode(index < 0 ? '' : field.slice(index + 1));
  });
  return { route, query };
}
function context(route, values) {
  if (route === 'pages/project-stats/project-stats') {
    const preset = values.preset || 'last30';
    return [values.projectId || values.id || '', preset, values.mode || 'realtime', preset === 'custom' ? values.startDate || '' : '', preset === 'custom' ? values.endDate || '' : ''];
  }
  if (route === 'pages/day-stats/day-stats') return [values.date || '', values.scope || ''];
  return null;
}
function demoId(page) { return page.demoSession || page.data && page.data.demoSession || page.properties && page.properties.demoSession || ''; }
function hasModal(data) { return !!data && ['editorOpen', 'scopeOpen', 'heatmapOpen', 'rangeOpen', 'recordEditorOpen', 'pickerOpen', 'todayOpen', 'customOpen'].some(key => data[key]); }

// Keep full detail pages, but reuse an earlier detail only when its project/date,
// filters and demonstration space match. Different ranges remain separate views.
function openDetail(page, navigation, url) {
  if (page.openingDetail) return false;
  const target = destination(url), expected = context(target.route, target.query);
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  const space = demoId(page);
  let index = -1;
  const origin = pages[pages.length - 1];
  const modal = origin && origin.data || page.data || {};
  const canReuse = !hasModal(modal);
  if (expected && canReuse) for (let i = pages.length - 1; i >= 0; i--) {
    const candidate = pages[i];
    if (hasModal(candidate.data)) continue;
    if (demoId(candidate) !== space) continue;
    const route = String(candidate.route || '').replace(/^\//, '');
    const targetRoute = space ? target.route.replace(/^pages\/([^/]+)\/[^/]+$/, 'pages/guide-demo/$1') : target.route;
    if (route !== targetRoute) continue;
    const actual = context(target.route, Object.assign({}, candidate.options || candidate.query, candidate.data));
    if (JSON.stringify(actual) === JSON.stringify(expected)) { index = i; break; }
  }
  if (index === pages.length - 1 && index >= 0) return true;
  page.openingDetail = true;
  const options = {
    complete: () => { page.openingDetail = false; },
    fail: () => { wx.showToast({ title: '暂时无法打开，请重试', icon: 'none' }); }
  };
  try {
    if (index >= 0) wx.navigateBack(Object.assign(options, { delta: pages.length - 1 - index }));
    else navigation.navigateTo(Object.assign(options, { url }));
  } catch (error) { page.openingDetail = false; options.fail(); }
  return true;
}

module.exports = { openDetail };
