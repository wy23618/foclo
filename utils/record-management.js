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
      color: record.color,
      canDelete: complete,
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

module.exports = { managementRows, deletionMessage };
