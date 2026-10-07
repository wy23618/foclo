// core/ranges.js
// 时间范围与半开区间求交。范围统一为半开区间 [start, end)。

const { dayStart, dayIndex, dayStartByIndex, parseDayKey } = require('./time');

// 两个区间的交集秒数（半开，结果 >= 0）
function overlap(aStart, aEnd, bStart, bEnd) {
  const lo = Math.max(aStart, bStart);
  const hi = Math.min(aEnd, bEnd);
  return Math.max(0, hi - lo);
}

// 今天：[今天00:00, 明天00:00)
function rangeToday(nowSec) {
  const s = dayStart(nowSec);
  return { start: s, end: s + 86400 };
}

// 近 n 个自然日，含今天：[今天-(n-1)天00:00, 明天00:00)
function rangeLastNDays(nowSec, n) {
  const s = dayStart(nowSec);
  return { start: s - (n - 1) * 86400, end: s + 86400 };
}

// 自定义范围：两端日期均包含，结束日转换为次日 00:00
// {startKey:'YYYY-MM-DD', endKey:'YYYY-MM-DD'}
function rangeCustom(startKey, endKey) {
  const sIdx = parseDayKey(startKey);
  const eIdx = parseDayKey(endKey);
  if (sIdx === null || eIdx === null) {
    throw makeError('E_RANGE_INVALID', '日期格式不合法');
  }
  if (sIdx > eIdx) {
    throw makeError('E_RANGE_INVALID', '开始日期不能晚于结束日期');
  }
  return {
    start: dayStartByIndex(sIdx),
    end: dayStartByIndex(eIdx) + 86400
  };
}

// 枚举范围内的自然日序号（升序）
function dayIndicesOf(range) {
  const first = dayIndex(range.start);
  const last = dayIndex(range.end - 1);
  const out = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

function makeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

module.exports = {
  overlap,
  rangeToday,
  rangeLastNDays,
  rangeCustom,
  dayIndicesOf
};
