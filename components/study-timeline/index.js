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
      this.setData(Object.assign({}, buildTimeline(records, colorMap), { activeKey: '', managementRows: managementRows(records) }));
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
      wx.showActionSheet({ itemList: ['删除这条记录'], success: result => {
        if (result.tapIndex === 0) this.triggerEvent('deleterecord', { sessionId: row.id });
      }});
    },
    onPick(e) {
      const key = e.currentTarget.dataset.key;
      this.setData({ activeKey: this.data.activeKey === key ? '' : key });
    },
  },
});
