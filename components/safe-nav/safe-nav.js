const { navigationColors } = require('../../utils/theme');
const { navigationMetrics } = require('../../utils/window-layout');
Component({
  properties: {
    theme: { type: String, value: 'light' }, title: String, brand: Boolean,
    backText: String, shortcut: String, refresh: Boolean, refreshing: Boolean, hidden: Boolean
  },
  data: { top: 32, barHeight: 32, navHeight: 78, rightInset: 100, background: navigationColors('light').background, inkColor: navigationColors('light').inkColor },
  observers: { theme(value) { this.applyTheme(value); } },
  lifetimes: {
    attached() { this.navAttached = true; this.applyTheme(this.properties.theme); this.measure(); },
    ready() { this.measure(); },
    detached() { this.navAttached = false; clearTimeout(this.heightTimer); }
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
      // Creating this component can be part of a parent's setData. A synchronous
      // height event would update that parent recursively and lose its callback.
      clearTimeout(this.heightTimer);
      this.heightTimer = setTimeout(() => {
        if (this.navAttached === false || this.lastHeight === metrics.navHeight) return;
        this.lastHeight = metrics.navHeight;
        this.triggerEvent('heightchange', { height: metrics.navHeight });
      }, 0);
    },
    back() { this.triggerEvent('back'); },
    shortcutTap() { this.triggerEvent('shortcut'); },
    refreshTap() { if (!this.properties.refreshing) this.triggerEvent('refresh'); }
  }
});
