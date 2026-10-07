// core/time.js
// 时间契约（D04）：
// - 业务字段一律使用 epoch 整秒（整数），字段名见数据契约；
// - 固定业务时区 Asia/Shanghai（UTC+8，无夏令时），自然日按 +8 偏移计算，
//   与设备所在时区、系统设置无关；
// - 毫秒时间戳进入业务前先截断到整秒。

const TZ_OFFSET_SEC = 8 * 3600;
const DAY_SEC = 86400;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function msToSeconds(ms) {
  return Math.floor(ms / 1000);
}

// 某时刻所属自然日的序号（1970-01-01 起，按业务时区）
function dayIndex(tsSec) {
  return Math.floor((tsSec + TZ_OFFSET_SEC) / DAY_SEC);
}

// 该自然日的 00:00:00（业务时区）对应的 epoch 秒
function dayStartByIndex(idx) {
  return idx * DAY_SEC - TZ_OFFSET_SEC;
}

function dayStart(tsSec) {
  return dayStartByIndex(dayIndex(tsSec));
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// 由日序号得到业务时区下的年月日（用 UTC 日历做纯算术）
function partsOfDayIndex(idx) {
  const d = new Date(idx * DAY_SEC * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate()
  };
}

function dayKeyOfIndex(idx) {
  const p = partsOfDayIndex(idx);
  return p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
}

function dayKey(tsSec) {
  return dayKeyOfIndex(dayIndex(tsSec));
}

function monthKeyOfIndex(idx) {
  const p = partsOfDayIndex(idx);
  return p.year + '-' + pad2(p.month);
}

function monthKey(tsSec) {
  return monthKeyOfIndex(dayIndex(tsSec));
}

// 'YYYY-MM-DD' -> 日序号；非法返回 null
function parseDayKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const idx = Math.floor(Date.UTC(year, month - 1, day) / 1000 / DAY_SEC);
  // 归一化校验（防止 2026-02-31 这类输入）
  const p = partsOfDayIndex(idx);
  if (p.year !== year || p.month !== month || p.day !== day) return null;
  return idx;
}

// 'YYYY-MM' -> {year, month, startIndex, days}
function parseMonthKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const startIndex = Math.floor(Date.UTC(year, month - 1, 1) / 1000 / DAY_SEC);
  const nextMonthIndex = Math.floor(Date.UTC(year, month, 1) / 1000 / DAY_SEC);
  return {
    year,
    month,
    startIndex,
    days: nextMonthIndex - startIndex
  };
}

function monthKeyOfParts(year, month) {
  return year + '-' + pad2(month);
}

function shiftMonthKey(key, delta) {
  const info = parseMonthKey(key);
  if (!info) return null;
  const d = new Date(Date.UTC(info.year, info.month - 1 + delta, 1));
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1);
}

function addDaysToKey(key, delta) {
  const idx = parseDayKey(key);
  if (idx === null) return null;
  return dayKeyOfIndex(idx + delta);
}

// 星期几（业务时区）：0=周一 ... 6=周日
function weekdayOfDayIndex(idx) {
  // 1970-01-01 是周四（UTC），业务时区下日历日期相同
  return (idx + 3) % 7;
}

module.exports = {
  TZ_OFFSET_SEC,
  DAY_SEC,
  nowSeconds,
  msToSeconds,
  dayIndex,
  dayStart,
  dayStartByIndex,
  partsOfDayIndex,
  dayKey,
  dayKeyOfIndex,
  monthKey,
  monthKeyOfIndex,
  parseDayKey,
  parseMonthKey,
  monthKeyOfParts,
  shiftMonthKey,
  addDaysToKey,
  weekdayOfDayIndex,
  pad2
};
