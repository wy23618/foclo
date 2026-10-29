const demoContext = require('../../utils/demo-context');
const { colorOf } = require('../../utils/color');
const { uuid } = require('../../core/ids');
const { pickerMetrics } = require('../../utils/window-layout');
const motion = require('../../utils/overlay-motion');

Component({
  properties: { demoSession: { type: String, value: '' }, opened: Boolean, selected: String, theme: { type: String, value: 'light' }, topInset: { type: Number, value: 0 }, bottomNav: { type: Boolean, value: false } },
  data: { sheetOpen: false, sheetOpenMounted: false, sheetOpenLeaving: false, rows: [], pickerScale: .5, overlayTop: 0, overlayBottom: 0, cardMaxHeight: 480, bodyMaxHeight: 320, bodyHeight: 85, cardHeight: 240, listScrollTop: 0, loading: false, error: '', organizing: false, newOpen: false, newName: '', editorMode: '', editorId: '', editorLabel: '', parentOptions: [], parentIndex: 0, parentLabel: '', deleteText: '', creating: false, createdId: '' },
  pageLifetimes: { resize() { if (this.properties.opened) { this.measureLayout(); this.renderRows(); } } },
  lifetimes: { detached() { motion.dispose(this); } },
  observers: {
    newOpen(open) { this.triggerEvent('editorchange', { open: !!open }); },
    opened(value) {
      motion.present(this, 'sheetOpen', value);
      if (value) { this.measureLayout(); this.setData({ listScrollTop: 0, organizing: false, newOpen: false, newName: '', editorMode: '', editorId: '', createdId: '' }); this.load(); }
      else { this.token = (this.token || 0) + 1; }
    },
    selected() { if (this.all && this.properties.opened) this.renderRows(); },
    topInset() { if (this.properties.opened) { this.measureLayout(); this.renderRows(); } }
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
      this.setData({ organizing: false, newOpen: false, createdId: '' });
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
      this.all.forEach(row => { this.byId[row.projectId] = row; this.childCounts[row.parentId] = (this.childCounts[row.parentId] || 0) + 1; });
      this.all.forEach(row => { if (this.childCounts[row.projectId] && !(row.projectId in this.collapsed)) this.collapsed[row.projectId] = true; });
      let selected = this.byId[this.properties.selected];
      const seen = {};
      while (selected && selected.parentId && !seen[selected.projectId]) {
        seen[selected.projectId] = true;
        this.collapsed[selected.parentId] = false;
        selected = this.byId[selected.parentId];
      }
      this.setData({ loading: false, error: '' });
      this.renderRows();
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
        rows.push(Object.assign({}, row, { indent: Math.min(row.depth, 4) * 32, expanded: !this.collapsed[row.projectId], childCount: this.childCounts[row.projectId] || 0, color: row.color || colorOf(row.projectId) }));
      });
      const listHeight = Math.max(200, rows.reduce((height, row, index) => height + 100 + (!row.depth && index ? 18 : 0), 0));
      const desiredHeight = Math.max(listHeight, this.data.newOpen ? 360 : 0) * this.data.pickerScale;
      const bodyHeight = Math.max(1, Math.ceil(Math.min(this.data.bodyMaxHeight, desiredHeight)));
      const cardHeight = Math.min(this.data.cardMaxHeight, Math.ceil(330 * this.data.pickerScale + bodyHeight));
      this.setData({ rows, bodyHeight, cardHeight });
    },
    onListScroll(event) { if (!this.data.newOpen) this.lastListScrollTop = event.detail.scrollTop; },
    rowTap(event) {
      if (this.busy || this.data.loading || this.data.newOpen) return;
      const row = this.byId && this.byId[event.currentTarget.dataset.id];
      if (!row) return;
      if (this.childCounts[row.projectId]) { this.toggleExpand(event); return; }
      if (!this.data.organizing) return this.select(row.projectId);
    },
    toggleExpand(event) {
      if (this.busy || this.data.newOpen) return;
      const id = event.currentTarget.dataset.id;
      if (!this.childCounts[id]) return;
      this.collapsed[id] = !this.collapsed[id];
      this.renderRows();
    },
    toggleOrganize() {
      if (this.busy || this.data.loading || this.data.newOpen) return;
      this.setData({ organizing: !this.data.organizing });
    },
    async select(id) {
      if (this.busy || this.data.organizing || this.childCounts[id] || !this.byId[id] || !this.byId[id].startable) return false;
      this.busy = true;
      try {
        const result = await demoContext.appFor(this).globalData.service.savePrefs({ lastProjectId: id });
        if (!result.ok) { wx.showToast({ title: result.error.message, icon: 'none' }); return false; }
        this.triggerEvent('selected', { projectId: id });
        return true;
      } finally { this.busy = false; }
    },
    newProject(event) {
      if (this.data.loading || this.busy || this.data.creating) return;
      const id = event && event.currentTarget.dataset.id || '';
      const parentOptions = [{ projectId: '', label: '无上级 · 独立项目' }].concat((this.all || []).map(row => ({ projectId: row.projectId, label: this.pathLabel(row) })));
      const parentIndex = Math.max(0, parentOptions.findIndex(row => row.projectId === id));
      this.savedListScrollTop = this.lastListScrollTop || 0;
      this.setData({ newOpen: true, editorMode: 'create', editorId: parentOptions[parentIndex].projectId, parentOptions, parentIndex, parentLabel: parentOptions[parentIndex].label, newName: '', listScrollTop: 0 });
      this.renderRows();
    },
    pathLabel(row) {
      const names = [row.name], seen = { [row.projectId]: true };
      let parent = this.byId[row.parentId];
      while (parent && !seen[parent.projectId]) { names.unshift(parent.name); seen[parent.projectId] = true; parent = this.byId[parent.parentId]; }
      return names.join(' / ');
    },
    chooseParent(event) {
      if (this.busy || this.data.creating) return;
      const parentIndex = Number(event.detail.value), parent = this.data.parentOptions[parentIndex];
      if (parent) this.setData({ parentIndex, editorId: parent.projectId, parentLabel: parent.label });
    },
    cancelNew() {
      if (this.busy || this.data.creating) return;
      this.setData({ newOpen: false, editorMode: '', editorId: '', newName: '', listScrollTop: this.savedListScrollTop || 0 });
      this.renderRows();
    },
    async askDelete(event) {
      if (this.busy || !this.data.organizing) return;
      const id = event.currentTarget.dataset.id, token = this.token;
      this.busy = true;
      try {
        const result = await demoContext.appFor(this).globalData.service.getManageData();
        if (token !== this.token || !this.properties.opened) return;
        if (!result.ok) { wx.showToast({ title: result.error.message, icon: 'none' }); return; }
        const row = result.data.active.concat(result.data.archived).find(item => item.projectId === id);
        if (!row) return;
        this.savedListScrollTop = this.lastListScrollTop || 0;
        this.setData({ newOpen: true, editorMode: 'delete', editorId: id, editorLabel: '删除「' + row.name + '」？', deleteText: '包含 ' + row.subtreeProjectCount + ' 个项目和 ' + row.subtreeSessionCount + ' 条专注记录。删除后无法恢复。', listScrollTop: 0 });
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
        this.setData({ newOpen: false, editorMode: '', editorId: '', createdId: '', listScrollTop: this.savedListScrollTop || 0 });
        this.triggerEvent('changed');
        await this.load();
        wx.showToast({ title: '已删除', icon: 'success' });
      } finally { this.busy = false; this.setData({ creating: false }); }
    },
    inputName(event) { this.setData({ newName: event.detail.value }); },
    async create() {
      if (this.data.creating || this.busy || !this.data.newOpen || this.data.editorMode !== 'create') return;
      const name = this.data.newName.trim();
      if (!name) { wx.showToast({ title: '请输入名称', icon: 'none' }); return; }
      const parentId = this.data.editorId;
      this.busy = true;
      this.setData({ creating: true });
      try {
        const result = await demoContext.appFor(this).globalData.service.createProject({ operationId: uuid(), name, parentId: parentId || null });
        if (!result.ok) { wx.showToast({ title: result.error.message, icon: 'none' }); return; }
        let current = this.byId && this.byId[parentId];
        const seen = {};
        while (current && !seen[current.projectId]) { seen[current.projectId] = true; this.collapsed[current.projectId] = false; current = this.byId[current.parentId]; }
        this.setData({ newOpen: false, newName: '', editorMode: '', editorId: '', createdId: result.data.project.id, listScrollTop: this.savedListScrollTop || 0 });
        this.triggerEvent('changed');
        await this.load();
        wx.showToast({ title: '已添加', icon: 'success' });
      } finally { this.busy = false; this.setData({ creating: false }); }
    },
    goManage() { if (!this.busy && !this.data.creating) this.triggerEvent('openmanage'); }
  }
});
