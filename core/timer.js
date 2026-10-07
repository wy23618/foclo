// core/timer.js
// 计时核心：净时长、暂停区间、到期判定与结算结果。
// 全部基于绝对时间戳与暂停区间计算，绝不使用每秒回调。
//
// Session 结构（字段名遵循补充规格 §3.2）：
// { id, spaceId, projectId, startedAtSec, endedAtSec, durationSeconds,
//   targetSeconds, status: 'ACTIVE' | 'COMPLETED',
//   pauses: [ Pause ], createdAtSec, updatedAtSec, revision }
// Pause: { id, sessionId, startedAtSec, endedAtSec, durationSeconds, status, createdAtSec }

function getActivePause(session) {
  if (!session || session.status !== 'ACTIVE') return null;
  for (let i = 0; i < session.pauses.length; i++) {
    if (session.pauses[i].status === 'ACTIVE') return session.pauses[i];
  }
  return null;
}

function closedPauseSeconds(session) {
  let total = 0;
  if (!session) return 0;
  for (let i = 0; i < session.pauses.length; i++) {
    const p = session.pauses[i];
    if (p.status === 'COMPLETED') total += p.durationSeconds;
  }
  return total;
}

// 当前净时长（补充规格 §4.2 契约，全代码库唯一实现）：
// closedPauseSeconds = Σ 已关闭 Pause.durationSeconds
// openPauseSeconds   = 有 ACTIVE 暂停时 (nowSec - pause.startedAtSec)，否则 0
// elapsedSeconds     = max(0, nowSec - startedAtSec - closed - open)
function netSeconds(session, nowSec) {
  if (!session) return 0;
  const closed = closedPauseSeconds(session);
  const ap = getActivePause(session);
  const openPause = ap ? Math.max(0, nowSec - ap.startedAtSec) : 0;
  const gross = Math.max(0, nowSec - session.startedAtSec);
  return Math.max(0, gross - closed - openPause);
}

// 计划结束时刻 = 开始 + 目标 + 已关闭暂停
function plannedEndSec(session) {
  return session.startedAtSec + (session.targetSeconds || 0) + closedPauseSeconds(session);
}

// 到期判定：倒计时、会话 ACTIVE、不在暂停中、净时长达到目标
function isExpired(session, nowSec) {
  if (!session || session.status !== 'ACTIVE') return false;
  if (session.targetSeconds == null) return false;
  if (getActivePause(session)) return false;
  return netSeconds(session, nowSec) >= session.targetSeconds;
}

// 惰性到期结算结果（D01 统一契约，§4.3）：
// endedAtSec = startedAtSec + T + P；durationSeconds 精确记 T。
function settleResult(session) {
  return {
    status: 'COMPLETED',
    endedAtSec: plannedEndSec(session),
    durationSeconds: session.targetSeconds
  };
}

// 关闭当前暂停（继续 / 暂停中结束时调用）。
// allowNegative=false：时钟倒退导致负时长时抛 CLOCK_BEFORE_FACT，暂停保持 ACTIVE；
// allowNegative=true ：钳制为 0（防御保留）。
function closeActivePause(session, nowSec, allowNegative) {
  const ap = getActivePause(session);
  if (!ap) return null;
  const d = nowSec - ap.startedAtSec;
  if (d < 0) {
    if (!allowNegative) {
      const e = new Error('设备时间早于暂停开始时间，暂停已保留');
      e.code = 'CLOCK_BEFORE_FACT';
      throw e;
    }
    ap.status = 'COMPLETED';
    ap.endedAtSec = nowSec;
    ap.durationSeconds = 0;
    return ap;
  }
  ap.status = 'COMPLETED';
  ap.endedAtSec = nowSec;
  ap.durationSeconds = d;
  return ap;
}

// 手动结束结算（§4.2 stop）：
// endedAtSec = startedAtSec + duration + Σ暂停，保证与统计区间求交一致。
// D01 后走到这里的会话净时长必 < 目标；钳制为防御。
function stopResult(session, nowSec) {
  const net = netSeconds(session, nowSec);
  let duration = net;
  if (session.targetSeconds != null && net > session.targetSeconds) {
    duration = session.targetSeconds;
  }
  const closed = closedPauseSeconds(session);
  return {
    status: 'COMPLETED',
    endedAtSec: session.startedAtSec + duration + closed,
    durationSeconds: duration
  };
}

// 目标秒数校验（D02）：整数秒，>=60，拒绝 bool/非整数/超出可表示范围。
const MAX_TARGET_SECONDS = Math.floor(86400 * 365 * 100); // 100 年，可解释上限

function normalizeTarget(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') {
    throw makeError('INVALID_TARGET', '目标时长不合法');
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw makeError('INVALID_TARGET', '目标时长必须是整数秒');
  }
  if (value < 60) {
    throw makeError('INVALID_TARGET', '目标时长至少 60 秒（1 分钟）');
  }
  if (value > MAX_TARGET_SECONDS) {
    throw makeError('INVALID_TARGET', '目标时长超出可表示范围');
  }
  return value;
}

function makeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

module.exports = {
  getActivePause,
  closedPauseSeconds,
  netSeconds,
  plannedEndSec,
  isExpired,
  settleResult,
  closeActivePause,
  stopResult,
  normalizeTarget,
  MAX_TARGET_SECONDS
};
