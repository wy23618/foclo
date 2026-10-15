// Hold one real pull response while exercising all local timer commands.
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const automator = require(path.join(process.env.LOCALAPPDATA, 'YoTick', 'AcceptanceTools', 'node_modules', 'miniprogram-automator'));
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '5433' || url.pathname !== '/yotick') throw new Error('Local test database required');
(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
  let pool;
  try {
    const input = { createId: randomUUID(), startId: randomUUID(), pauseId: randomUUID(), resumeId: randomUUID(), stopId: randomUUID(), name: '慢网计时验收-' + randomUUID().slice(0, 8) };
    await mp.evaluate(input => {
      getApp().globalData.slowNetworkResult = null;
      (async () => {
        const app = getApp(), { accounts, service, adapter } = app.globalData;
        await app.globalData.readyPromise;
        let original, guard;
        try {
          await accounts.trigger();
          if ((await service.getCurrent()).data.sessionId || accounts.getStatus().pending || (await accounts.conflicts()).length)
            throw new Error('Idle conflict-free account required');
          const p = await service.createProject({ operationId: input.createId, name: input.name });
          if (!p.ok) throw new Error('Acceptance project creation failed');
          const projectId = p.data.project.id; await accounts.trigger();
          original = wx.request;
          let held = false, delivered = false, settle;
          const heldPromise = new Promise(resolve => { settle = resolve; });
          guard = setTimeout(() => { wx.request = original; }, 20000);
          wx.request = function(options) {
            if (!options.url.includes('/sync/pull') || held) return original.call(wx, options);
            held = true;
            return original.call(wx, { ...options, success(result) {
              settle();
              setTimeout(() => { delivered = true; options.success(result); }, 5000);
            }, fail(error) { delivered = true; settle(); options.fail(error); } });
          };
          const syncing = accounts.trigger();
          await heldPromise;
          const measurements = [];
          async function command(name, fn) {
            const began = Date.now(), result = await fn();
            if (!result.ok) throw new Error(result.error?.message || name + ' failed');
            if (delivered) throw new Error(name + ' did not finish before the held response');
            measurements.push({ command: name, elapsedMs: Date.now() - began });
            return result;
          }
          const started = await command('start', () => service.start({ operationId: input.startId, projectId }));
          const sessionId = started.data.sessionId;
          await new Promise(resolve => setTimeout(resolve, 1100));
          await command('pause', () => service.pause({ operationId: input.pauseId, sessionId }));
          await command('resume', () => service.resume({ operationId: input.resumeId, sessionId }));
          await new Promise(resolve => setTimeout(resolve, 1100));
          await command('stop', () => service.stop({ operationId: input.stopId, sessionId }));
          const saved = await adapter.get('yotick/s/' + sessionId);
          if (saved?.status !== 'COMPLETED' || saved.pauses.length !== 1) throw new Error('Local completed fact or pause missing');
          await syncing; wx.request = original;
          await accounts.trigger();
          if (accounts.getStatus().state !== 'synced' || accounts.getStatus().pending) throw new Error('Slow network did not recover');
          app.globalData.slowNetworkResult = { projectId, sessionId, heldResponseMs: 5000, measurements,
            commandsFinishedBeforeResponse: true, completedFactSavedLocally: true, status: accounts.getStatus().state };
        } catch (error) { app.globalData.slowNetworkResult = { error: error.message }; }
        finally { if (original) wx.request = original; if (guard) clearTimeout(guard); }
      })();
      return true;
    }, input);
    let client;
    for (let i = 0; i < 50; i++) {
      client = await mp.evaluate(() => getApp().globalData.slowNetworkResult);
      if (client) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!client || client.error) throw new Error(client?.error || 'Slow network acceptance timed out');
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const count = (await pool.query('SELECT count(*)::int count FROM study_sessions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL', [client.sessionId, client.projectId])).rows[0].count;
    if (count !== 1) throw new Error('Expected one uploaded completed session');
    const evidence = { result: 'passed', capturedAt: new Date().toISOString(), scope: 'DevTools held response + real PostgreSQL; not mobile frame measurement', client, database: { sessions: count } };
    const evidencePath = path.join(process.env.LOCALAPPDATA, 'YoTick', 'LocalServer', 'slow-network-' + client.sessionId + '.json');
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ...evidence, evidencePath }));
  } finally { if (pool) await pool.end(); mp.disconnect(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
