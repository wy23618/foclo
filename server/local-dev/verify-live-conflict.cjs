// Controlled concurrent writer against a NEW explicitly named acceptance project.
// The existing DevTools client receives a real PostgreSQL CAS conflict. Selecting
// cloud must preserve the local proposal in its recovery archive.
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const automator = require(path.join(process.env.LOCALAPPDATA, 'YoTick', 'AcceptanceTools', 'node_modules', 'miniprogram-automator'));
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '5433' || url.pathname !== '/yotick') throw new Error('Local test database required');
const suffix = randomUUID().slice(0, 8);
const input = { createId: randomUUID(), renameId: randomUUID(), peerOpId: randomUUID(), peerDeviceId: randomUUID(),
  name: '并发验收-' + suffix, localName: '并发验收-本地-' + suffix, cloudName: '并发验收-另一端-' + suffix };
const deadline = setTimeout(() => { console.error('Conflict acceptance timed out; request guard restores itself'); process.exit(1); }, 55000);
(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
  let pool;
  try {
    const client = await mp.evaluate(async input => {
      const app = getApp();
      await app.globalData.readyPromise;
      const accounts = app.globalData.accounts, service = app.globalData.service;
      await accounts.trigger();
      if ((await service.getCurrent()).data.sessionId || accounts.getStatus().state !== 'synced' || accounts.getStatus().pending)
        throw new Error('An idle synced account is required');
      const created = await service.createProject({ operationId: input.createId, name: input.name });
      if (!created.ok) throw new Error('Acceptance project could not be created');
      const projectId = created.data.project.id;
      await accounts.trigger();
      const original = wx.request;
      let injected = false, localOpId, peerApplied = false;
      const guard = setTimeout(() => { wx.request = original; }, 45000);
      wx.request = function(options) {
        const operation = options.url.endsWith('/sync/push') && options.data?.operations?.find(op =>
          op.kind === 'project.patch' && op.entityId === projectId && op.payload.name === input.localName);
        if (!operation || injected) return original.call(wx, options);
        injected = true;
        localOpId = operation.operationId;
        let task, cancelled = false;
        task = original.call(wx, {
          ...options,
          data: { ...options.data, deviceId: input.peerDeviceId, operations: [{ ...operation,
            operationId: input.peerOpId, payload: { ...operation.payload, name: input.cloudName } }] },
          success(result) {
            if (cancelled) return;
            if (result.statusCode !== 200 || result.data?.results?.[0]?.status !== 'applied') {
              options.fail({ errMsg: 'request:fail acceptance peer mutation rejected' });
              return;
            }
            peerApplied = true;
            task = original.call(wx, options);
          },
          fail: error => { if (!cancelled) options.fail(error); },
        });
        return { abort() { cancelled = true; if (task) task.abort(); } };
      };
      try {
        const renamed = await service.renameProject({ operationId: input.renameId, projectId, name: input.localName });
        if (!renamed.ok) throw new Error('Local rename failed');
        await accounts.trigger();
        if (!peerApplied) throw new Error('Concurrent writer did not apply');
        const all = await accounts.conflicts();
        const conflicts = all.filter(c => c.local?.entityId === projectId || c.cloud?.entityId === projectId);
        const conflict = conflicts.find(c => c.cloud?.data?.name === input.cloudName);
        const adapter = app.globalData.adapter;
        const localBefore = (await adapter.get('yotick/projects'))[projectId]?.name;
        if (!conflict || localBefore !== input.localName || accounts.getStatus().state !== 'conflict')
          throw new Error('Expected both proposals and an explicit conflict state');
        await accounts.resolveConflict(conflict.id, 'cloud');
        await accounts.trigger();
        const saved = await adapter.get('yotick/recovery/' + conflict.id);
        const preserved = saved?.preservedTasks?.some(t => t.operationId === localOpId && t.payload.name === input.localName);
        const localAfter = (await adapter.get('yotick/projects'))[projectId]?.name;
        const status = accounts.getStatus();
        if (!preserved || localAfter !== input.cloudName || status.state !== 'synced' || status.pending !== 0)
          throw new Error('Conflict resolution did not preserve the local proposal or finish syncing');
        return { projectId, peerOpId: input.peerOpId, localOpId, conflictId: conflict.id,
          localBefore, cloudProposal: conflict.cloud.data.name, localAfter,
          localProposalPreserved: preserved, status: status.state, pending: status.pending };
      } finally { wx.request = original; clearTimeout(guard); }
    }, input);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const project = (await pool.query('SELECT name,server_version FROM projects WHERE id=$1 AND deleted_at IS NULL', [client.projectId])).rows[0];
    const receipts = (await pool.query('SELECT operation_id,result AS receipt FROM sync_operations WHERE operation_id=ANY($1::uuid[])', [[client.peerOpId, client.localOpId]])).rows;
    const rejected = receipts.find(r => r.operation_id === client.localOpId);
    if (project?.name !== input.cloudName || receipts.length !== 2 || rejected?.receipt?.code !== 'VERSION_CONFLICT')
      throw new Error('Database did not preserve the winning name and losing-version receipt');
    const evidence = { result: 'passed', capturedAt: new Date().toISOString(), client,
      database: { name: project.name, version: project.server_version, receipts: receipts.length, rejectedCode: rejected.receipt.code } };
    const evidencePath = path.join(process.env.LOCALAPPDATA, 'YoTick', 'LocalServer', 'live-conflict-' + client.projectId + '.json');
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ...evidence, evidencePath }));
  } finally { if (pool) await pool.end(); mp.disconnect(); clearTimeout(deadline); }
})().catch(error => { clearTimeout(deadline); console.error(error.message); process.exitCode = 1; });
