const time = require('../core/time');
const format = require('./format');

function exactTime(sec) {
  return format.timeOfDay(sec) + ':' + String(Math.floor(sec) % 60).padStart(2, '0');
}

function stamp(sec) {
  return time.dayKey(sec) + ' ' + exactTime(sec);
}

function managementRows(records) {
  return (records || []).slice().sort((a, b) =>
    (b.realStartedAtSec == null ? b.startTime / 1000 : b.realStartedAtSec) - (a.realStartedAtSec == null ? a.startTime / 1000 : a.realStartedAtSec) || String(b.id).localeCompare(String(a.id))
  ).map(record => {
    const start = record.realStartedAtSec == null ? record.startTime / 1000 : record.realStartedAtSec;
    const end = record.realEndedAtSec == null ? record.endTime / 1000 : record.realEndedAtSec;
    const complete = record.status === 'COMPLETED';
    const seconds = complete && record.totalDurationSeconds != null ? record.totalDurationSeconds : record.durationSec;
    const crossDay = time.dayKey(start) !== time.dayKey(end);
    return {
      id: record.id,
      project: record.projectName || record.project,
      path: record.parentPath || '',
      start: format.timeOfDay(start),
      end: format.timeOfDay(end),
      timeText: crossDay ? stamp(start) + ' – ' + stamp(end) : time.dayKey(start) + ' · ' + exactTime(start) + ' – ' + exactTime(end),
      durationText: format.durationText(seconds),
      durationSeconds: seconds,
      color: record.color,
      canDelete: complete,
      canReduce: complete && seconds >= 60,
      statusText: complete ? '已完成' : record.paused ? '暂停中' : '进行中',
      crossDay
    };
  });
}

function deletionMessage(row) {
  return row.project + '\n' + row.timeText + '\n专注时长：' + row.durationText +
    (row.crossDay ? '\n这次计时跨越日期，将删除整次记录。' : '') +
    '\n删除后将从统计中移除，无法撤销。';
}

function exactDuration(seconds) {
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return [hours ? hours + '小时' : '', minutes ? minutes + '分钟' : '', rest ? rest + '秒' : ''].join('') || '0秒';
}

function reductionPreview(duration, minutes, seconds) {
  const min = String(minutes).trim(), sec = String(seconds).trim();
  if ((!min && !sec) || !/^\d*$/.test(min) || !/^\d*$/.test(sec))
    return { valid: false, message: '请输入需要减少的时长' };
  const amount = Number(min || 0) * 60 + Number(sec || 0);
  if (!Number.isSafeInteger(amount) || Number(sec || 0) > 59)
    return { valid: false, message: '秒数请填写 0–59' };
  if (amount <= 0) return { valid: false, message: '减少的时长需要大于零' };
  if (amount > duration) return { valid: false, message: '不能超过当前记录的时长' };
  return { valid: true, reduceSeconds: amount, remainingText: exactDuration(duration - amount), message: '' };
}

module.exports = { managementRows, deletionMessage, exactDuration, reductionPreview };
