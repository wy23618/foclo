const { exactDuration } = require('../../utils/record-management');
function range(max) { return Array.from({ length: max + 1 }, (_, value) => value); }

Component({
  properties: {
    theme: { type: String, value: 'light' }, opened: { type: Boolean, value: false },
    durationSeconds: { type: Number, value: 0 }, projectName: { type: String, value: '' },
    recordTime: { type: String, value: '' }, busy: { type: Boolean, value: false },
    error: { type: String, value: '' }
  },
  data: {
    hourOptions: [0], minuteOptions: [0], wheelValue: [0, 0], wheelEditing: false,
    originalText: '', remainingText: '', valid: false,
    message: '', bodyHeight: 300, overlayStyle: ''
  },
  observers: {
    'opened, durationSeconds'(opened, duration) {
      if (!opened) return;
      this.bodyContentHeight = 0;
      this.measureGeneration = (this.measureGeneration || 0) + 1;
      const minutes = Math.max(0, Math.ceil(duration / 60) - 1);
      const hours = Math.floor(minutes / 60), minute = minutes % 60;
      const targetSeconds = minutes * 60;
      this.setData({
        hourOptions: range(hours), minuteOptions: range(minute),
        wheelValue: [hours, minute], wheelEditing: false, originalText: exactDuration(duration),
        remainingText: exactDuration(targetSeconds), valid: Number.isSafeInteger(duration) && duration >= 60,
        message: duration >= 60 ? '选择调整后的时长，最多 ' + exactDuration(targetSeconds) : '不足 1 分钟，无法按分钟调整'
      });
      this.updateViewport(); this.measureBody();
    },
    error() { this.measureBody(); }
  },
  lifetimes: { ready() { this.measureBody(); }, detached() { this.detached = true; } },
  pageLifetimes: { resize() { if (this.properties.opened) { this.updateViewport(); this.measureBody(); } } },
  methods: {
    noop() {},
    measureBody() {
      if (typeof this.createSelectorQuery !== 'function' || typeof wx === 'undefined' || !wx.nextTick) return;
      const generation = this.measureGeneration;
      const token = this.measureToken = (this.measureToken || 0) + 1;
      wx.nextTick(() => {
        if (this.detached || !this.properties.opened || generation !== this.measureGeneration || token !== this.measureToken) return;
        this.createSelectorQuery().select('.reduction-body-content').boundingClientRect(rect => {
          if (this.detached || !this.properties.opened || generation !== this.measureGeneration || token !== this.measureToken || !rect || !rect.height) return;
          this.bodyContentHeight = Math.ceil(rect.height); this.updateViewport();
        }).exec();
      });
    },
    updateViewport() {
      let info;
      try { info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); } catch (e) {}
      if (!info || !info.windowHeight) return;
      const height = info.windowHeight, overlayStyle = 'height:' + height + 'px;bottom:auto;';
      const bodyHeight = Math.max(32, Math.min(this.bodyContentHeight || 300, height - 180));
      const patch = {};
      if (overlayStyle !== this.data.overlayStyle) patch.overlayStyle = overlayStyle;
      if (bodyHeight !== this.data.bodyHeight) patch.bodyHeight = bodyHeight;
      if (Object.keys(patch).length) this.setData(patch);
    },
    pickStart() { if (!this.properties.busy) this.setData({ wheelEditing: true }); },
    pickEnd() { this.setData({ wheelEditing: false }); },
    pick(e) {
      if (this.properties.busy) return;
      const values = e.detail.value;
      if (!Array.isArray(values) || values.length !== 2) return;
      const [hours, minute] = values, totalMinutes = Math.max(0, Math.ceil(this.properties.durationSeconds / 60) - 1);
      if (!Number.isInteger(hours) || hours < 0 || hours > Math.floor(totalMinutes / 60) ||
          !Number.isInteger(minute) || minute < 0 || minute > 59) return;
      const maxMinute = Math.min(59, totalMinutes - hours * 60), minutes = Math.min(minute, maxMinute);
      const targetSeconds = (hours * 60 + minutes) * 60;
      const valid = Number.isSafeInteger(this.properties.durationSeconds) && targetSeconds < this.properties.durationSeconds;
      const patch = {
        wheelValue: [hours, minutes], valid,
        remainingText: exactDuration(targetSeconds),
        message: valid ? '调整后时长为 ' + exactDuration(targetSeconds) : '调整后的时长必须小于原记录'
      };
      if (this.data.minuteOptions.length !== maxMinute + 1) patch.minuteOptions = range(maxMinute);
      this.setData(patch);
    },
    close() { if (!this.properties.busy) this.triggerEvent('close'); },
    confirm() {
      if (this.properties.busy || this.data.wheelEditing || this.properties.durationSeconds < 60) return;
      const [hours, minutes] = this.data.wheelValue;
      const targetSeconds = (hours * 60 + minutes) * 60;
      if (Number.isSafeInteger(this.properties.durationSeconds) && targetSeconds < this.properties.durationSeconds)
        this.triggerEvent('confirm', { durationSeconds: targetSeconds });
    }
  }
});
