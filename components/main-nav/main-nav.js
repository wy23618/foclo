const demoContext = require('../../utils/demo-context');
Component({
  options: { styleIsolation: 'isolated' },
  properties: { demoSession: { type: String, value: '' },  selected: { type: Number, value: 0 }, hidden: { type: Boolean, value: false }, inline: { type: Boolean, value: false }, theme: { type: String, value: 'light' } },
  data: { list: [
    { pagePath: '/pages/focus/focus', text: '专注' },
    { pagePath: '/pages/stats/stats', text: '统计' },
    { pagePath: '/pages/settings/settings', text: '设置' }
  ] },
  methods: {
    switchTab(e) {
      if (this.navigating) return;
      const tab = this.data.list.findIndex(item => item.pagePath === e.currentTarget.dataset.path);
      if (tab < 0 || tab === this.properties.selected) return;
      if (this.properties.inline) { this.triggerEvent('change', { tab }); return; }
      this.navigating = true;
      if (this.properties.demoSession) {
        demoContext.openMainTab(this.properties.demoSession, tab, () => { this.navigating = false; });
        return;
      }
      require('../../utils/main-navigation').openMainTab(tab, () => { this.navigating = false; });
    }
  }
});
