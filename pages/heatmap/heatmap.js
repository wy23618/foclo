const format = require('../../utils/format');
const time = require('../../core/time');
const view = require('../../utils/view-data');
const heatColor = require('../../utils/heat-color');
const app = getApp();
const monthNow = () => view.today().slice(0, 7);

Page({
  data: {
    monthKey: '', currentMonth: monthNow(), monthTitle: '',
    scopeProjectId: '', scopeName: '全部项目', scopeOptions: [{ id: '', name: '全部项目' }], scopeIndex: 0,
    grid: [], weekHead: ['一', '二', '三', '四', '五', '六', '日'],
    monthTotalText: '0秒', activeDays: 0, canGoNext: false,
    loaded: false, error: ''
  },

  onLoad(q) {
    this.seq = 0;
    this.setData({ monthKey: monthNow(), scopeProjectId: q.scope || '' });
    this.loadScopes();
  },
  async onShow() {
    await require('../../utils/theme').applyPageTheme(this);
    this.load();
  },
  onUnload() {
    this.seq++;
  },

  async loadScopes() {
    await app.globalData.readyPromise;
    const e = await app.globalData.service.getManageData();
    if (!e.ok) return;
    const options = [{ id: '', name: '全部项目' }].concat(e.data.active.concat(e.data.archived).map(r => ({ id: r.projectId, name: r.pathText || r.name })));
    this.setData({ scopeOptions: options, scopeIndex: Math.max(0, options.findIndex(r => r.id === this.data.scopeProjectId)) });
  },
  pickScope(e) {
    const i = Number(e.detail.value);
    this.setData({ scopeIndex: i, scopeProjectId: this.data.scopeOptions[i].id });
    this.load();
  },
  moveMonth(delta) {
    const p = time.parseMonthKey(this.data.monthKey);
    const d = new Date(Date.UTC(p.year, p.month - 1 + delta, 1));
    const key = d.getUTCFullYear() + '-' + format.pad2(d.getUTCMonth() + 1);
    if (key > monthNow()) return;
    this.setData({ monthKey: key });
    this.load();
  },
  prevMonth() { this.moveMonth(-1); },
  nextMonth() { this.moveMonth(1); },
  pickMonth(e) {
    if (e.detail.value > monthNow()) return;
    this.setData({ monthKey: e.detail.value });
    this.load();
  },
  touchStart(e) {
    const p = e.touches[0];
    this.gesture = { x: p.clientX, y: p.clientY };
  },
  touchEnd(e) {
    if (!this.gesture) return;
    const p = e.changedTouches[0], dx = p.clientX - this.gesture.x, dy = p.clientY - this.gesture.y;
    this.gesture = null;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) this.moveMonth(dx < 0 ? 1 : -1);
  },
  async load() {
    const token = ++this.seq;
    await app.globalData.readyPromise;
    const e = await app.globalData.service.getHeatmap({ monthKey: this.data.monthKey, scopeProjectId: this.data.scopeProjectId || null });
    if (token !== this.seq) return;
    if (!e.ok) { this.setData({ error: e.error.message }); return; }
    const prefs = await app.globalData.service.getPrefs();
    if (token !== this.seq) return;
    const sunday = !!(prefs && prefs.weekStartsSunday);
    const d = e.data, p = time.parseMonthKey(this.data.monthKey);
    const mondayOffset = time.weekdayOfDayIndex(p.startIndex), offset = sunday ? (mondayOffset + 1) % 7 : mondayOffset;
    const count = Math.max(35, Math.ceil((offset + d.cells.length) / 7) * 7);
    const lookup = {};
    d.cells.forEach(c => { lookup[c.date] = c; });
    const flat = Array.from({ length: count }, (_, i) => {
      const date = time.dayKeyOfIndex(p.startIndex - offset + i), c = lookup[date];
      return c ? Object.assign({}, c, { shortText: format.heatDurationText(c.seconds), isToday: date === view.today(), heatStyle: heatColor.heatStyle(c.seconds, this.data.themeClass) }) : { date, day: Number(date.slice(-2)), outside: true };
    });
    const grid = [];
    for (let i = 0; i < count; i += 7) grid.push(flat.slice(i, i + 7));
    this.setData({
      grid, weekHead: sunday ? ['日', '一', '二', '三', '四', '五', '六'] : ['一', '二', '三', '四', '五', '六', '日'],
      monthTitle: d.year + '年' + d.month + '月', scopeName: d.scopeName || '全部项目',
      monthTotalText: format.durationText(d.cells.reduce((s, c) => s + c.seconds, 0)),
      activeDays: d.cells.filter(c => c.seconds > 0).length,
      canGoNext: this.data.monthKey < monthNow(), loaded: true, error: ''
    });
  },
  onCellTap(e) {
    const c = e.currentTarget.dataset.cell;
    if (!c || c.outside || c.isFuture || c.date > view.today()) return;
    wx.navigateTo({ url: '/pages/day-stats/day-stats?date=' + c.date + '&scope=' + encodeURIComponent(this.data.scopeProjectId || '') });
  },
  back() { wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/stats/stats' }) }); }
});
