// Deletes only a newly created drill project through a controlled peer writer.
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const automator = require(path.join(process.env.LOCALAPPDATA, 'YoTick', 'AcceptanceTools', 'node_modules', 'miniprogram-automator'));
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '5433' || url.pathname !== '/yotick') throw new Error('Local test database required');
const input = { createId: randomUUID(), startId: randomUUID(), stopId: randomUUID(), peerId: randomUUID(), deleteId: randomUUID(), suffix: randomUUID().slice(0, 8) };
(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
  let pool;
  try {
    await mp.evaluate(input => {
      getApp().globalData.activeDeleteResult = null;
      (async () => {
      try {
      const app = getApp(); await app.globalData.readyPromise;
      const { accounts, service, adapter } = app.globalData;
      app.globalData.activeDeleteDrill = { stage: 'starting' };
      const mark = stage => { app.globalData.activeDeleteDrill.stage = stage; };
      await accounts.trigger();
      if ((await service.getCurrent()).data.sessionId || accounts.getStatus().pending || (await accounts.conflicts()).length)
        throw new Error('An idle, conflict-free synced account is required');
      const p = await service.createProject({ operationId: input.createId, name: '删除恢复验收-' + input.suffix });
      if (!p.ok) throw new Error('Project creation failed');
      const projectId = p.data.project.id; await accounts.trigger();
      app.globalData.activeDeleteDrill.projectId = projectId;
      const shadow = await adapter.get('yotick/shadow/project/' + projectId);
      const start = await service.start({ operationId: input.startId, projectId });
      if (!start.ok) throw new Error('Timer start failed');
      const sessionId = (await service.getCurrent()).data.sessionId;
      app.globalData.activeDeleteDrill.sessionId = sessionId;
      await new Promise(resolve => setTimeout(resolve, 1200));
      const ref = accounts.getCurrent();
      const result = await accounts.getRequest()('POST', '/sync/push', {
        protocolVersion: 1, spaceId: ref.spaceId, generation: ref.generation, deviceId: input.peerId,
        operations: [{ operationId: input.deleteId, kind: 'project.deleteSubtree', entityId: projectId,
          baseServerVersion: shadow.serverVersion, payload: { expectedVersions: { [projectId]: shadow.serverVersion } } }],
      });
      if (result.results?.[0]?.status !== 'applied') throw new Error('Peer delete rejected');
      await accounts.trigger();
      if ((await service.getCurrent()).data.sessionId !== sessionId) throw new Error('Remote delete interrupted timer');
      const activeConflict = (await accounts.conflicts()).find(c => c.code === 'ACTIVE_PROJECT_DELETED' && c.cloud?.entityId === projectId);
      if (!activeConflict) throw new Error('Active deletion warning missing');
      const stopped = await service.stop({ operationId: input.stopId, sessionId });
      if (!stopped.ok) throw new Error(stopped.error?.message || 'Local stop failed');
      await accounts.trigger();
      const fact = await adapter.get('yotick/s/' + sessionId);
      const all = await accounts.conflicts();
      const conflict = all.find(c => c.local?.entityId === sessionId || c.local?.payload?.id === sessionId);
      if (!fact || fact.status !== 'COMPLETED' || !conflict) throw new Error('Completed orphan record was not preserved');
      const destination = await accounts.recoverConflict(conflict.id, null, '恢复验收-' + input.suffix);
      mark('recovered');
      await accounts.resolveConflict(activeConflict.id, 'cloud');
      mark('resolved');
      await accounts.trigger();
      mark('synced');
      const archive = await adapter.get('yotick/recovery/' + conflict.id);
      if (!archive?.preservedTasks?.length || await adapter.get('yotick/s/' + sessionId)) throw new Error('Recovery archive or duplicate removal failed');
      if ((await adapter.get('yotick/projects'))[projectId] || accounts.getStatus().pending || (await accounts.conflicts()).length)
        throw new Error('Deleted project resurrected or recovery left unresolved work');
      mark('passed');
      getApp().globalData.activeDeleteResult = { projectId, sessionId, destination, timerSurvived: true, originalPreservedInArchive: true, status: accounts.getStatus().state };
      } catch (error) { getApp().globalData.activeDeleteResult = { error: error.message }; }
      })();
      return true;
    }, input);
    let client;
    for (let attempt = 0; attempt < 90; attempt++) {
      client = await mp.evaluate(() => getApp().globalData.activeDeleteResult);
      if (client) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!client) throw new Error('Active deletion acceptance timed out; inspect preserved drill state before retry');
    if (client.error) throw new Error(client.error);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const deleted = (await pool.query('SELECT deleted_at IS NOT NULL deleted FROM projects WHERE id=$1', [client.projectId])).rows[0];
    const original = (await pool.query('SELECT count(*)::int count FROM study_sessions WHERE id=$1', [client.sessionId])).rows[0].count;
    const restored = (await pool.query('SELECT count(*)::int count FROM study_sessions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL', [client.destination.sessionId, client.destination.projectId])).rows[0].count;
    if (!deleted?.deleted || original !== 0 || restored !== 1) throw new Error('Database deletion/recovery verification failed');
    const evidence = { result: 'passed', capturedAt: new Date().toISOString(), client, database: { originalProjectDeleted: true, originalSessions: original, recoveredSessions: restored } };
    const evidencePath = path.join(process.env.LOCALAPPDATA, 'YoTick', 'LocalServer', 'active-delete-' + client.projectId + '.json');
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ...evidence, evidencePath }));
  } finally { if (pool) await pool.end(); mp.disconnect(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
