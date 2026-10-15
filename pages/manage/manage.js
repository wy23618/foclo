const { THEME_COLORS } = require('../../utils/theme');
// pages/manage/manage.js
const { uuid } = require('../../core/ids.js');
const { colorOf } = require('../../utils/color.js');
const app = getApp();

Page({
  data: {
    active: [],
    archived: [],
    visibleRows: [],
    expandedIds: [],
    draggingId: '', dragOffset: 0, dropTargetId: '', dropAfter: false, sortSettling: false,
    renameOpen:false, renameId:'', renameValue:'', renameOriginal:'', renameFocus:false, renameCanSave:false, renameSaving:false,
    searchOpen: false, searchFocus: false, searchQuery: '',
    loading: true,
    tab: 'active',
    tabItems: [
      { key: 'active', label: '在用项目' },
      { key: 'archived', label: '已归档' }
    ]
  },

  onShow() {
    require('../../utils/theme').applyPageTheme(this);
    this.load();
  },

  onHide() {
    if (this.data.draggingId) this.finishSort(null, false);
  },

  onPageScroll(e) {
    const top = Number(e && e.scrollTop) || 0;
    if (!this.data.draggingId) { this.lastPageScrollTop = top; return; }
    if (this.sortRestoringScroll || !Number.isFinite(this.sortLockedScrollTop) || Math.abs(top - this.sortLockedScrollTop) < 1) return;
    this.sortRestoringScroll = true;
    wx.pageScrollTo({ scrollTop:this.sortLockedScrollTop, duration:0, complete:()=>{ this.sortRestoringScroll=false; } });
  },

  async load(options) {
    options = options || {};
    if (!options.silent) this.setData({ loading: true });
    const service = app.globalData.service;
    const env = await service.getManageData();
    if (!env.ok) {
      this.setData({ loading: false });
      wx.showToast({ title: env.error.message, icon: 'none' });
      return;
    }
    const describe = rows => {
      const ids = new Set(rows.map(row => row.projectId)), counts = {};
      rows.forEach(row => { if (ids.has(row.parentId)) counts[row.parentId] = (counts[row.parentId] || 0) + 1; });
      return rows.map(row => Object.assign({}, row, {
        displayColor: row.color || colorOf(row.projectId),
        parentPathText: row.path.length > 1 ? row.path.slice(0, -1).join(' / ') : '顶级项目',
        childCount: counts[row.projectId] || 0
      }));
    };
    const active = describe(env.data.active);
    const archived = describe(env.data.archived);
    const patch = {
      active,
      archived,
      loading: false,
      visibleRows: this.filterRows(this.data.tab, this.data.searchQuery, active, archived, options.expandedIds || this.data.expandedIds),
      tabItems: [
        { key: 'active', label: '在用项目（' + env.data.active.length + '）' },
        { key: 'archived', label: '已归档（' + env.data.archived.length + '）' }
      ]
    };
    if (options.expandedIds) patch.expandedIds = options.expandedIds;
    if (options.clearSort) Object.assign(patch, { draggingId:'', dragOffset:0, dropTargetId:'', dropAfter:false, sortSettling:false });
    this.setData(patch);
  },

  switchTab(e) {
    const tab = e.detail.key;
    this.setData({ tab, visibleRows: this.filterRows(tab, this.data.searchQuery) });
  },

  filterRows(tab, query, active = this.data.active, archived = this.data.archived, expandedIds = this.data.expandedIds) {
    const rows = tab === 'active' ? active : archived;
    const needle = String(query || '').trim().toLowerCase();
    if (needle) return rows.filter(row => [row.name, row.shortName, (row.path || []).join(' ')].some(value => String(value || '').toLowerCase().includes(needle))).map(row => Object.assign({}, row, {indent:0,searchResult:true,metaText:row.parentPathText+' · '+row.subtreeSessionCount+' 条记录'}));
    const byId = new Map(rows.map(row => [row.projectId, row]));
    const expanded = new Set(expandedIds);
    return rows.reduce((visible, row) => {
      let parentId = row.parentId, depth = 0, show = true;
      while (parentId && byId.has(parentId)) {
        if (!expanded.has(parentId)) { show = false; break; }
        parentId = byId.get(parentId).parentId;
        if (++depth > rows.length) { show = false; break; }
      }
      if (show) visible.push(Object.assign({}, row, {indent:Math.min(depth, 4)*24, expanded:expanded.has(row.projectId), searchResult:false, metaText:(row.childCount ? '包含 '+row.childCount+' 个项目 · ' : '')+row.subtreeSessionCount+' 条记录'}));
      return visible;
    }, []);
  },
  toggleGroup(e) {
    if (this.data.draggingId || Date.now() < (this.sortSuppressTapUntil || 0)) return;
    const id = e.currentTarget.dataset.id, row = this.findRow(id);
    if (!row || !row.childCount || this.data.searchQuery) return;
    const expandedIds = this.data.expandedIds.includes(id) ? this.data.expandedIds.filter(value => value !== id) : this.data.expandedIds.concat(id);
    this.setData({ expandedIds }, () => this.setData({ visibleRows: this.filterRows(this.data.tab, '') }));
  },
  toggleSearch() {
    const searchOpen = !this.data.searchOpen;
    this.setData({ searchOpen, searchFocus: searchOpen, searchQuery: searchOpen ? this.data.searchQuery : '', visibleRows: this.filterRows(this.data.tab, searchOpen ? this.data.searchQuery : '') });
  },
  inputSearch(e) {
    const searchQuery = e.detail.value || '';
    this.setData({ searchQuery, visibleRows: this.filterRows(this.data.tab, searchQuery) });
  },
  clearSearch() { this.setData({ searchQuery: '', visibleRows: this.filterRows(this.data.tab, '') }); },

  openAppearanceById(e) {
    if (this.data.draggingId || Date.now() < (this.sortSuppressTapUntil || 0)) return;
    const row = this.findRow(e.currentTarget.dataset.id);
    if (row) wx.navigateTo({ url: '/pages/project-appearance/project-appearance?id=' + encodeURIComponent(row.projectId) });
  },

  openActions(e) {
    if (this.sortSaving || this.data.draggingId || Date.now() < (this.sortSuppressTapUntil || 0)) return;
    const row = this.findRow(e.currentTarget.dataset.id);
    if (!row) return;
    const labels = row.archived
      ? ['恢复项目', '重命名', '颜色与简称', '永久删除']
      : ['重命名', '颜色与简称', '归档项目', '永久删除'];
    wx.showActionSheet({ itemList: labels, success: result => {
      const action = labels[result.tapIndex];
      if (action === '重命名') this.onRename(row);
      else if (action === '颜色与简称') this.openAppearanceById(e);
      else if (action === '归档项目') this.onArchive(row.projectId);
      else if (action === '恢复项目') this.onRestore(row.projectId);
      else if (action === '永久删除') this.onDelete(row.projectId);
    } });
  },

  sortTouchStart(e) {
    const touch = e.touches && e.touches[0];
    if (touch) this.sortStartY = this.sortLastY = touch.clientY;
  },
  sortLongPress(e) {
    this.sortSuppressTapUntil = Date.now() + 900;
    if (this.data.searchQuery) { wx.showToast({ title: '清除搜索后可调整顺序', icon: 'none' }); return; }
    if (this.data.loading || this.sortSaving || this.data.draggingId) return;
    const id = e.currentTarget.dataset.id, row = this.findRow(id);
    if (!row) return;
    const siblings = (this.data.tab === 'active' ? this.data.active : this.data.archived).filter(item => item.parentId === row.parentId);
    if (siblings.length < 2) { wx.showToast({ title: '当前层级只有一个项目', icon: 'none' }); return; }
    this.sortRects = null;
    this.sortSiblingIds = siblings.map(item => item.projectId);
    this.sortRestoreExpanded = this.data.expandedIds.slice();
    this.sortLockedScrollTop = Number(this.lastPageScrollTop) || 0;
    const expandedIds = this.data.expandedIds.filter(value => !this.sortSiblingIds.includes(value));
    this.setData({ expandedIds, draggingId: id, dragOffset: 0, dropTargetId: '', dropAfter: false, sortSettling:false }, () => {
      this.setData({ visibleRows: this.filterRows(this.data.tab, '') }, () => {
        this.createSelectorQuery().selectAll('.mg-item').boundingClientRect(rects => {
          if (this.data.draggingId !== id || !rects) return;
          this.sortRects = new Map(this.data.visibleRows.map((item, index) => [item.projectId, rects[index]]));
          const draggedRect = this.sortRects.get(id);
          this.sortPointerOffset = draggedRect ? this.sortStartY - draggedRect.top : 0;
          this.sortOriginalIndex = this.sortSiblingIds.indexOf(id);
        }).exec();
      });
    });
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
  },
  sortDropAt(y) {
    if (!this.sortRects || !this.sortSiblingIds) return { id: '', after: false };
    const draggedRect = this.sortRects.get(this.data.draggingId);
    const remaining = this.sortSiblingIds.filter(id => id !== this.data.draggingId && this.sortRects.get(id));
    if (!draggedRect || !remaining.length) return { id: '', after: false };
    const draggedCenter = y - (this.sortPointerOffset || 0) + draggedRect.height / 2;
    let destinationIndex = 0;
    while (destinationIndex < remaining.length) {
      const rect = this.sortRects.get(remaining[destinationIndex]);
      if (draggedCenter <= rect.top + rect.height / 2) break;
      destinationIndex++;
    }
    if (destinationIndex >= remaining.length) return { id: remaining[remaining.length - 1], after: true, destinationIndex };
    return { id: remaining[destinationIndex], after: false, destinationIndex };
  },
  sortPreview(drop) {
    const originalIndex = this.sortOriginalIndex, destinationIndex = drop && Number.isInteger(drop.destinationIndex) ? drop.destinationIndex : originalIndex;
    const draggedRect = this.sortRects && this.sortRects.get(this.data.draggingId), distance = draggedRect ? draggedRect.height : 0;
    const shifts = {};
    if (destinationIndex > originalIndex) {
      for (let i=originalIndex+1;i<=destinationIndex;i++) shifts[this.sortSiblingIds[i]]=-distance;
    } else if (destinationIndex < originalIndex) {
      for (let i=destinationIndex;i<originalIndex;i++) shifts[this.sortSiblingIds[i]]=distance;
    }
    return this.data.visibleRows.map(item => Object.assign({}, item, { sortShift: shifts[item.projectId] || 0 }));
  },
  sortSlotOffset(destinationIndex) {
    if (!this.sortRects || !Number.isInteger(destinationIndex)) return 0;
    const draggedRect = this.sortRects.get(this.data.draggingId), slotId = this.sortSiblingIds[destinationIndex], slotRect = this.sortRects.get(slotId);
    return draggedRect && slotRect ? slotRect.top - draggedRect.top : 0;
  },
  sortTouchMove(e) {
    if (!this.data.draggingId || this.data.sortSettling || e.currentTarget.dataset.id !== this.data.draggingId) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    this.sortLastY = touch.clientY;
    const dragOffset = touch.clientY - this.sortStartY;
    const drop = Math.abs(dragOffset) > 20 ? this.sortDropAt(touch.clientY) : { id: '', after: false };
    if (drop.id === this.data.dropTargetId && drop.after === this.data.dropAfter) { this.setData({ dragOffset }); return; }
    this.setData({ dragOffset, dropTargetId: drop.id, dropAfter: drop.after, visibleRows:this.sortPreview(drop) });
  },
  sortTouchCancel() { this.finishSort(null, false); },
  sortTouchEnd(e) {
    const touch = e.changedTouches && e.changedTouches[0];
    const y = touch && Number(touch.clientY);
    const finalTouch = Number.isFinite(y) && (y !== 0 || !Number.isFinite(this.sortLastY)) ? touch : { clientY: this.sortLastY };
    this.finishSort(finalTouch, true);
  },
  async finishSort(touch, commit) {
    const projectId = this.data.draggingId;
    if (!projectId || this.data.sortSettling) return;
    const offset = touch ? touch.clientY - this.sortStartY : 0;
    const drop = commit && Math.abs(offset) > 20 ? this.sortDropAt(touch.clientY) : { id: '', after: false };
    const expandedIds = this.sortRestoreExpanded || [];
    this.sortSuppressTapUntil = Date.now() + 600;
    if (!drop.id || drop.destinationIndex === this.sortOriginalIndex) {
      this.setData({ sortSettling:true, dragOffset:0, dropTargetId:'', dropAfter:false, visibleRows:this.sortPreview(null) });
      await new Promise(resolve=>setTimeout(resolve,190));
      this.sortRects=null;this.sortSiblingIds=null;this.sortRestoreExpanded=null;this.sortPointerOffset=null;this.sortOriginalIndex=null;this.sortLockedScrollTop=null;this.sortLastY=null;
      this.setData({ expandedIds, draggingId:'', dragOffset:0, sortSettling:false },()=>this.setData({visibleRows:this.filterRows(this.data.tab,'')}));
      return;
    }
    const slotOffset=this.sortSlotOffset(drop.destinationIndex);
    this.setData({sortSettling:true,dragOffset:slotOffset,visibleRows:this.sortPreview(drop)});
    this.sortSaving = true;
    const [env] = await Promise.all([app.globalData.service.moveProjectOrder({ operationId: uuid(), projectId, targetProjectId: drop.id, after: drop.after }),new Promise(resolve=>setTimeout(resolve,190))]);
    this.sortSaving = false;
    this.sortRects=null;this.sortSiblingIds=null;this.sortRestoreExpanded=null;this.sortPointerOffset=null;this.sortOriginalIndex=null;this.sortLockedScrollTop=null;this.sortLastY=null;
    if (!env.ok) {
      this.setData({expandedIds,sortSettling:true,dragOffset:0,dropTargetId:'',dropAfter:false,visibleRows:this.data.visibleRows.map(item=>Object.assign({},item,{sortShift:0}))});
      await new Promise(resolve=>setTimeout(resolve,190));
      this.setData({draggingId:'',dragOffset:0,sortSettling:false},()=>this.setData({visibleRows:this.filterRows(this.data.tab,'')}));
      wx.showToast({ title: env.error.message, icon: 'none' });
      return;
    }
    if (env.data.changed) await this.load({silent:true,clearSort:true,expandedIds});
    else this.setData({expandedIds,draggingId:'',dragOffset:0,dropTargetId:'',dropAfter:false,sortSettling:false},()=>this.setData({visibleRows:this.filterRows(this.data.tab,'')}));
  },

  async onArchive(id) {
    const env = await app.globalData.service.archiveProject({ operationId: uuid(), projectId: id });
    if (!env.ok) wx.showToast({ title: env.error.message, icon: 'none' });
    else this.load();
  },

  async onRestore(id) {
    const env = await app.globalData.service.restoreProject({ operationId: uuid(), projectId: id });
    if (!env.ok) wx.showToast({ title: env.error.message, icon: 'none' });
    else this.load();
  },

  onRename(row) {
    this.setData({renameOpen:true,renameId:row.projectId,renameValue:row.name,renameOriginal:row.name,renameFocus:false,renameCanSave:true,renameSaving:false},()=>this.setData({renameFocus:true}));
  },
  inputRename(e) {
    const renameValue=e.detail.value||'';
    this.setData({renameValue,renameCanSave:!!renameValue.trim()});
  },
  cancelRename() {
    if(this.data.renameSaving)return;
    this.setData({renameOpen:false,renameId:'',renameValue:'',renameOriginal:'',renameFocus:false,renameCanSave:false});
  },
  async saveRename() {
    if(this.data.renameSaving)return;
    const name=String(this.data.renameValue||'').trim();
    if(!name){wx.showToast({title:'请输入项目名称',icon:'none'});return;}
    if(name===this.data.renameOriginal){this.cancelRename();return;}
    this.setData({renameSaving:true,renameFocus:false});
    const env=await app.globalData.service.renameProject({operationId:uuid(),projectId:this.data.renameId,name});
    if(!env.ok){this.setData({renameSaving:false,renameFocus:true});wx.showToast({title:env.error.message,icon:'none'});return;}
    this.setData({renameOpen:false,renameId:'',renameValue:'',renameOriginal:'',renameFocus:false,renameCanSave:false,renameSaving:false});
    this.load();
  },

  noop() {},

  onDelete(id) {
    const row = this.findRow(id);
    if (!row) return;
    const self = this;
    wx.showModal({
      title: '永久删除',
      content: '「' + row.name + '」及子项目共 ' + row.subtreeProjectCount + ' 个，关联 ' + row.subtreeSessionCount + ' 条记录。删除后无法恢复。',
      confirmText: '永久删除',
      confirmColor: THEME_COLORS.light.dangerText,
      success(res) {
        if (res.confirm) self.doDelete(id);
      }
    });
  },

  findRow(id) {
    const all = this.data.active.concat(this.data.archived);
    for (let i = 0; i < all.length; i++) {
      if (all[i].projectId === id) return all[i];
    }
    return null;
  },

  async doDelete(id) {
    const scrollTop = Math.max(0, Number(this.lastPageScrollTop) || 0);
    const env = await app.globalData.service.deleteProject({ operationId: uuid(), projectId: id });
    if (!env.ok) {
      wx.showToast({ title: env.error.message, icon: 'none' });
      return;
    }
    wx.showToast({ title: '已删除', icon: 'success' });
    await this.load({ silent: true });
    wx.pageScrollTo({ scrollTop, duration: 0 });
  },

  goProject(e) {
    if (this.data.draggingId || Date.now() < (this.sortSuppressTapUntil || 0)) return;
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/project-stats/project-stats?id=' + id });
  }
});
