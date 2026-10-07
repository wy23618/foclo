// Chart data is read-only: records and stored statistics never change.
const { durationText } = require('./format');
const TOLERANCE = 1e-7;
function formatPercent(ratio) { return (Math.round(ratio * 1000) / 10) + '%'; }
function formatDuration(seconds) { return durationText(seconds).replace('分钟', '分'); }
function compactDuration(seconds) {
  const s = Math.floor(seconds);
  return s >= 3600 ? Math.floor(s / 3600) + 'h' + Math.floor(s % 3600 / 60) + 'm' : s >= 60 ? Math.floor(s / 60) + 'm' + s % 60 + 's' : s + 's';
}
function childColor(color, index, count, virtual) {
  const hex = /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#55794e';
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const gray = rgb.reduce((a, b) => a + b, 0) / 3;
  const shade = count <= 1 ? .08 : -.16 + index / (count - 1) * .55;
  return '#' + rgb.map(v => {
    const base = virtual ? v * .35 + gray * .65 : v;
    return Math.round(virtual ? base * .65 + 255 * .35 : shade < 0 ? base * (1 + shade) : base + (255 - base) * shade).toString(16).padStart(2, '0');
  }).join('');
}
function normalizeItem(item) {
  return Object.assign({}, item, { id: String(item.id === undefined ? item.projectId : item.id), name: String(item.name || '未命名项目'), duration: Number(item.duration === undefined ? item.seconds : item.duration) });
}
function ensureUnallocatedChild(parent, diagnostics, warn = console.warn) {
  const tolerance = Math.max(TOLERANCE, parent.duration * TOLERANCE);
  const sum = parent.children.reduce((n, child) => n + child.duration, 0);
  if (sum > parent.duration + tolerance) {
    const issue = { code: 'CHILD_DURATION_EXCEEDS_PARENT', parentId: parent.id, parentDuration: parent.duration, childrenDuration: sum };
    diagnostics.push(issue); warn('[donut]', issue);
    // Material excess signals duplicate/mis-scoped data. Preserve the parent;
    // do NOT invent corrected children or misleading child percentages.
    return Object.assign({}, parent, { effectiveChildren: [], canExpand: false, dataIssue: issue });
  }
  let children = parent.children.map(child => Object.assign({}, child));
  const remainder = parent.duration - sum;
  if (remainder > tolerance && parent.hasRealChildren) children.push({ id: parent.id + '__unallocated', name: '未细分', duration: remainder, virtual: true });
  else if (children.length && Math.abs(remainder) <= tolerance) {
    // Absorb floating residue in the largest child, never a tiny last child.
    const largest = children.reduce((best, c, i) => c.duration > children[best].duration ? i : best, 0);
    children[largest].duration = parent.duration - children.reduce((n,c,i)=>n+(i===largest?0:c.duration),0);
  }
  // The canvas lays out positive angles clockwise, so this order puts the
  // longest child first from the parent's leading edge.
  children = children.filter(c => c.duration > 0)
    .sort((a, b) => b.duration - a.duration || String(a.id).localeCompare(String(b.id), 'zh-CN'))
    .map((c, i, ordered) => Object.assign({}, c, { parentId: parent.id, color: c.color || childColor(parent.color, i, ordered.length, c.virtual) }));
  return Object.assign({}, parent, { effectiveChildren: children, canExpand: parent.hasRealChildren && children.length > 0 });
}
function prepareChartData({ parents, groups = [], segments = [], warn } = {}) {
  const diagnostics = [];
  const source = parents || (groups.length ? groups : segments.filter(s => !s.groupId || s.groupId === s.projectId));
  const seen = new Set();
  const prepared = source.map(normalizeItem).filter(p => {
    if (!Number.isFinite(p.duration) || p.duration <= 0 || seen.has(p.id)) return false;
    seen.add(p.id); return true;
  }).map(p => {
    const rawChildren = Array.isArray(p.children) ? p.children : segments.filter(s => (s.groupId || s.parentId) === p.id && String(s.id === undefined ? s.projectId : s.id) !== p.id);
    const childIds = new Set();
    const children = rawChildren.map(normalizeItem).filter(c => {
      if (!Number.isFinite(c.duration) || c.duration < 0 || childIds.has(c.id)) return false;
      childIds.add(c.id); return true;
    });
    return ensureUnallocatedChild(Object.assign({}, p, { color: p.color || '#55794e', children, hasRealChildren: children.length > 0 }), diagnostics, warn);
  });
  return { parents: prepared, totalAllSeconds: prepared.reduce((n, p) => n + p.duration, 0), childCount: prepared.reduce((n, p) => n + p.effectiveChildren.length, 0), diagnostics };
}
function toggleExpandedParent(ids, parent) {
  if (!parent || !parent.canExpand) return ids.slice();
  return ids.includes(parent.id) ? ids.filter(id => id !== parent.id) : ids.concat(parent.id);
}
module.exports = { prepareChartData, ensureUnallocatedChild, formatPercent, formatDuration, compactDuration, childColor, toggleExpandedParent };
