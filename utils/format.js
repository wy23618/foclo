// utils/format.js
// 展示格式化（仅展示用途，不修改底层秒值）。

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// 大时钟文本：H:MM:SS / MM:SS
function clockText(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : pad2(m) + ':' + pad2(s);
}

// 时长口语：1小时30分钟 / 45分钟 / 30秒 / 0秒；小时级省略秒
function durationText(sec) {
  sec = Math.floor(sec || 0);
  if (sec <= 0) return '0秒';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h) parts.push(h + '小时');
  if (m) parts.push(m + '分钟');
  if (s && h === 0) parts.push(s + '秒');
  return parts.join('') || '0秒';
}

// 小时数（1 位小数，热力图用）
function hoursText(sec) {
  return (sec / 3600).toFixed(1);
}

// Compact, non-zero day label for the narrow heatmap cells.
function heatDurationText(sec) {
  sec = Math.floor(sec || 0);
  if (sec <= 0) return '—';
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  const hours = Math.round(sec / 360) / 10;
  return (Number.isInteger(hours) ? String(hours) : hours.toFixed(1)) + 'h';
}

// 业务时区下的时刻 HH:MM（Asia/Shanghai）
function timeOfDay(tsSec) {
  const shifted = tsSec + 8 * 3600;
  const daySec = shifted % 86400;
  return pad2(Math.floor(daySec / 3600)) + ':' + pad2(Math.floor((daySec % 3600) / 60));
}

const WEEK_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

module.exports = {
  pad2,
  clockText,
  durationText,
  hoursText,
  heatDurationText,
  timeOfDay,
  WEEK_CN
};
