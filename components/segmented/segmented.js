// components/segmented/segmented.js
// 统一分段控件：井底色 + 白色/绿色选中板。
// properties:
//   items    : [{ key: 'today', label: '今日' }]
//   selected : 当前选中 key
//   tone     : 'green'（默认，选中板森林绿）| 'light'（选中板白底绿字，用于浅井内）
Component({
  properties: {
    items: { type: Array, value: [] },
    selected: { type: String, value: '' },
    tone: { type: String, value: 'green' }
  },
  methods: {
    onTap(e) {
      const key = e.currentTarget.dataset.key;
      if (key === this.data.selected) return;
      this.triggerEvent('change', { key: key });
    }
  }
});
