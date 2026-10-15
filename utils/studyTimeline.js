// ===== 可调常量 =====
const MERGE_GAP_SEC = 10 * 60;
const MIN_BAR_PCT = 4;
const MIN_RANGE_MIN = 180;
const PALETTE = ['#d19a1f', '#4a6fb8', '#22c3b0', '#6cc24a', '#c0623b', '#8a6fc7'];

// ===== 工具函数 =====
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const hhmm = (ms) => {
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
};

const toMs = (v) =>
  typeof v === 'number' ? v : +new Date(String(v).replace(/-/g, '/'));

function fmtDuration(sec) {
  sec = Math.round(sec);
  if (sec < 60) return sec + '秒';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return m ? h + '小时' + m + '分钟' : h + '小时';
  return s ? m + '分' + s + '秒' : m + '分钟';
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

// ===== 字段适配：映射项目现有的当天记录字段 =====
function normalize(raw) {
  const start = toMs(raw.startTime);
  const end = toMs(raw.endTime);
  return {
    id: raw.id,
    project: raw.projectId != null ? raw.projectId : raw.project,
    projectName: raw.projectName || raw.name || raw.project,
    title: raw.title || raw.parentPath || '',
    start,
    end,
    studyIntervals: Array.isArray(raw.studyIntervals)
      ? raw.studyIntervals.map((interval) => ({
          start: Math.max(start, interval.startedAtSec * 1000),
          end: Math.min(end, interval.endedAtSec * 1000),
        })).filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start)
      : [{ start, end: Math.min(end, start + (raw.durationSec != null ? raw.durationSec * 1000 : end - start)) }],
    durationSec:
      raw.durationSec != null ? raw.durationSec : Math.round((end - start) / 1000),
  };
}

function mergeRecords(list, gapSec) {
  const groups = [];
  list.forEach((r) => {
    const g = groups[groups.length - 1];
    if (
      g &&
      g.project === r.project &&
      g.title === r.title &&
      (r.start - g.end) / 1000 <= gapSec
    ) {
      g.end = Math.max(g.end, r.end);
      g.durationSec += r.durationSec;
      g.items.push(r);
    } else {
      groups.push({
        key: 'g' + groups.length,
        project: r.project,
        projectName: r.projectName,
        title: r.title,
        start: r.start,
        end: r.end,
        durationSec: r.durationSec,
        items: [r],
      });
    }
  });
  return groups;
}

function buildAxis(groups) {
  const dayStart = new Date(groups[0].start);
  dayStart.setHours(0, 0, 0, 0);
  const base = +dayStart;
  const toMin = (ms) => (ms - base) / 60000;

  const firstMin = toMin(groups[0].start);
  const lastMin = Math.max.apply(null, groups.map((g) => toMin(g.end)));

  let lo = Math.floor((firstMin - 20) / 60) * 60;
  let hi = Math.ceil((lastMin + 10) / 60) * 60;
  lo = Math.max(lo, 0);
  hi = Math.min(hi, 1440);
  if (hi - lo < MIN_RANGE_MIN) hi = Math.min(lo + MIN_RANGE_MIN, 1440);
  if (hi - lo < MIN_RANGE_MIN) lo = hi - MIN_RANGE_MIN;
  const range = hi - lo;

  const hours = range / 60;
  const step = hours > 8 ? 3 : hours > 5 ? 2 : 1;
  const ticks = [];
  for (let h = lo / 60; h <= hi / 60; h += step) {
    const left = ((h * 60 - lo) / range) * 100;
    ticks.push({
      label: h + ':00',
      left: +left.toFixed(2),
      align: left < 4 ? 'left' : left > 96 ? 'right' : 'center',
    });
  }

  const segments = [];
  groups.forEach((g) => {
    // 列表仍按原规则合并；横条分别绘制，不能把暂停或记录之间的空档填色。
    g.items.forEach((record) => record.studyIntervals.forEach((interval) => {
      const s = Math.max(toMin(interval.start), lo);
      const e = Math.min(toMin(interval.end), hi);
      if (e <= s) return;
      segments.push({
        key: g.key + '-s' + segments.length,
        groupKey: g.key,
        project: g.project,
        left: +(((s - lo) / range) * 100).toFixed(2),
        width: +(((e - s) / range) * 100).toFixed(4),
      });
    }));
  });

  return { ticks, segments };
}

function buildTimeline(rawRecords, colorMap) {
  colorMap = colorMap || {};
  const colorOf = (p) => colorMap[p] || PALETTE[hash(String(p)) % PALETTE.length];

  const records = (rawRecords || [])
    .map(normalize)
    .filter((r) => !isNaN(r.start) && !isNaN(r.end) && r.end >= r.start && r.durationSec > 0)
    .sort((a, b) => a.start - b.start);

  if (!records.length) {
    return { empty: true, count: 0, totalText: '', segments: [], rows: [], ticks: [] };
  }

  const groups = mergeRecords(records, MERGE_GAP_SEC);
  const { ticks, segments } = buildAxis(groups);
  const maxSec = Math.max.apply(null, groups.map((g) => g.durationSec));
  const total = records.reduce((s, r) => s + r.durationSec, 0);

  const colored = segments.map((seg) =>
    Object.assign({}, seg, { color: colorOf(seg.project) })
  );

  const rows = groups.map((g) => ({
    key: g.key,
    start: hhmm(g.start),
    end: hhmm(g.end),
    project: g.projectName || g.project,
    title: g.title && g.title !== (g.projectName || g.project) ? g.title : '',
    count: g.items.length > 1 ? g.items.length : 0,
    durText: fmtDuration(g.durationSec),
    barPct: Math.max((g.durationSec / maxSec) * 100, MIN_BAR_PCT).toFixed(1),
    color: colorOf(g.project),
  }));

  return {
    empty: false,
    count: records.length,
    totalText: fmtDuration(total),
    segments: colored,
    rows,
    ticks,
  };
}

module.exports = { buildTimeline, fmtDuration, mergeRecords };




