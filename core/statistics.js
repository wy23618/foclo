// core/statistics.js
// 统计纯函数（只读，无写入副作用）：区间贡献、范围统计、范围记录、项目子树统计、热力图。
// 所有结果从会话/暂停事实按半开区间重算，不直接累加已存 durationSeconds。

const { overlap, dayIndicesOf } = require('./ranges');
const timeMod = require('./time');
const { dayStartByIndex, dayKeyOfIndex, partsOfDayIndex } = timeMod;
const tree = require('./tree');

// 单条会话对范围的贡献（补充规格 §5.3）：
// effectiveEnd = COMPLETED 的 endedAtSec，或 ACTIVE 的 asOfSec
// contribution = max(0, overlap(会话) - Σ overlap(暂停, 截止 effectiveEnd))
function sessionContribution(session, rangeStart, rangeEnd, nowSec) {
  if (!session) return 0;
  const effectiveEnd = session.status === 'COMPLETED' ? session.endedAtSec : nowSec;
  if (effectiveEnd <= session.startedAtSec) return 0;
  const gross = overlap(session.startedAtSec, effectiveEnd, rangeStart, rangeEnd);
  if (gross <= 0) return 0;
  let deduct = 0;
  for (let i = 0; i < session.pauses.length; i++) {
    const p = session.pauses[i];
    const pEnd = p.status === 'COMPLETED' ? p.endedAtSec : nowSec;
    const end = Math.min(pEnd, effectiveEnd);
    if (end > p.startedAtSec) {
      deduct += overlap(p.startedAtSec, end, rangeStart, rangeEnd);
    }
  }
  return Math.max(0, gross - deduct);
}

// 范围内逐会话贡献（内部公共步骤）
function perSessionContributions(sessions, range, nowSec) {
  const out = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    out.push({ session: s, seconds: sessionContribution(s, range.start, range.end, nowSec) });
  }
  return out;
}

// 每日序列：连续自然日，补 0
function dailySeries(sessions, range, nowSec) {
  const indices = dayIndicesOf(range);
  return indices.map((idx) => {
    const ds = dayStartByIndex(idx);
    let total = 0;
    for (let i = 0; i < sessions.length; i++) {
      total += sessionContribution(sessions[i], ds, ds + 86400, nowSec);
    }
    return { date: dayKeyOfIndex(idx), dayIndex: idx, seconds: total };
  });
}

// 每个自然日的固定一小时桶。暂停时间由 sessionContribution 扣除；无记录日也参与日均。
function averageTimeSlots(sessions, range, nowSec) {
  const days = dayIndicesOf(range);
  const totals = Array(24).fill(0);
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const effectiveEnd = session.status === 'COMPLETED' ? session.endedAtSec : nowSec;
    const start = Math.max(session.startedAtSec, range.start);
    const end = Math.min(effectiveEnd, range.end);
    if (end <= start) continue;
    let cursor = start;
    while (cursor < end) {
      const dayStart = dayStartByIndex(timeMod.dayIndex(cursor));
      const slot = Math.floor((cursor - dayStart) / 3600);
      const slotEnd = Math.min(dayStart + (slot + 1) * 3600, end);
      totals[slot] += sessionContribution(session, cursor, slotEnd, nowSec);
      cursor = slotEnd;
    }
  }
  return totals.map((seconds, slot) => ({
    startHour: slot,
    averageSeconds: days.length ? seconds / days.length : 0
  }));
}

// 总览范围统计。
// mode: 'realtime'（默认，含 ACTIVE）| 'completed'（仅 COMPLETED）。
// 调用方按 mode 过滤传入的 sessions；本函数只做只读计算。
function rangeStatistics(sessions, range, nowSec, projectIndex, mode) {
  const per = perSessionContributions(sessions, range, nowSec);
  let totalSeconds = 0;
  let sessionCount = 0;
  let pauseCount = 0;
  let completedCount = 0;
  let activeCount = 0;
  const secondsById = {};

  for (let i = 0; i < per.length; i++) {
    const item = per[i];
    const pauses = item.session.pauses || [];
    for (let j = 0; j < pauses.length; j++) {
      if (pauses[j].startedAtSec >= range.start && pauses[j].startedAtSec < range.end) pauseCount++;
    }
    if (item.seconds > 0) {
      totalSeconds += item.seconds;
      sessionCount++;
      if (item.session.status === 'ACTIVE') activeCount++;
      else completedCount++;
      secondsById[item.session.projectId] = (secondsById[item.session.projectId] || 0) + item.seconds;
    }
  }

  // 根项目分布：每条贡献只归入一个根（归档项目仍参与）
  const roots = [];
  const rootMap = {};
  if (projectIndex) {
    const roll = tree.rollUpMap(projectIndex);
    for (let i = 0; i < per.length; i++) {
      const item = per[i];
      if (item.seconds <= 0) continue;
      const rootId = roll[item.session.projectId] || item.session.projectId;
      if (!rootMap[rootId]) {
        const rp = projectIndex.byId[rootId] || {};
        rootMap[rootId] = { projectId: rootId, name: rp.name || '未知项目', seconds: 0, archived: !!rp.archived };
        roots.push(rootMap[rootId]);
      }
      rootMap[rootId].seconds += item.seconds;
    }
    roots.sort((a, b) => b.seconds - a.seconds);
  }

  const days = dayIndicesOf(range).length;
  const series = dailySeries(sessions, range, nowSec);

  return {
    mode: mode || 'realtime',
    totalSeconds,
    sessionCount,
    pauseCount,
    completedCount,
    activeCount,
    secondsById,
    days,
    averageSeconds: days > 0 ? Math.round(totalSeconds / days) : 0,
    roots,
    dailySeries: series,
    averageTimeSlots: averageTimeSlots(sessions, range, nowSec)
  };
}

// 时间线只绘制范围内的实际学习区间，暂停（包括尚未恢复的暂停）留空。
function studyIntervalsInRange(session, range, nowSec) {
  const effectiveEnd = session.status === 'COMPLETED' ? session.endedAtSec : nowSec;
  const start = Math.max(session.startedAtSec, range.start);
  const end = Math.min(effectiveEnd, range.end);
  const intervals = [];
  let cursor = start;
  const pauses = (session.pauses || []).slice().sort((a, b) => a.startedAtSec - b.startedAtSec);
  for (let i = 0; i < pauses.length && cursor < end; i++) {
    const pause = pauses[i];
    const pauseEnd = Math.min(pause.status === 'COMPLETED' ? pause.endedAtSec : nowSec, end);
    if (pauseEnd <= cursor || pauseEnd <= pause.startedAtSec) continue;
    const studyEnd = Math.min(pause.startedAtSec, end);
    if (studyEnd > cursor) intervals.push({ startedAtSec: cursor, endedAtSec: studyEnd });
    cursor = Math.max(cursor, pauseEnd);
  }
  if (cursor < end) intervals.push({ startedAtSec: cursor, endedAtSec: end });
  return intervals;
}

// 范围记录（贡献 > 0），按真实 startedAtSec 升序，同起点按 sessionId 排序。
// 每行携带真实起止与裁剪起止（§5.5）。分页由服务层处理。
function recordsInRange(sessions, range, nowSec, projectIndex, includeZeroCompleted) {
  const rows = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const sec = sessionContribution(s, range.start, range.end, nowSec);
    const zeroCompleted = includeZeroCompleted && s.status === 'COMPLETED' && s.durationSeconds === 0 && s.startedAtSec >= range.start && s.startedAtSec < range.end;
    if (sec <= 0 && !zeroCompleted) continue;
    const effectiveEnd = s.status === 'COMPLETED' ? s.endedAtSec : nowSec;
    let path = ['未知项目'];
    if (projectIndex && projectIndex.byId[s.projectId]) {
      path = tree.pathNames(projectIndex, s.projectId);
    }
    const ap = s.status === 'ACTIVE' ? require('./timer').getActivePause(s) : null;
    rows.push({
      sessionId: s.id,
      projectId: s.projectId,
      name: path[path.length - 1],
      path: path.slice(),
      realStartedAtSec: s.startedAtSec,
      realEndedAtSec: s.endedAtSec,
      clippedStartedAtSec: Math.max(s.startedAtSec, range.start),
      clippedEndedAtSec: Math.min(effectiveEnd, range.end),
      seconds: sec,
      studyIntervals: studyIntervalsInRange(s, range, nowSec),
      totalDurationSeconds: s.status === 'COMPLETED' ? s.durationSeconds : null,
      status: s.status,
      paused: !!ap,
      targetSeconds: s.targetSeconds == null ? null : s.targetSeconds
    });
  }
  rows.sort((a, b) => {
    if (a.realStartedAtSec !== b.realStartedAtSec) return a.realStartedAtSec - b.realStartedAtSec;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });
  return rows;
}

// 单项目（整棵子树）范围统计（§5.4）。
function subjectStatistics(sessions, projectId, range, nowSec, projectIndex, mode) {
  if (!projectIndex || !projectIndex.byId[projectId]) {
    const e = new Error('项目不存在');
    e.code = 'PROJECT_NOT_FOUND';
    throw e;
  }
  const members = new Set(tree.subtreeIds(projectIndex, projectId));
  const subSessions = sessions.filter((s) => members.has(s.projectId));

  const all = rangeStatistics(sessions, range, nowSec, projectIndex, mode);
  const sub = rangeStatistics(subSessions, range, nowSec, projectIndex, mode);

  const breakdown = tree.childBreakdown(projectIndex, projectId, sub.secondsById);
  const path = tree.pathNames(projectIndex, projectId);

  return {
    projectId,
    name: projectIndex.byId[projectId].name,
    path: path.slice(),
    pathText: path.join(' / '),
    archived: projectIndex.byId[projectId].archived,
    mode: mode || 'realtime',
    totalSeconds: sub.totalSeconds,
    sessionCount: sub.sessionCount,
    pauseCount: sub.pauseCount,
    completedCount: sub.completedCount,
    activeCount: sub.activeCount,
    secondsById: sub.secondsById,
    selfSeconds: breakdown.selfSeconds,
    children: breakdown.children,
    shareOfAll: all.totalSeconds > 0 ? sub.totalSeconds / all.totalSeconds : 0,
    dailySeries: sub.dailySeries,
    averageTimeSlots: sub.averageTimeSlots,
    days: sub.days,
    averageSeconds: sub.averageSeconds
  };
}

// 热力图等级（§5.5，固定阈值跨月不变）：
// 0；1–3599→1；3600–7199→2；7200–10799→3；≥10800→4
function heatLevel(seconds) {
  if (seconds <= 0) return 0;
  if (seconds < 3600) return 1;
  if (seconds < 7200) return 2;
  if (seconds < 10800) return 3;
  return 4;
}

// 某月每日秒数（可选子树范围）
function heatmapMonth(sessions, monthInfo, nowSec, projectIndex, scopeProjectId) {
  let used = sessions;
  if (scopeProjectId && projectIndex && projectIndex.byId[scopeProjectId]) {
    const members = new Set(tree.subtreeIds(projectIndex, scopeProjectId));
    used = sessions.filter((s) => members.has(s.projectId));
  }
  const cells = [];
  for (let i = 0; i < monthInfo.days; i++) {
    const idx = monthInfo.startIndex + i;
    const ds = dayStartByIndex(idx);
    let total = 0;
    for (let j = 0; j < used.length; j++) {
      total += sessionContribution(used[j], ds, ds + 86400, nowSec);
    }
    const p = partsOfDayIndex(idx);
    cells.push({
      dayIndex: idx,
      date: dayKeyOfIndex(idx),
      day: p.day,
      seconds: total,
      level: heatLevel(total),
      isFuture: ds > nowSec
    });
  }
  return cells;
}

module.exports = {
  sessionContribution,
  rangeStatistics,
  recordsInRange,
  subjectStatistics,
  heatmapMonth,
  heatLevel
};
