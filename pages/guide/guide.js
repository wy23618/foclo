const { GUIDE_CARDS } = require('../../utils/user-guide');
const { applyPageTheme } = require('../../utils/theme');

const PREVIEW_LEVELS = { 2: 1, 4: 2, 6: 1, 7: 3, 9: 2, 10: 1, 12: 1, 13: 2, 14: 1, 16: 3, 17: 2, 19: 1, 20: 2, 22: 1, 23: 2, 25: 1, 27: 2, 28: 1, 30: 2 };
const PREVIEW_HEATMAP = Array.from({ length: 35 }, (_, index) => {
  const day = index - 2;
  return { day: day > 0 && day <= 31 ? String(day) : '', level: PREVIEW_LEVELS[day] || 0 };
});

const PREVIEW_BARS = [
  { label: '7时', height: 25 }, { label: '9时', height: 55 }, { label: '11时', height: 38 },
  { label: '14时', height: 82 }, { label: '16时', height: 48 }, { label: '20时', height: 66 }
];

Page({
  data: {
    themeClass: 'light',
    cards: GUIDE_CARDS,
    selectedId: '',
    selected: null,
    previewOpen: false,
    demoOpening: false,
    previewHeatmap: PREVIEW_HEATMAP,
    previewBars: PREVIEW_BARS
  },
  onLoad(options) {
    const id = options && options.chapter;
    const card = GUIDE_CARDS.find(item => item.id === (id === 'focus' ? 'runtime' : id));
    if (card) this.setData({ selectedId: card.id, selected: card });
  },
  onShow() { wx.setNavigationBarTitle({ title: '使用指南' }); applyPageTheme(this); },
  onUnload() { require('../../utils/demo-context').discardPreparedFeature(); },
  openPreview(e) {
    if (this.openingDemo) return;
    const id = e && e.currentTarget && e.currentTarget.dataset.id;
    const card = GUIDE_CARDS.find(item => item.id === id);
    if (!card) return;
    this.setData({ selectedId: card.id, selected: card, previewOpen: true });
    require('../../utils/demo-context').prepareFeature(card.id).catch(() => {});
  },
  closePreview() { if (!this.openingDemo) this.setData({ previewOpen: false }); },
  async tryDemo() {
    const card = GUIDE_CARDS.find(item => item.id === this.data.selectedId);
    if (!card || this.openingDemo) return;
    this.openingDemo = true;
    this.setData({ demoOpening: true });
    await require('../../utils/demo-context').openFeature(card.id, {
      success: () => this.setData({ previewOpen: false }),
      fail: () => wx.showToast({ title: '暂时无法打开演示，请重试', icon: 'none' }),
      complete: () => { this.openingDemo = false; this.setData({ demoOpening: false }); }
    });
  },
  startFocus() { require('../../utils/main-navigation').openMainTab(0); },
  noop() {}
});
