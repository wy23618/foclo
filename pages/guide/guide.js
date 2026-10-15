const { QUICK_STEPS, CHAPTERS } = require('../../utils/user-guide');
const { resolveTheme, navigationBarOptions, pageThemeData, THEME_COLORS } = require('../../utils/theme');
Page({
  data: { themeClass:'light', quickSteps:QUICK_STEPS, chapters:CHAPTERS, opened:{}, cardIndex:0 },
  onLoad(options) {
    const chapter = options && options.chapter;
    if (CHAPTERS.some(item => item.id === chapter)) this.setData({ opened:{ [chapter]:true } });
  },
  async onShow() {
    const app = getApp();
    if (!app.globalData.ready) await app.globalData.readyPromise;
    const prefs = await app.globalData.service.getPrefs();
    const themeClass = resolveTheme(prefs.theme || 'system', prefs.lightTheme);
    const colors = THEME_COLORS[themeClass] || THEME_COLORS.light;
    this.setData(Object.assign({}, pageThemeData(themeClass), { indicatorColor:colors.chartMuted, indicatorActiveColor:colors.focusProgress }));
    wx.setNavigationBarColor(navigationBarOptions(themeClass));
  },
  onCardChange(e) { this.setData({ cardIndex:e.detail.current }); },
  toggleChapter(e) {
    const id = e.currentTarget.dataset.id;
    if (CHAPTERS.some(item => item.id === id)) this.setData({ ['opened.' + id]:!this.data.opened[id] });
  },
  startFocus() {
    const pages = getCurrentPages();
    const shellIndex = pages.findIndex(page => page.route === 'pages/focus/focus');
    if (shellIndex >= 0 && shellIndex < pages.length - 1) {
      const shell = pages[shellIndex];
      shell.switchMainTab({ detail:{ tab:0 } });
      wx.navigateBack({ delta:pages.length - 1 - shellIndex });
    } else wx.reLaunch({ url:'/pages/focus/focus' });
  }
});
