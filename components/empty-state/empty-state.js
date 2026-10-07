// components/empty-state/empty-state.js
// 统一空状态：柔和圆形底 + CSS 线性图标 + 主文案/副提示。
// icon: 'clock'（无记录）| 'list'（无条目）| 'box'（空归档）| 'chart'（无统计）
Component({
  properties: {
    icon: { type: String, value: 'clock' },
    text: { type: String, value: '暂无内容' },
    hint: { type: String, value: '' }
  }
});
