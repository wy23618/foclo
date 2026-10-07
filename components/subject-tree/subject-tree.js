const { percent } = require('../../utils/view-data');

Component({
  properties: { rows: { type: Array, value: [], observer: 'render' }, selectedId: { type: String, value: '', observer: 'render' } },
  data: { visibleRows: [], visibleGroups: [] },
  methods: {
    render() {
      const rows = this.properties.rows, byId = {};
      if (!rows.length) { this.setData({ visibleRows: [], visibleGroups: [] }); return; }
      rows.forEach(row => { byId[row.projectId] = row; });
      if (!this.collapsed) {
        this.collapsed = {};
        rows.filter(row => !row.depth).forEach((row, index) => { this.collapsed[row.projectId] = index >= 2; });
      }
      let selected = byId[this.properties.selectedId], selectedSeen = {};
      while (selected && selected.parentId && byId[selected.parentId] && !selectedSeen[selected.projectId]) {
        selectedSeen[selected.projectId] = true;
        this.collapsed[selected.parentId] = false;
        selected = byId[selected.parentId];
      }
      const visibleRows = [], visibleGroups = [];
      let group;
      rows.forEach(row => {
        if (!row.depth) {
          group = { projectId: row.projectId, rows: [] };
          visibleGroups.push(group);
        }
        let parent = byId[row.parentId], hidden = false;
        const seen = {};
        while (parent && !seen[parent.projectId]) {
          seen[parent.projectId] = true;
          if (this.collapsed[parent.projectId]) hidden = true;
          parent = byId[parent.parentId];
        }
        if (hidden) return;
        const item = Object.assign({}, row, {
          expanded: !this.collapsed[row.projectId],
          selected: row.projectId === this.properties.selectedId,
          parentPct: row.parentPct || (row.depth && byId[row.parentId] ? percent(row.seconds, byId[row.parentId].seconds) : row.pctText),
          parentWidth: row.parentWidth !== undefined ? row.parentWidth : row.depth && byId[row.parentId] && byId[row.parentId].seconds > 0 ? Math.min(100, row.seconds / byId[row.parentId].seconds * 100) : row.width
        });
        visibleRows.push(item);
        if (group) group.rows.push(item);
      });
      this.setData({ visibleRows, visibleGroups });
    },
    toggle(e) {
      const id = e.currentTarget.dataset.id;
      this.collapsed = this.collapsed || {};
      this.collapsed[id] = !this.collapsed[id];
      this.render();
    },
    select(e) { this.triggerEvent('select', { projectId: e.currentTarget.dataset.id }); }
  }
});
