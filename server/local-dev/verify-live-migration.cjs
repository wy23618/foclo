// Runs the shared migration client with isolated persistent samples and a real
// authenticated DevTools request bridge. Never reads the user's guest space.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createService } = require('../../core/service');
const { createAccountAdapter } = require('../../storage/account-adapter');
const migration = require('../../sync/migration');
const automator = require(path.join(process.env.LOCALAPPDATA, 'YoTick', 'AcceptanceTools', 'node_modules', 'miniprogram-automator'));
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '5433' || url.pathname !== '/yotick') throw new Error('Local test database required');
function diskAdapter(file) {
  const values = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(values)); fs.renameSync(file + '.tmp', file); };
  return { type: 'acceptance-disk', async get(k) { return values[k] === undefined ? undefined : structuredClone(values[k]); },
    async set(k, v) { values[k] = structuredClone(v); save(); }, async remove(k) { delete values[k]; save(); },
    async keys() { return Object.keys(values); } };
}
(async () => {
  const id = randomUUID(), suffix = id.slice(0, 8);
  const root = path.join(process.env.LOCALAPPDATA, 'YoTick', 'LocalServer');
  const file = path.join(root, 'migration-sample-' + id + '.json');
  let raw = diskAdapter(file), target = createAccountAdapter(raw, 'migration-target');
  const guest = createAccountAdapter(raw, 'guest'), service = createService(guest, { syncEnabled: false });
  assert.equal((await service.init()).ok, true);
  const p = await service.createProject({ operationId: randomUUID(), name: '迁移中断验收-' + suffix });
  assert.equal(p.ok, true);
  const start = await service.start({ operationId: randomUUID(), projectId: p.data.project.id });
  assert.equal(start.ok, true);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await service.stop({ operationId: randomUUID(), sessionId: start.data.sessionId })).ok, true);
  const original = (await service.createBackup()).data;
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
  let pool;
  try {
    const ref = await mp.evaluate(() => getApp().globalData.accounts.getCurrent());
    if (!ref) throw new Error('Authenticated DevTools account required');
    const request = async (method, route, body) => {
      const response = await mp.evaluate(async input => {
        try { return { data: await getApp().globalData.accounts.getRequest()(input.method, input.route, input.body) }; }
        catch (error) { return { error: { message: error.message, code: error.code } }; }
      }, { method, route, body });
      if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
      return response.data;
    };
    let droppedChunk = false, chunkWrites = 0;
    await assert.rejects(() => migration.upload(raw, target, async (method, route, body) => {
      const result = await request(method, route, body);
      if (method === 'PUT' && route.includes('/chunks/')) {
        chunkWrites++;
        droppedChunk = true;
        throw new Error('acceptance: uploaded chunk response lost');
      }
      return result;
    }, ref.generation), /chunk response lost/);
    assert.equal(droppedChunk, true);
    const jobId = (await target.get('yotick/import/current')).id;
    // Reopen the on-disk adapters as after a client restart; retained server
    // chunks must be discovered rather than uploaded as another migration.
    raw = diskAdapter(file); target = createAccountAdapter(raw, 'migration-target');
    await migration.upload(raw, target, async (method, route, body) => {
      if (method === 'PUT') chunkWrites++;
      return request(method, route, body);
    }, ref.generation);
    assert.equal((await target.get('yotick/import/current')).id, jobId);
    assert.equal(chunkWrites, 1);
    const deviceId = randomUUID();
    await assert.rejects(() => migration.commit(target, async (...args) => {
      await request(...args);
      throw new Error('acceptance: committed response lost');
    }, deviceId, {}, {}), /committed response lost/);
    raw = diskAdapter(file); target = createAccountAdapter(raw, 'migration-target');
    const committed = await migration.commit(target, request, deviceId, {}, {});
    assert.equal(committed.committed, true);
    assert.equal((await target.get('yotick/import/current')).status, 'committed');
    const reopened = createService(createAccountAdapter(raw, 'guest'), { syncEnabled: false });
    assert.equal((await reopened.init()).ok, true);
    assert.deepEqual((await reopened.createBackup()).data, original);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const job = (await pool.query('SELECT status,source_id FROM import_jobs WHERE id=$1', [jobId])).rows[0];
    const count = (await pool.query('SELECT count(*)::int count FROM study_sessions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL', [start.data.sessionId, p.data.project.id])).rows[0].count;
    const chunks = (await pool.query('SELECT count(*)::int count FROM import_items WHERE job_id=$1', [jobId])).rows[0].count;
    assert.equal(job.status, 'committed'); assert.equal(count, 1); assert.equal(chunks, 1);
    const evidence = { result: 'passed', capturedAt: new Date().toISOString(), scope: 'Node shared migration client + isolated disk sample + real DevTools HTTP + PostgreSQL; not physical device restart',
      jobId, projectId: p.data.project.id, sessionId: start.data.sessionId, droppedChunkResponse: true,
      chunkWrites, droppedCommitResponse: true, adaptersReopenedTwice: true, guestSourceUnchanged: true,
      database: { jobStatus: job.status, chunks, sessions: count } };
    const evidencePath = path.join(root, 'migration-interruption-' + jobId + '.json');
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ...evidence, evidencePath }));
  } finally { if (pool) await pool.end(); mp.disconnect(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
