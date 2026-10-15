const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../core/service');
const { createMemoryAdapter } = require('../storage/adapter');
const { uuid } = require('../core/ids');
const { recordsInRange } = require('../core/statistics');
const { buildTimeline } = require('../utils/studyTimeline');

const at = (hour, minute = 0) => new Date(2026, 9, 13, hour, minute).getTime() / 1000;
const day = { start: at(0), end: at(24) };
const session = (overrides = {}) => Object.assign({
  id: 's', projectId: 'english', status: 'COMPLETED',
  startedAtSec: at(8), endedAtSec: at(20, 1), durationSeconds: 120,
  pauses: [{ startedAtSec: at(8, 1), endedAtSec: at(20), status: 'COMPLETED' }],
}, overrides);
const timelineRecord = (row) => ({
  id: row.sessionId, project: row.projectId, projectName: row.name,
  startTime: row.clippedStartedAtSec * 1000, endTime: row.clippedEndedAtSec * 1000,
  durationSec: row.seconds, studyIntervals: row.studyIntervals,
});

test('a morning minute and evening minute produce two short bars and preserve the list row', () => {
  const row = recordsInRange([session()], day, at(21))[0];
  assert.equal(row.seconds, 120);
  assert.deepEqual(row.studyIntervals, [
    { startedAtSec: at(8), endedAtSec: at(8, 1) },
    { startedAtSec: at(20), endedAtSec: at(20, 1) },
  ]);
  const record = timelineRecord(row);
  const result = buildTimeline([record], { english: '#123456' });
  const oldList = buildTimeline([Object.assign({}, record, { studyIntervals: undefined })]);
  assert.deepEqual(result.rows.map(r => ({ ...r, color: '' })), oldList.rows.map(r => ({ ...r, color: '' })));
  assert.equal(result.count, 1);
  assert.equal(result.totalText, '2分钟');
  assert.equal(result.segments.length, 2);
  assert.ok(result.segments.every(s => s.width < 1 && s.color === '#123456' && s.groupKey === result.rows[0].key));
  assert.ok(result.segments[0].left + result.segments[0].width < result.segments[1].left);
  assert.notEqual(result.segments[0].key, result.segments[1].key);
});

test('an active pause stays blank until resume, through the actual service record query', async () => {
  let now = at(8);
  const service = createService(createMemoryAdapter(), { clock: () => now });
  assert.equal((await service.init()).ok, true);
  const project = await service.createProject({ operationId: uuid(), name: '英语' });
  const started = await service.start({ operationId: uuid(), projectId: project.data.project.id });
  const input = () => ({ operationId: uuid(), sessionId: started.data.sessionId });
  now = at(8, 1);
  assert.equal((await service.pause(input())).ok, true);
  now = at(20);
  const paused = await service.getRecords();
  assert.equal(paused.ok, true);
  assert.equal(paused.data.rows[0].seconds, 60);
  assert.deepEqual(paused.data.rows[0].studyIntervals, [{ startedAtSec: at(8), endedAtSec: at(8, 1) }]);
  assert.equal((await service.resume(input())).ok, true);
  now = at(20, 1);
  assert.equal((await service.stop(input())).ok, true);
  const records = await service.getRecords({ mode: 'completed' });
  assert.equal(records.ok, true);
  assert.equal(records.data.rows[0].seconds, 120);
  assert.equal(buildTimeline(records.data.rows.map(timelineRecord)).segments.length, 2);
});

test('merged list records still leave gaps between their separate study bars', () => {
  const a = session({ endedAtSec: at(8, 1), durationSeconds: 60, pauses: [] });
  const b = session({ id: 's2', startedAtSec: at(8, 5), endedAtSec: at(8, 6), durationSeconds: 60, pauses: [] });
  const result = buildTimeline(recordsInRange([a, b], day, at(21)).map(timelineRecord));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].count, 2);
  assert.equal(result.rows[0].durText, '2分钟');
  assert.equal(result.segments.length, 2);
  assert.ok(result.segments[0].left + result.segments[0].width < result.segments[1].left);
  assert.equal(result.segments[0].groupKey, result.segments[1].groupKey);
});

test('pauses crossing midnight are clipped for each day without coloring the paused day', () => {
  const s = session({ startedAtSec: at(23, 58), endedAtSec: at(24 + 1, 1), durationSeconds: 120,
    pauses: [{ startedAtSec: at(23, 59), endedAtSec: at(24 + 1), status: 'COMPLETED' }] });
  const first = recordsInRange([s], day, at(26))[0];
  const next = recordsInRange([s], { start: at(24), end: at(48) }, at(26))[0];
  assert.deepEqual(first.studyIntervals, [{ startedAtSec: at(23, 58), endedAtSec: at(23, 59) }]);
  assert.deepEqual(next.studyIntervals, [{ startedAtSec: at(25), endedAtSec: at(25, 1) }]);
  assert.equal(first.seconds, 60);
  assert.equal(next.seconds, 60);
  assert.deepEqual(recordsInRange([s], { start: at(24), end: at(25) }, at(26)), []);
});

test('continuous study stays a single bar and zero-duration records add no colored interval', () => {
  const rows = recordsInRange([session({ endedAtSec: at(9), durationSeconds: 3600, pauses: [] })], day, at(21));
  assert.deepEqual(rows[0].studyIntervals, [{ startedAtSec: at(8), endedAtSec: at(9) }]);
  assert.equal(buildTimeline(rows.map(timelineRecord)).segments.length, 1);
  const zero = recordsInRange([session({ endedAtSec: at(8), durationSeconds: 0, pauses: [] })], day, at(21), null, true);
  assert.equal(zero.length, 1);
  assert.deepEqual(zero[0].studyIntervals, []);
  assert.equal(buildTimeline(zero.map(timelineRecord)).empty, true);
});
