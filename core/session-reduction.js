function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

// Keep the earliest study intervals, including the pauses between them.
// Changing durationSeconds alone would leave daily statistics unchanged.
function reduceSession(session, durationSeconds) {
  if (!session || session.status !== 'COMPLETED')
    fail('SESSION_IN_PROGRESS', '只能减少已完成记录的时长');
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0 ||
      durationSeconds >= session.durationSeconds)
    fail('INVALID_DURATION', '调整后的时长必须小于原时长，且不能小于零');
  const pauses = (session.pauses || []).slice().sort((a, b) => a.startedAtSec - b.startedAtSec);
  let cursor = session.startedAtSec, paused = 0;
  for (const pause of pauses) {
    if (pause.status !== 'COMPLETED' || !Number.isSafeInteger(pause.startedAtSec) ||
        !Number.isSafeInteger(pause.endedAtSec) || pause.startedAtSec < cursor ||
        pause.endedAtSec < pause.startedAtSec || pause.endedAtSec > session.endedAtSec ||
        pause.durationSeconds !== pause.endedAtSec - pause.startedAtSec)
      fail('DATA_CORRUPT', '记录的暂停区间异常，未修改原记录');
    paused += pause.durationSeconds;
    cursor = pause.endedAtSec;
  }
  if (!Number.isSafeInteger(session.startedAtSec) || !Number.isSafeInteger(session.endedAtSec) ||
      !Number.isSafeInteger(session.durationSeconds) ||
      session.durationSeconds !== session.endedAtSec - session.startedAtSec - paused)
    fail('DATA_CORRUPT', '记录时长与时间区间不一致，未修改原记录');

  cursor = session.startedAtSec;
  let remaining = durationSeconds, endedAtSec;
  for (const pause of pauses) {
    const study = pause.startedAtSec - cursor;
    if (remaining <= study) { endedAtSec = cursor + remaining; break; }
    remaining -= study;
    cursor = pause.endedAtSec;
  }
  if (endedAtSec == null) endedAtSec = cursor + remaining;
  return { ...session, durationSeconds, endedAtSec,
    pauses: pauses.filter(p => p.startedAtSec < endedAtSec).map(p => ({ ...p })) };
}

module.exports = { reduceSession };
