const { durationText } = require('../../utils/format');
const { formatPercent } = require('../../utils/donut-data');

function rowTint(color) {
  const match = /^#([\da-f]{6}|[\da-f]{3})$/i.exec(color);
  if (!match) return 'rgba(85,121,78,0.08)';
  const hex = match[1].length === 3 ? match[1].split('').map(c => c + c).join('') : match[1];
  const rgb = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  return `rgba(${rgb.join(',')},0.08)`;
}

Component({
  properties: {
    tree: { type: Array, value: [], observer: 'render' },
    title: { type: String, value: '全部项目' },
    selectedId: { type: String, value: '', observer: 'render' },
    rangeKey: { type: String, value: '', observer: 'reset' }
  },
  data: { opened: false, rootCount: 0, visibleRows: [], hasChildren: false, focusedName: '', focusRootId: '', moves: {}, focusPulse: false },
  methods: {
    reset() {
      this.ignoredSelectionId = this.properties.selectedId || '';
      this.focusId = '';
      this.focusBaseline = null;
      this.notifiedFocusId = '';
      this.expandedIds = new Set();
      this.setData({ opened: false, focusedName: '', focusRootId: '', moves: {}, focusPulse: false }, () => this.render());
    },
    render() {
      const previousRows = this.data.visibleRows || [];
      const nodes = new Map();
      const normalize = (items, parentId = '', path = []) => (items || []).filter(item => {
        const seconds = Number(item.duration);
        return Number.isFinite(seconds) && seconds > 0;
      }).map(item => {
        const id = String(item.id);
        if (nodes.has(id)) return null;
        const node = {
          id, parentId, name: item.name || '未命名项目',
          duration: Number(item.duration), color: item.color || '#55794e',
          virtual: !!item.virtual, path: path.concat(item.name || '未命名项目')
        };
        nodes.set(id, node);
        node.children = normalize(item.children, id, node.path);
        return node;
      }).filter(Boolean).sort((a, b) => b.duration - a.duration || a.id.localeCompare(b.id));
      const roots = normalize(this.properties.tree);
      const total = roots.reduce((sum, node) => sum + node.duration, 0);
      this.nodes = nodes;
      this.expandedIds = new Set([...(this.expandedIds || [])].filter(id => nodes.has(id) && nodes.get(id).children.length));
      if (this.properties.selectedId !== this.ignoredSelectionId) this.ignoredSelectionId = '';
      const selectedId = nodes.has(this.properties.selectedId) && this.properties.selectedId !== this.ignoredSelectionId ? this.properties.selectedId : '';
      const selectionChanged = selectedId !== (this.focusId || '');
      let opened = this.data.opened;
      if (selectionChanged) {
        if (selectedId) {
          if (!this.focusBaseline) this.focusBaseline = { opened, expandedIds: [...this.expandedIds] };
          this.expandedIds = new Set(this.focusBaseline.expandedIds.filter(id => nodes.has(id)));
          let node = nodes.get(selectedId);
          while (node) {
            if (node.children.length) this.expandedIds.add(node.id);
            node = nodes.get(node.parentId);
          }
          opened = true;
        } else if (this.focusBaseline) {
          opened = this.focusBaseline.opened;
          this.expandedIds = new Set(this.focusBaseline.expandedIds.filter(id => nodes.has(id)));
          this.focusBaseline = null;
        }
        this.focusId = selectedId;
      }
      let focusedRoot = selectedId ? nodes.get(selectedId) : null;
      if (selectedId) opened = true;
      while (focusedRoot && focusedRoot.parentId) focusedRoot = nodes.get(focusedRoot.parentId);
      const orderedRoots = focusedRoot ? [focusedRoot, ...roots.filter(node => node.id !== focusedRoot.id)] : roots;
      const visibleRows = [];
      const append = (node, depth, branches = []) => {
        const ratio = total > 0 ? node.duration / total : 0;
        const expanded = this.expandedIds.has(node.id);
        visibleRows.push({
          projectId: node.id, name: node.name, color: node.color, depth,
          indent: Math.min(depth, 3) * 22,
          tint: rowTint(node.color),
          branchLeft: 32 + Math.min(depth - 1, 2) * 22,
          branchWidth: node.children.length ? 12 : 52,
          dividerLeft: 64 + Math.min(depth, 3) * 22,
          rails: (depth > 3 ? branches.slice(0, 2).concat(branches[depth - 1]) : branches).map((last, level) => ({
            level, left: 32 + level * 22,
            visible: level === Math.min(depth - 1, 2) || !last,
            end: level === Math.min(depth - 1, 2) && last
          })),
          parentName: depth > 3 ? node.path[node.path.length - 2] : '',
          pathText: node.path.join(' › '),
          rowLabel: node.children.length ? `${expanded ? '收起' : '展开'}${node.path.join(' › ')}下级项目` : node.path.join(' › '),
          durationText: durationText(node.duration),
          percentText: ratio > 0 && ratio < 0.0005 ? '<0.1%' : formatPercent(ratio),
          hasChildren: node.children.length > 0, expanded, virtual: node.virtual,
          focusedRoot: !!focusedRoot && node.id === focusedRoot.id,
          focusPulse: selectionChanged && !!focusedRoot && node.id === focusedRoot.id,
          selected: node.id === this.properties.selectedId
        });
        if (expanded) node.children.forEach((child, index) => append(child, depth + 1, branches.concat(index === node.children.length - 1)));
      };
      if (opened) orderedRoots.forEach(node => append(node, 0));
      const patch = {
        rootCount: roots.length, visibleRows,
        hasChildren: [...nodes.values()].some(node => node.children.length),
        opened: roots.length > 0 && opened,
        focusedName: focusedRoot ? focusedRoot.name : '',
        focusRootId: focusedRoot ? focusedRoot.id : ''
      };
      const notify = () => {
        if (selectedId !== (this.notifiedFocusId || '')) {
          this.notifiedFocusId = selectedId;
          this.triggerEvent('focuschange', { projectId: selectedId });
        }
      };
      if (selectionChanged && previousRows.length && visibleRows.length && this.createSelectorQuery) {
        const revision = this.renderRevision = (this.renderRevision || 0) + 1;
        this.createSelectorQuery().selectAll('.project-list-row').boundingClientRect().exec(result => {
          if (revision !== this.renderRevision) return;
          const oldPositions = {};
          const oldRects = result && result[0] || [], oldTop = oldRects[0] ? oldRects[0].top : 0;
          oldRects.forEach((rect, index) => { if (previousRows[index]) oldPositions[previousRows[index].projectId] = rect.top - oldTop; });
          this.setData({ ...patch, moves: {} }, () => wx.nextTick(() => {
            if (revision !== this.renderRevision) return;
            this.createSelectorQuery().selectAll('.project-list-row').boundingClientRect().exec(result => {
              if (revision !== this.renderRevision) return;
              const moves = {};
              const newRects = result && result[0] || [], newTop = newRects[0] ? newRects[0].top : 0;
              newRects.forEach((rect, index) => {
                const id = visibleRows[index] && visibleRows[index].projectId;
                if (id && oldPositions[id] !== undefined) moves[id] = oldPositions[id] - (rect.top - newTop);
              });
              this.setData({ moves }, () => wx.nextTick(() => {
                if (revision === this.renderRevision) this.setData({ moves: {} }, notify);
              }));
            });
          }));
        });
      } else {
        this.renderRevision = (this.renderRevision || 0) + 1;
        this.setData({ ...patch, moves: {} }, notify);
      }
    },
    clearFocus() {
      this.triggerEvent('clearfocus');
    },
    toggleOpen() {
      if (this.focusId) {
        if (this.focusBaseline) this.focusBaseline.opened = false;
        this.clearFocus();
        return;
      }
      this.setData({ opened: !this.data.opened }, () => this.render());
    },
    open() {
      if (!this.data.opened) this.toggleOpen();
    },
    toggleChild(e) {
      const id = e.currentTarget.dataset.id;
      const node = this.nodes && this.nodes.get(id);
      if (!node || !node.children.length) return;
      this.expandedIds = this.expandedIds || new Set();
      if (this.expandedIds.has(id)) this.expandedIds.delete(id);
      else this.expandedIds.add(id);
      this.render();
    },
    toggleRow(e) {
      this.toggleChild(e);
    },
    select(e) {
      const node = this.nodes && this.nodes.get(e.currentTarget.dataset.id);
      if (!node || node.virtual) return;
      this.triggerEvent('select', { projectId: node.id });
    }
  }
});
