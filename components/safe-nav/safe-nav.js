const { navigationColors } = require('../../utils/theme');
const { navigationMetrics } = require('../../utils/window-layout');
Component({
  properties: {
    theme: { type: String, value: 'light' }, title: String, brand: Boolean,
    backText: String, shortcut: String, refresh: Boolean, hidden: Boolean
  },
  data: { top: 32, barHeight: 32, navHeight: 78, rightInset: 100, background: navigationColors('light').background, inkColor: navigationColors('light').inkColor },
  observers: { theme(value) { this.applyTheme(value); } },
  lifetimes: {
    attached() { this.applyTheme(this.properties.theme); this.measure(); },
    ready() { this.measure(); }
  },
  pageLifetimes: { resize() { this.measure(); } },
  methods: {
    applyTheme(theme) {
      const colors = navigationColors(theme);
      this.setData({ background: colors.background, inkColor: colors.inkColor });
    },
    measure() {
      let info = { windowWidth: 375, statusBarHeight: 24 };
      try { info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); } catch (e) {}
      let menu;
      try { menu = wx.getMenuButtonBoundingClientRect(); } catch (e) {}
      const metrics = navigationMetrics(info, menu);
      if (Object.keys(metrics).some(key => this.data[key] !== metrics[key])) this.setData(metrics);
      this.triggerEvent('heightchange', { height: metrics.navHeight });
    },
    back() { this.triggerEvent('back'); },
    shortcutTap() { this.triggerEvent('shortcut'); },
    refreshTap() { this.triggerEvent('refresh'); }
  }
});
