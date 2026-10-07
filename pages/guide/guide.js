const { QUICK_STEPS, CHAPTERS, FAQS } = require('../../utils/user-guide');
const { resolveTheme, navigationBarOptions } = require('../../utils/theme');

Page({
  data: { themeClass: 'light', quickSteps: QUICK_STEPS, chapters: CHAPTERS, faqs: FAQS, opened: {}, faqOpened: {}, demoHeatCells: [0,1,2,3,1,0,4,2,3,4,1,2,3,4].map((level, id) => ({ id, level })) },
  onLoad(options) {
    const chapter = options && options.chapter;
    if (CHAPTERS.some(item => item.id === chapter)) this.setData({ opened: { [chapter]: true } });
  },
  async onShow() {
    const app = getApp();
    if (!app.globalData.ready) await app.globalData.readyPromise;
    const prefs = await app.globalData.service.getPrefs();
    const themeClass = resolveTheme(prefs.theme || 'system', prefs.lightTheme);
    this.setData(require('../../utils/theme').pageThemeData(themeClass));
    wx.setNavigationBarColor(navigationBarOptions(themeClass));
  },
  openChapter(e) {
    const id = e.currentTarget.dataset.id;
    if (!CHAPTERS.some(item => item.id === id)) return;
    // Let the expanded content settle before computing the anchor position.
    this.setData({ ['opened.' + id]: true }, () => wx.nextTick(() => wx.pageScrollTo({ selector: '#guide-' + id, duration: 220 })));
  },
  toggleChapter(e) {
    const id = e.currentTarget.dataset.id;
    if (CHAPTERS.some(item => item.id === id)) this.setData({ ['opened.' + id]: !this.data.opened[id] });
  },
  toggleFaq(e) {
    const id = e.currentTarget.dataset.id;
    if (FAQS.some(item => item.id === id)) this.setData({ ['faqOpened.' + id]: !this.data.faqOpened[id] });
  },
  backToTop() { wx.pageScrollTo({ scrollTop: 0, duration: 220 }); }
});
