// components/daily-bars/daily-bars.js
// 每日专注时长横向柱状图：柱顶简短时长（零显“—”），柱底 M/D，可横滑。
// 数据来自统计服务的 dailySeries（只读），组件不做任何计算口径，只做展示换算。
const format = require('../../utils/format.js');

const PLOT_H = 180; // rpx

Component({
  properties: {
    landscapeLayout: { type: Boolean, value: false },
    series: { type: Array, value: [], observer: 'build' }
  },
  data: { cols: [], plotWidth: 0, scrollTarget: '' },
  methods: {
    build() {
      const list = this.properties.series || [];
      let max = 0;
      list.forEach((d) => { if (d.seconds > max) max = d.seconds; });
      const cols = list.map((d) => {
        const parts = (d.date || '').split('-');
        const md = parts.length === 3
          ? Number(parts[1]) + '/' + Number(parts[2])
          : '';
        return {
          date: d.date, anchor: 'bar-'+d.date,
          md: md,
          barH: max > 0 ? Math.max(d.seconds > 0 ? 8 : 0, Math.round(d.seconds / max * PLOT_H)) : 0,
          label: format.heatDurationText(d.seconds),
          positive: d.seconds > 0
        };
      });
      this.setData({cols,plotWidth:Math.max(100,cols.length*86),scrollTarget:''},()=>{const now=require('../../utils/view-data').today();const target=cols.find(c=>c.date===now)||cols[cols.length-1];if(target)this.setData({scrollTarget:target.anchor});});
    },
    selectDay(e) {
      this.triggerEvent('select', { date: e.currentTarget.dataset.date });
    }
  }
});
