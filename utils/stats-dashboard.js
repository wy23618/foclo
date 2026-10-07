const { prepareChartData } = require('./donut-data');
const { durationText } = require('./format');
const { percent } = require('./view-data');

function byDuration(a, b) {
  return b.duration - a.duration || String(a.id).localeCompare(String(b.id), 'zh-CN');
}

function buildDashboard(groups, segments, tree = []) {
  const prepared = prepareChartData({ groups, segments });
  const total = prepared.totalAllSeconds;
  const treeById = {};
  function indexTree(nodes) {
    (nodes || []).forEach(node => {
      treeById[node.id] = node;
      indexTree(node.children);
    });
  }
  indexTree(tree);
  const parents = prepared.parents.slice().sort(byDuration).map(parent => {
    const children = parent.effectiveChildren.slice().sort(byDuration).map(child => {
      const node = treeById[child.id];
      const grandchildren = (node && node.children || []).filter(item => item.duration > 0).slice().sort(byDuration).map(item => ({
        id: item.id, name: item.name, color: item.color, duration: item.duration,
        durationText: durationText(item.duration),
        localPercent: percent(item.duration, child.duration),
        localWidth: child.duration > 0 ? Math.min(100, item.duration / child.duration * 100) : 0
      }));
      const ownDuration = Math.max(0, child.duration - grandchildren.reduce((sum, item) => sum + item.duration, 0));
      return {
        id: child.id, parentId: parent.id, parentName: parent.name,
        name: child.name, color: child.color, duration: child.duration,
        durationText: durationText(child.duration),
        globalPercent: percent(child.duration, total),
        globalWidth: total > 0 ? Math.min(100, child.duration / total * 100) : 0,
        localPercent: percent(child.duration, parent.duration),
        localWidth: parent.duration > 0 ? Math.min(100, child.duration / parent.duration * 100) : 0,
        grandchildren, ownDurationText: ownDuration > 0 ? durationText(ownDuration) : '',
        virtual: !!child.virtual
      };
    });
    return {
      id: parent.id, name: parent.name, color: parent.color,
      duration: parent.duration, durationText: durationText(parent.duration),
      globalPercent: percent(parent.duration, total),
      globalWidth: total > 0 ? Math.min(100, parent.duration / total * 100) : 0,
      children, dataIssue: !!parent.dataIssue
    };
  });
  return { parents };
}

function selectedDetail(dashboard, id) {
  if (!id) return null;
  const parent = dashboard.parents.find(item => item.id === id);
  if (parent) return Object.assign({ type: 'parent' }, parent);
  const child = dashboard.parents.flatMap(item => item.children).find(item => item.id === id);
  return child ? Object.assign({ type: 'child' }, child) : null;
}

function detailExpansion(detail, ids = []) {
  if (!detail) return { detail: null, ids: [] };
  const expandable = detail.type === 'parent'
    ? detail.children.filter(child => child.grandchildren.length).map(child => child.id)
    : detail.grandchildren.length ? [detail.id] : [];
  const validIds = ids.filter(id => expandable.indexOf(id) >= 0);
  const expanded = new Set(validIds);
  return {
    ids: validIds,
    detail: Object.assign({}, detail, {
      expanded: expanded.has(detail.id),
      children: detail.children && detail.children.map(child => Object.assign({}, child, { expanded: expanded.has(child.id) }))
    })
  };
}

module.exports = { buildDashboard, selectedDetail, detailExpansion };
