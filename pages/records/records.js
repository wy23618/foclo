// pages/records/records.js
const format = require('../../utils/format.js');
const timeMod = require('../../core/time.js');
const { createRace } = require('../../utils/race.js');
const { colorOf } = require('../../utils/color.js');

const app = getApp();

function todayKey() {
  return timeMod.dayKey(Math.floor(Date.now() / 1000));
}

const MODE_ITEMS = [
  { key: 'realtime', label: '实时' },
  { key: 'completed', label: '已完成' }
];

Page({
  data: {
    date: '',
    dateLabel: '',
    weekday: '',
    isToday: true,
    canGoNext: false,
    totalText: '0秒',
    countText: '本范围0次专注',
    rows: [],
    loaded: false,
    page: 1,
    pageSize: 20,
    totalCount: 0,
    hasMore: false,
    mode: 'realtime',
    modeItems: MODE_ITEMS,
    scopeProjectId: null
  },

  onLoad(query) {
    this.race = createRace();
    query = query || {};
    this.setData({ date: timeMod.parseDayKey(query.date) == null ? todayKey() : query.date, mode: 'realtime', scopeProjectId: query.scope || null });
  },

  onShow() {
    require('../../utils/theme').applyPageTheme(this);
    const pending = app.globalData.pendingRecords;
    if (pending) {
      app.globalData.pendingRecords = null;
      this.setData({
        date: pending.date || this.data.date,
        scopeProjectId: pending.projectId || null
      });
    }
    this.load(true);
  },

  prevDay() {
    const idx = timeMod.parseDayKey(this.data.date);
    if (idx == null) return;
    this.setData({ date: timeMod.dayKeyOfIndex(idx - 1) });
    this.load(true);
  },

  nextDay() {
    const idx = timeMod.parseDayKey(this.data.date);
    if (idx == null) return;
    const next = timeMod.dayKeyOfIndex(idx + 1);
    // 未来日不进历史详情（§5.5）
    if (next > todayKey()) {
      wx.showToast({ title: '今天已经是最新日期', icon: 'none' });
      return;
    }
    this.setData({ date: next });
    this.load(true);
  },

  pickDate(e) {
    const date = e.detail.value;
    if (date > todayKey()) {
      wx.showToast({ title: '未来日期暂无记录', icon: 'none' });
      return;
    }
    this.setData({ date: date });
    this.load(true);
  },

  onSegMode(e) {
    this.setData({ mode: e.detail.key });
    this.load(true);
  },

  async load(reset) {
    const service = app.globalData.service;
    const page = reset ? 1 : this.data.page;
    // 请求上下文：日期/口径/范围任一变化后，晚到的旧结果一律丢弃
    const ctx = {
      date: this.data.date,
      mode: this.data.mode,
      scope: this.data.scopeProjectId || null
    };
    const token = this.race.next();
    const env = await service.getRecords({
      date: this.data.date,
      mode: this.data.mode,
      projectId: this.data.scopeProjectId || undefined,
      page: page,
      pageSize: this.data.pageSize
    });
    if (!this.race.isCurrent(token) || !this.ctxMatches(ctx)) return;
    if (!env.ok) {
      wx.showToast({ title: env.error.message, icon: 'none' });
      return;
    }
    const d = env.data;
    const dayIndex = timeMod.parseDayKey(this.data.date);
    if (dayIndex == null) return;
    const rows = d.rows.map((r) => ({
      sessionId: r.sessionId,
      projectId: r.projectId,
      color: colorOf(r.projectId),
      name: r.name,
      pathText: r.path.slice(0, -1).join(' / '),
      timeRange: format.timeOfDay(r.clippedStartedAtSec) + '–' + format.timeOfDay(r.clippedEndedAtSec),
      durationText: format.durationText(r.seconds),
      status: r.status,
      paused: r.paused
    }));
    // 注意：分页时本屏合计只代表已加载部分；全天总量以统计口径另取
    this.setData({
      rows: reset ? rows : this.data.rows.concat(rows),
      page: page,
      loaded: true,
      totalCount: d.totalCount,
      hasMore: page * d.pageSize < d.totalCount,
      dateLabel: this.dateLabelOf(this.data.date),
      weekday: format.WEEK_CN[timeMod.weekdayOfDayIndex(dayIndex)],
      isToday: this.data.date === todayKey(),
      canGoNext: this.data.date < todayKey()
    });
    this.loadDayTotal(ctx);
  },

  dateLabelOf(date) {
    const parts = (date || '').split('-');
    if (parts.length !== 3) return date;
    return Number(parts[1]) + '月' + Number(parts[2]) + '日';
  },

  ctxMatches(ctx) {
    return ctx.date === this.data.date &&
      ctx.mode === this.data.mode &&
      ctx.scope === (this.data.scopeProjectId || null);
  },

  async loadDayTotal(ctx) {
    const service = app.globalData.service;
    const token = this.race.current();
    const env = await service.getStatistics({
      startDate: ctx.date,
      endDate: ctx.date,
      mode: ctx.mode,
      projectId: ctx.scope || undefined
    });
    if (!this.race.isCurrent(token) || !this.ctxMatches(ctx)) return;
    if (!env.ok) return;
    this.setData({
      totalText: format.durationText(env.data.totalSeconds),
      countText: '本范围' + env.data.sessionCount + '次专注'
    });
  },

  loadMore() {
    if (!this.data.hasMore) return;
    this.setData({ page: this.data.page + 1 });
    this.load(false);
  },

  goProject(e) {
    const id = e.currentTarget.dataset.id;
    // 携带当前查看日期，下钻后仍保持同一时间范围
    wx.navigateTo({
      url: '/pages/project-stats/project-stats?id=' + id +
        '&preset=custom&startDate=' + this.data.date + '&endDate=' + this.data.date +
        '&mode=' + this.data.mode
    });
  }
});
