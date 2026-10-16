const demoContext = require('../../utils/demo-context');
const { colorOf } = require('../../utils/color');
const { uuid } = require('../../core/ids');
const { pickerMetrics } = require('../../utils/window-layout');

Component({
  properties: { demoSession: { type: String, value: '' },  opened: Boolean, selected: String, theme: { type: String, value: 'light' }, topInset: { type: Number, value: 0 }, bottomNav: { type: Boolean, value: false } },
  data: { selectionName: '', rows: [], recent: [], pickerScale: .5, overlayTop: 0, overlayBottom: 0, cardMaxHeight: 480, bodyMaxHeight: 320, bodyHeight: 85, cardHeight: 240, listScrollTop: 0, loading: false, error: '', newOpen: false, newName: '', editorMode: '', editorId: '', editorLabel: '', menuId: '', deleteText: '', creating: false, createdId: '' },
  pageLifetimes: { resize() { if (this.properties.opened) { this.measureLayout(); if (this.all) this.renderRows(); } } },
  observers: {
    opened(value) {
      if (value) { this.measureLayout(); this.setData({ listScrollTop: 0 }); this.load(); }
      else {
        this.token = (this.token || 0) + 1;
        this.setData({ newOpen: false, newName: '', editorMode: '', editorId: '', menuId: '', createdId: '' });
      }
    },
    selected() { this.updateSelection(); if (this.all && this.properties.opened) this.renderRows(); },
    topInset() { if (this.properties.opened) { this.measureLayout(); if (this.all) this.renderRows(); } }
  },
  methods: {
    noop() {},
    measureLayout() {
      let info;
      try { info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); } catch (e) {}
      this.setData(pickerMetrics(info, this.properties.topInset, this.properties.bottomNav));
    },
    close() {
      if (this.busy || this.data.creating) return;
      if (this.data.newOpen) { this.cancelNew(); return; }
      this.token = (this.token || 0) + 1;
      this.setData({ newOpen: false, newName: '', editorMode: '', editorId: '', menuId: '', createdId: '' });
      this.triggerEvent('close');
    },
    async load() {
      this.measureLayout();
      const token = this.token = (this.token || 0) + 1;
      this.setData({ loading: true, error: '' });
      await demoContext.appFor(this).globalData.readyPromise;
      const result = await demoContext.appFor(this).globalData.service.getPickerData();
      if (token !== this.token) return;
      if (!result.ok) { this.setData({ loading: false, error: result.error.message }); return; }
      this.all = result.data.treeRows;
      this.byId = {};
      this.childCounts = {};
      this.collapsed = this.collapsed || {};
      this.all.forEach(row => {
        this.byId[row.projectId] = row;
        this.childCounts[row.parentId] = (this.childCounts[row.parentId] || 0) + 1;
        if (!row.startable && !(row.projectId in this.collapsed)) this.collapsed[row.projectId] = true;
      });
      let selected = this.byId[this.properties.selected];
      const seen = {};
      while (selected && selected.parentId && !seen[selected.projectId]) {
        seen[selected.projectId] = true;
        this.collapsed[selected.parentId] = false;
        selected = this.byId[selected.parentId];
      }
      const recent = (result.data.recent || []).filter(row => this.byId[row.projectId] && this.byId[row.projectId].startable).slice(0, 3).map(row => {
        const current = this.byId[row.projectId], parent = this.byId[current.parentId];
        return Object.assign({}, row, { name: current.name, parentLabel: parent ? parent.name : '', color: current.color || colorOf(current.projectId) });
      });
      this.setData({ recent, loading: false, error: '' });
      this.renderRows();
      this.updateSelection();
    },
    updateSelection() {
      const selected = (this.all || []).find(row => row.projectId === this.properties.selected);
      this.setData({ selectionName: selected ? selected.name : '' });
    },
    renderRows() {
      const rows = [];
      (this.all || []).forEach(row => {
        let parent = this.byId[row.parentId];
        const seen = {};
        while (parent && !seen[parent.projectId]) {
          if (this.collapsed[parent.projectId]) return;
          seen[parent.projectId] = true;
          parent = this.byId[parent.parentId];
        }
        rows.push(Object.assign({}, row, { indent: Math.min(row.depth, 4) * 56, expanded: !this.collapsed[row.projectId], childCount: this.childCounts[row.projectId] || 0, color: row.color || colorOf(row.projectId) }));
      });
      const siblingsByParent = {};
      rows.forEach(row => {
        const key = row.parentId || '__root__';
        if (!siblingsByParent[key]) siblingsByParent[key] = [];
        siblingsByParent[key].push(row);
      });
      const siblingIndexById = {};
      Object.keys(siblingsByParent).forEach(key => {
        siblingsByParent[key].forEach((row, index) => {
          siblingIndexById[row.projectId] = { index, count: siblingsByParent[key].length };
        });
      });
      rows.forEach(row => {
        const sibling = siblingIndexById[row.projectId] || { index: 0, count: 1 };
        // Start the parent spine at the top edge of its first visible child row,
        // immediately below the parent, then continue through following siblings.
        row.guideTop = true;
        row.guideBottom = sibling.index < sibling.count - 1;
        row.guideLeft = 20 - 56;
        row.guideRails = [];
        let ancestor = this.byId[row.parentId];
        const seen = {};
        while (ancestor && !seen[ancestor.projectId]) {
          seen[ancestor.projectId] = true;
          const ancestorSibling = siblingIndexById[ancestor.projectId];
          // Keep an ancestor branch visible through its subtree only when
          // another sibling follows it (e.g. math's spine beside high math).
          if (ancestor.depth > 0 && ancestorSibling && ancestorSibling.index < ancestorSibling.count - 1) {
            const ancestorIndent = Math.min(ancestor.depth - 1, 3) * 56;
            const left = (ancestorIndent + 20) - row.indent;
            row.guideRails.push({ left });
          }
          ancestor = this.byId[ancestor.parentId];
        }
      });
      const rowHeight = rows.reduce((height, row) => height + (row.depth ? 88 : 96), 0);
      const bodyContent = rows.length ? 54 + rowHeight : 146;
      const recentContent = this.data.recent.length ? 168 : 0;
      const editorContent = this.data.newOpen ? 150 : 0;
      const desiredBodyHeight = (bodyContent + recentContent + editorContent) * this.data.pickerScale;
      const bodyHeight = Math.max(1, Math.ceil(Math.min(this.data.bodyMaxHeight, desiredBodyHeight)));
      const cardHeight = Math.ceil(Math.min(this.data.cardMaxHeight, 330 * this.data.pickerScale + bodyHeight));
      this.setData({ rows, bodyHeight, cardHeight });
    },
    rowTap(event) {
      if (this.busy) return;
      const row = this.byId && this.byId[event.currentTarget.dataset.id];
      if (!row) return;
      if (!row.startable) {
        this.collapsed[row.projectId] = !this.collapsed[row.projectId];
        this.renderRows();
        return;
      }
      this.select(row.projectId);
    },
    toggleExpand(event) {
      if (this.busy) return;
      const id = event.currentTarget.dataset.id;
      if (!this.childCounts[id]) return;
      this.collapsed[id] = !this.collapsed[id];
      this.setData({ menuId: '', newOpen: false, editorMode: '', newName: '' });
      this.renderRows();
    },
    toggleMenu(event) {
      if (this.busy || this.data.loading) return;
      const id = event.currentTarget.dataset.id;
      const menuId = this.data.menuId === id ? '' : id;
      this.setData({ menuId, newOpen: false, editorMode: '', newName: '' }, () => {
        if (menuId) this.revealMenu(menuId);
      });
    },
    revealMenu(menuId) {
      const token = this.token;
      const isCurrent = () => this.properties.opened && this.token === token && this.data.menuId === menuId;
      wx.nextTick(() => {
        if (!isCurrent()) return;
        const query = this.createSelectorQuery();
        query.select('.picker-body').boundingClientRect();
        query.select('.picker-body').scrollOffset();
        query.select('.picker-row-menu').boundingClientRect();
        query.exec(result => {
          if (!isCurrent()) return;
          const [viewport, offset, menu] = result || [];
          if (!viewport || !offset || !menu) return;
          // Reveal only the clipped part; keep the dialog and visible menus stationary.
          const padding = Math.min(8, Math.max(0, (viewport.height - menu.height) / 2));
          let delta = 0;
          if (menu.height > viewport.height) delta = menu.top - viewport.top;
          else if (menu.bottom > viewport.bottom - padding) delta = menu.bottom - viewport.bottom + padding;
          else if (menu.top < viewport.top + padding) delta = menu.top - viewport.top - padding;
          if (Math.abs(delta) < 1) return;
          const target = Math.max(0, offset.scrollTop + delta);
          // Sync the binding with manual scrolling before issuing the new position.
          this.setData({ listScrollTop: offset.scrollTop }, () => {
            if (isCurrent()) this.setData({ listScrollTop: target });
          });
        });
      });
    },
    recentTap(event) { this.select(event.currentTarget.dataset.id); },
    async select(id) {
      if (this.busy || !this.byId[id] || !this.byId[id].startable) return false;
      this.busy = true;
      try {
        const result = await demoContext.appFor(this).globalData.service.savePrefs({ lastProjectId: id });
        if (!result.ok) { wx.showToast({ title: result.error.message, icon: 'none' }); return false; }
        this.triggerEvent('selected', { projectId: id });
        return true;
      } finally { this.busy = false; }
    },
    newProject(event) {
      if (this.data.loading || this.busy) return;
      const id = event && event.currentTarget.dataset.id || '';
      const parent = this.byId && this.byId[id];
      this.setData({ newOpen: true, editorMode: 'create', editorId: parent ? id : '', editorLabel: parent ? '放在「' + parent.name + '」中' : '新建项目', newName: '', menuId: '' });
      this.renderRows();
    },
    cancelNew() {
      if (this.busy || this.data.creating) return;
      this.setData({ newOpen: false, editorMode: '', editorId: '', newName: '' });
      this.renderRows();
    },
    renameProject(event) {
      if (this.busy) return;
      const id = event.currentTarget.dataset.id, row = this.byId[id];
      if (!row) return;
      this.setData({ newOpen: true, editorMode: 'rename', editorId: id, editorLabel: '修改「' + row.name + '」的名称', newName: row.name, menuId: '' });
      this.renderRows();
    },
    async askDelete(event) {
      if (this.busy) return;
      const id = event.currentTarget.dataset.id;
      const token = this.token;
      this.busy = true;
      try {
        const result = await demoContext.appFor(this).globalData.service.getManageData();
        if (token !== this.token || !this.properties.opened) return;
        if (!result.ok) { wx.showToast({ title: result.error.message, icon: 'none' }); return; }
        const row = result.data.active.concat(result.data.archived).find(item => item.projectId === id);
        if (!row) return;
        this.setData({ newOpen: true, editorMode: 'delete', editorId: id, editorLabel: '删除「' + row.name + '」？', deleteText: '将删除 ' + row.subtreeProjectCount + ' 个项目和 ' + row.subtreeSessionCount + ' 条专注记录，删除后无法恢复。', menuId: '' });
        this.renderRows();
      } finally { this.busy = false; }
    },
    async confirmDelete() {
      if (this.busy || this.data.editorMode !== 'delete') return;
      this.busy = true;
      this.setData({ creating: true });
      try {
        const result = await demoContext.appFor(this).globalData.service.deleteProject({ operationId: uuid(), projectId: this.data.editorId });
        if (!result.ok) { wx.showToast({ title: result.error.message, icon: 'none' }); return; }
        this.setData({ newOpen: false, editorMode: '', editorId: '', menuId: '', createdId: '' });
        this.triggerEvent('changed');
        await this.load();
        wx.showToast({ title: '已删除', icon: 'success' });
      } finally { this.busy = false; this.setData({ creating: false }); }
    },
    inputName(event) { this.setData({ newName: event.detail.value }); },
    async create() {
      if (this.data.creating || this.busy) return;
      if (!this.data.newOpen || this.data.editorMode === 'delete') return;
      const name = this.data.newName.trim();
      if (!name) { wx.showToast({ title: '请输入名称', icon: 'none' }); return; }
      const parentId = this.data.editorId;
      const renaming = this.data.editorMode === 'rename';
      this.busy = true;
      this.setData({ creating: true });
      try {
        const service = demoContext.appFor(this).globalData.service;
        const result = renaming
          ? await service.renameProject({ operationId: uuid(), projectId: parentId, name })
          : await service.createProject({ operationId: uuid(), name, parentId: parentId || null });
        if (!result.ok) { wx.showToast({ title: result.error.message, icon: 'none' }); return; }
        let current = this.byId && this.byId[parentId];
        const seen = {};
        while (current && !seen[current.projectId]) {
          seen[current.projectId] = true;
          this.collapsed[current.projectId] = false;
          current = this.byId[current.parentId];
        }
        const savedId = result.data.project.id;
        this.setData({ newOpen: false, newName: '', editorMode: '', editorId: '', createdId: renaming ? '' : savedId });
        this.triggerEvent('changed');
        await this.load();
        wx.showToast({ title: renaming ? '已改名' : '已创建', icon: 'success' });
      } finally { this.busy = false; this.setData({ creating: false }); }
    },
    goManage() { if (!this.busy && !this.data.creating) this.triggerEvent('openmanage'); }
  }
});
