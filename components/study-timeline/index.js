const { buildTimeline } = require('../../utils/studyTimeline');
const { managementRows } = require('../../utils/record-management');

Component({
  properties: {
    records: { type: Array, value: [] },
    colorMap: { type: Object, value: {} },
    heading: { type: String, value: '今日学习记录' },
    managing: { type: Boolean, value: false },
  },
  data: {
    empty: true,
    count: 0,
    totalText: '',
    segments: [],
    rows: [],
    ticks: [],
    activeKey: '',
    managementRows: [],
  },
  observers: {
    'records, colorMap': function (records, colorMap) {
      const managedRows = managementRows(records);
      const maxDuration = Math.max(1, ...managedRows.map(row => Number(row.durationSeconds) || 0));
      managedRows.forEach(row => {
        row.barPct = Math.max((Number(row.durationSeconds) / maxDuration) * 100, 4).toFixed(1);
      });
      this.setData(Object.assign({}, buildTimeline(records, colorMap), { activeKey: '', managementRows: managedRows }));
    },
  },
  methods: {
    toggleManagement() {
      this.triggerEvent('managementchange', { managing: !this.data.managing });
      this.setData({ activeKey: '' });
    },
    onRecordMenu(e) {
      const row = this.data.managementRows.find(item => item.id === e.currentTarget.dataset.id);
      if (!row || !row.canDelete) return;
      const actions = row.canReduce ? ['调整专注时长', '删除这条记录'] : ['删除这条记录'];
      wx.showActionSheet({ itemList: actions, success: result => {
        if (result.tapIndex < 0 || result.tapIndex >= actions.length) return;
        this.triggerEvent(row.canReduce && result.tapIndex === 0 ? 'reducerecord' : 'deleterecord', { sessionId: row.id });
      }});
    },
    onPick(e) {
      const key = e.currentTarget.dataset.key;
      this.setData({ activeKey: this.data.activeKey === key ? '' : key });
    },
  },
});
