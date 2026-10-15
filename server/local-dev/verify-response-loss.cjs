// Live DevTools + local PostgreSQL acceptance. Adds a clearly named test project
// and one short completed session; drops only that session's FIRST success
// callback after the real server has committed, then retries the frozen operation.
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const automator = require(path.join(process.env.LOCALAPPDATA, 'YoTick', 'AcceptanceTools', 'node_modules', 'miniprogram-automator'));
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '5433' || url.pathname !== '/yotick')
  throw new Error('Only the local YoTick test database is accepted');
const input = { createId: randomUUID(), startId: randomUUID(), stopId: randomUUID(), name: '回执丢失验收-' + randomUUID().slice(0, 8) };
const deadline = setTimeout(() => { console.error('Acceptance timed out; in-app request guard restores itself'); process.exit(1); }, 55000);
(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
  let pool;
  try {
    const client = await mp.evaluate(async input => {
      const app = getApp();
      await app.globalData.readyPromise;
      const accounts = app.globalData.accounts, service = app.globalData.service;
      await accounts.trigger();
      const current = await service.getCurrent();
      if (!current.ok || current.data.sessionId || accounts.getStatus().pending || accounts.getStatus().state !== 'synced')
        throw new Error('Acceptance requires an idle synced account');
      const original = wx.request;
      const drill = { targetId: null, operations: [], operationId: null, dropped: 0 };
      const guard = setTimeout(() => { wx.request = original; }, 45000);
      wx.request = function(options) {
        const operation = options.url.endsWith('/sync/push') && options.data?.operations?.find(op =>
          op.kind === 'session.createCompleted' && op.entityId === drill.targetId);
        if (!operation) return original.call(wx, options);
        drill.operations.push(JSON.stringify(operation));
        drill.operationId = operation.operationId;
        return original.call(wx, {
          ...options,
          success(result) {
            if (!drill.dropped && result.statusCode === 200 && result.data?.results?.[0]?.status === 'applied') {
              drill.dropped++;
              options.fail({ errMsg: 'request:fail acceptance discarded committed response' });
            } else options.success(result);
          },
        });
      };
      let projectId, sessionId;
      try {
        if (wx.request === original) throw new Error('Request interception unsupported');
        const project = await service.createProject({ operationId: input.createId, name: input.name });
        if (!project.ok) throw new Error(project.error?.message || 'Could not create acceptance project');
        projectId = project.data.project.id;
        await accounts.trigger();
        const start = await service.start({ operationId: input.startId, projectId });
        if (!start.ok) throw new Error(start.error?.message || 'Could not start acceptance timer');
        sessionId = (await service.getCurrent()).data.sessionId;
        drill.targetId = sessionId;
        await new Promise(resolve => setTimeout(resolve, 1200));
        const stop = await service.stop({ operationId: input.stopId, sessionId });
        if (!stop.ok) throw new Error(stop.error?.message || 'Could not save acceptance timer');
        for (let attempt = 0; attempt < 6 && !drill.dropped; attempt++) {
          await accounts.trigger();
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (!drill.dropped) throw new Error('No committed response was dropped');
        const afterLoss = { ...accounts.getStatus() };
        await accounts.trigger();
        const recovered = accounts.getStatus();
        if (drill.operations.length < 2 || drill.operations.some(op => op !== drill.operations[0]))
          throw new Error('Retry did not preserve the original frozen request');
        if (recovered.state !== 'synced' || recovered.pending !== 0 || recovered.message)
          throw new Error('Client did not recover cleanly');
        return { projectId, sessionId, operationId: drill.operationId, name: input.name,
          droppedResponses: drill.dropped, attempts: drill.operations.length,
          identicalFrozenRequests: true, afterLoss: { state: afterLoss.state, pending: afterLoss.pending },
          recovered: { state: recovered.state, pending: recovered.pending, message: recovered.message } };
      } finally {
        wx.request = original;
        clearTimeout(guard);
      }
    }, input);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const count = (await pool.query('SELECT count(*)::int count FROM study_sessions WHERE project_id=$1', [client.projectId])).rows[0].count;
    const receipts = (await pool.query('SELECT count(*)::int count FROM sync_operations WHERE operation_id=$1', [client.operationId])).rows[0].count;
    if (count !== 1 || receipts !== 1) throw new Error('Expected one completed session and one durable receipt');
    const evidence = { capturedAt: new Date().toISOString(), result: 'passed', client, database: { sessions: count, receipts } };
    const evidencePath = path.join(process.env.LOCALAPPDATA, 'YoTick', 'LocalServer', 'response-loss-' + client.sessionId + '.json');
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ...evidence, evidencePath }));
  } finally {
    if (pool) await pool.end();
    mp.disconnect();
    clearTimeout(deadline);
  }
})().catch(error => { clearTimeout(deadline); console.error(error.message); process.exitCode = 1; });
