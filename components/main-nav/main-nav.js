Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    selected: { type: Number, value: 0 },
    hidden: { type: Boolean, value: false },
    inline: { type: Boolean, value: false },
    theme: { type: String, value: 'light' }
  },
  data: {
    list: [
      { pagePath: '/pages/focus/focus', text: '专注' },
      { pagePath: '/pages/stats/stats', text: '统计' },
      { pagePath: '/pages/settings/settings', text: '设置' }
    ]
  },
  methods: {
    switchTab(e) {
      if (this.navigating) return;
      const path = e.currentTarget.dataset.path;
      if (path === this.data.list[this.properties.selected].pagePath) return;
      if (this.properties.inline) {
        this.triggerEvent('change', { tab: this.data.list.findIndex(item => item.pagePath === path) });
        return;
      }
      this.navigating = true;
      const done = () => { this.navigating = false; };
      const focus = '/pages/focus/focus';
      const settings = '/pages/settings/settings';
      const pages = getCurrentPages();
      const focusIndex = pages.findIndex(page => page.route === 'pages/focus/focus');
      const returnToFocus = callback => {
        if (focusIndex >= 0 && focusIndex < pages.length - 1) {
          wx.navigateBack({ delta: pages.length - 1 - focusIndex, success: callback, fail: () => wx.reLaunch({ url: focus, success: callback, fail: done }) });
        } else {
          wx.reLaunch({ url: focus, success: callback, fail: done });
        }
      };
      if (path === '/pages/stats/stats') {
        const open = this.properties.selected === 2 ? wx.redirectTo : wx.navigateTo;
        open({ url: path, complete: done });
      } else if (path === focus) {
        returnToFocus(done);
      } else if (this.properties.selected === 0) {
        wx.navigateTo({ url: settings, complete: done });
      } else {
        wx.navigateTo({ url: settings, complete: done });
      }
    }
  }
});
