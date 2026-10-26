// Account audit through the existing authenticated DevTools session.
// Never edits facts, merges, deletes, clears storage, or logs credentials.
// A cloud export creates only a consistent, expiring snapshot for comparison.
const fs = require('node:fs');
const path = require('node:path');
const automator = require(path.join(process.env.LOCALAPPDATA, 'YoTick', 'AcceptanceTools', 'node_modules', 'miniprogram-automator'));
const suffix = process.argv[2];
if (!/^[a-f0-9]{4}$/.test(suffix || '')) throw new Error('Supply the exact four-character account suffix.');
const deadline = setTimeout(() => { console.error('Account audit timed out'); process.exit(1); }, 120000);

(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
  try {
    const report = await mp.evaluate(async suffix => {
      const app = getApp(); await app.globalData.readyPromise;
      const accounts = app.globalData.accounts, ref = accounts.getCurrent();
      if (!ref || !ref.userId.endsWith(suffix)) throw new Error('Requested account is not active; nothing changed.');
      const status = accounts.getStatus();
      if (status.state !== 'synced' || status.pending !== 0) throw new Error('Account must finish synchronization before audit.');
      const adapter = app.globalData.adapter, keys = await adapter.keys();
      const localProjects = Object.values(await adapter.get('yotick/projects') || {}), localSessions = [];
      for (const key of keys.filter(k => k.startsWith('yotick/s/'))) localSessions.push(await adapter.get(key));
      const request = accounts.getRequest();
      const job = await request('POST', '/exports', { generation: ref.generation });
      const items = []; let offset = 0, complete = false;
      for (let i = 0; i < 10000; i++) {
        const page = await request('GET', '/exports/' + job.id, { offset });
        if (String(page.generation) !== String(ref.generation) || String(page.upperSeq) !== String(job.upperSeq)) throw new Error('Snapshot boundary changed.');
        items.push(...page.changes);
        if (!page.hasMore) { complete = true; break; }
        if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('Invalid snapshot pagination.');
        offset = page.nextOffset;
      }
      if (!complete) throw new Error('Incomplete snapshot.');
      const cloudProjects = items.filter(i => i.entityType === 'project' && !i.deleted).map(i => i.data);
      const cloudSessions = items.filter(i => i.entityType === 'session' && !i.deleted).map(i => i.data);
      function canonical(value) {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === 'object') { const out = {}; Object.keys(value).sort().forEach(k => { out[k] = canonical(value[k]); }); return out; }
        return value;
      }
      const encode = value => JSON.stringify(canonical(value));
      const short = id => String(id || '').slice(-8);
      function groups(rows, signature) {
        const map = new Map();
        for (const row of rows) { const key = signature(row); if (!map.has(key)) map.set(key, []); map.get(key).push(short(row.id)); }
        return [...map.values()].filter(ids => ids.length > 1);
      }
      function inspect(projects, sessions) {
        const errors = [], warnings = [], ids = new Set(projects.map(p => p.id)), pauseIds = new Set();
        const projectMap = new Map(projects.map(p => [p.id, p]));
        const fail = (code, id) => errors.push({ code, id: short(id) });
        for (const p of projects) {
          if (p.parentId && !ids.has(p.parentId)) fail('MISSING_PARENT', p.id);
          const seen = new Set([p.id]); let parent = p.parentId;
          while (parent && projectMap.has(parent)) { if (seen.has(parent)) { fail('PROJECT_CYCLE', p.id); break; } seen.add(parent); parent = projectMap.get(parent).parentId; }
        }
        let totalSeconds = 0, pauses = 0, zeroDuration = 0;
        const statusCounts = {}, byDay = {};
        for (const s of sessions) {
          if (!s) { fail('MISSING_SESSION', ''); continue; }
          if (!ids.has(s.projectId)) fail('MISSING_PROJECT', s.id);
          statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
          if (!['COMPLETED', 'ACTIVE'].includes(s.status)) fail('INVALID_STATUS', s.id);
          if (!Number.isSafeInteger(s.startedAtSec) || s.startedAtSec <= 0) fail('INVALID_START', s.id);
          if (!Number.isSafeInteger(s.durationSeconds) || s.durationSeconds < 0) fail('INVALID_DURATION', s.id);
          if (s.targetSeconds != null && (!Number.isSafeInteger(s.targetSeconds) || s.targetSeconds < 60)) fail('INVALID_TARGET', s.id);
          if (s.targetSeconds != null && s.durationSeconds > s.targetSeconds) fail('DURATION_EXCEEDS_TARGET', s.id);
          let paused = 0, cursor = s.startedAtSec;
          for (const p of (s.pauses || []).slice().sort((a, b) => a.startedAtSec - b.startedAtSec)) {
            pauses++;
            if (pauseIds.has(p.id)) fail('DUPLICATE_PAUSE_ID', p.id); pauseIds.add(p.id);
            if (p.sessionId !== s.id) fail('PAUSE_SESSION_MISMATCH', p.id);
            if (p.status !== 'COMPLETED' || !Number.isSafeInteger(p.startedAtSec) || !Number.isSafeInteger(p.endedAtSec) || p.startedAtSec < cursor || p.endedAtSec < p.startedAtSec || p.endedAtSec > s.endedAtSec || p.durationSeconds !== p.endedAtSec - p.startedAtSec) fail('INVALID_PAUSE_INTERVAL', p.id);
            paused += p.durationSeconds; cursor = p.endedAtSec;
          }
          if (s.status === 'COMPLETED' && (!Number.isSafeInteger(s.endedAtSec) || s.endedAtSec < s.startedAtSec || s.durationSeconds !== s.endedAtSec - s.startedAtSec - paused)) fail('DURATION_INTERVAL_MISMATCH', s.id);
          if (s.status === 'COMPLETED') {
            totalSeconds += s.durationSeconds; if (s.durationSeconds === 0) zeroDuration++;
            const day = new Date((s.startedAtSec + 28800) * 1000).toISOString().slice(0, 10);
            byDay[day] = (byDay[day] || 0) + 1;
          }
        }
        const exactDuplicates = groups(sessions, s => encode([s.projectId, s.status, s.startedAtSec, s.endedAtSec, s.durationSeconds, s.targetSeconds, (s.pauses || []).map(p => [p.startedAtSec, p.endedAtSec, p.durationSeconds]) ]));
        const sameIntervals = groups(sessions.filter(s => s.durationSeconds > 0), s => encode([s.startedAtSec, s.endedAtSec]));
        const overlapping = [];
        function focusSpans(s) {
          const out=[]; let cursor=s.startedAtSec;
          for(const p of (s.pauses || []).slice().sort((a,b)=>a.startedAtSec-b.startedAtSec)) { if(p.startedAtSec>cursor)out.push([cursor,p.startedAtSec]); cursor=p.endedAtSec; }
          if(s.endedAtSec>cursor)out.push([cursor,s.endedAtSec]); return out;
        }
        const ordered = sessions.filter(s => s.status === 'COMPLETED' && s.durationSeconds > 0).slice().sort((a,b) => a.startedAtSec-b.startedAtSec);
        for (let i=0;i<ordered.length;i++) for(let j=i+1;j<ordered.length && ordered[j].startedAtSec<ordered[i].endedAtSec;j++) {
          let focusOverlapSeconds=0;
          for(const x of focusSpans(ordered[i]))for(const y of focusSpans(ordered[j]))focusOverlapSeconds+=Math.max(0,Math.min(x[1],y[1])-Math.max(x[0],y[0]));
          overlapping.push({ids:[short(ordered[i].id),short(ordered[j].id)],date:new Date((ordered[j].startedAtSec+28800)*1000).toISOString().slice(0,10),sameProject:ordered[i].projectId===ordered[j].projectId,focusOverlapSeconds});
        }
        if (zeroDuration) warnings.push({code:'ZERO_DURATION', count:zeroDuration});
        if (overlapping.some(p=>p.focusOverlapSeconds>0)) warnings.push({code:'OVERLAPPING_FOCUS_INTERVALS_REVIEW', count:overlapping.filter(p=>p.focusOverlapSeconds>0).length});
        return { projects:projects.length, sessions:sessions.length, pauses, statusCounts, totalSeconds, firstDay:Object.keys(byDay).sort()[0] || null, lastDay:Object.keys(byDay).sort().slice(-1)[0] || null, byDay,
          duplicateProjectIds:groups(projects,p=>p.id), duplicateProjectNames:groups(projects,p=>p.name), duplicateSessionIds:groups(sessions,s=>s.id), exactDuplicateSessions:exactDuplicates, sameIntervals, overlapping, errors, warnings };
      }
      function compare(local, cloud, fields) {
        const l=new Map(local.map(r=>[r.id,r])), c=new Map(cloud.map(r=>[r.id,r]));
        const missingLocal=[...c.keys()].filter(id=>!l.has(id)).map(short), missingCloud=[...l.keys()].filter(id=>!c.has(id)).map(short), different=[];
        for(const [id,row] of l) if(c.has(id)) { const changed=fields.filter(k=>encode(row[k] == null ? null : row[k])!==encode(c.get(id)[k] == null ? null : c.get(id)[k])); if(changed.length)different.push({id:short(id),fields:changed}); }
        return {missingLocal,missingCloud,different};
      }
      const local=inspect(localProjects,localSessions), cloud=inspect(cloudProjects,cloudSessions);
      const indexes={duplicateReferences:[],danglingReferences:[],wrongProjectReferences:[],missingProjectReferences:[]};
      const sessionMap=new Map(localSessions.map(s=>[s.id,s]));
      for(const key of keys.filter(k=>k.startsWith('yotick/d/')||k.startsWith('yotick/p/'))) {
        const list=await adapter.get(key);
        if(!Array.isArray(list)){indexes.danglingReferences.push({kind:key.slice(0,8),reason:'NOT_ARRAY'});continue;}
        if(new Set(list).size!==list.length)indexes.duplicateReferences.push({kind:key.slice(0,8)});
        for(const id of list) {if(!sessionMap.has(id))indexes.danglingReferences.push({kind:key.slice(0,8),id:short(id)}); else if(key.startsWith('yotick/p/')&&sessionMap.get(id).projectId!==key.slice(9)) indexes.wrongProjectReferences.push({id:short(id)});}
      }
      for(const s of localSessions) {const list=await adapter.get('yotick/p/'+s.projectId);if(!Array.isArray(list)||!list.includes(s.id))indexes.missingProjectReferences.push(short(s.id));}
      const deletedCloudSessionsPresentLocally=[];
      for(const item of items.filter(i=>i.entityType==='session'&&i.deleted)) {
        const s=sessionMap.get(item.entityId); if(!s)continue;
        const shadow=await adapter.get('yotick/shadow/session/'+s.id);
        deletedCloudSessionsPresentLocally.push({id:short(s.id),date:new Date((s.startedAtSec+28800)*1000).toISOString().slice(0,10),seconds:s.durationSeconds,shadowDeleted:!!shadow?.deleted});
      }
      return {capturedAt:new Date().toISOString(),accountSuffix:suffix,generation:ref.generation,cloudUpperSeq:job.upperSeq,sync:accounts.getStatus(),local,cloud,indexes,deletedCloudSessionsPresentLocally,
        comparison:{projects:compare(localProjects,cloudProjects,['name','parentId','archived','color','shortName','creationOrder','createdAtSec','updatedAtSec']),sessions:compare(localSessions,cloudSessions,['projectId','status','startedAtSec','endedAtSec','durationSeconds','targetSeconds','createdAtSec','updatedAtSec','pauses'])},
        conflicts:keys.filter(k=>k.startsWith('yotick/conflicts/')).length,pendingOperations:keys.filter(k=>k.startsWith('yotick/outbox/')).length,unfinishedCommits:keys.filter(k=>k.startsWith('yotick/c/')).length,
        cloudTombstones:items.filter(i=>i.deleted).length};
    }, suffix);
    const root=path.join(process.env.LOCALAPPDATA,'YoTick','LocalServer'); fs.mkdirSync(root,{recursive:true});
    const file=path.join(root,`account-audit-${suffix}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    fs.writeFileSync(file,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({reportFile:file,...report},null,2));
    await mp.reLaunch('/pages/account/account');
    await mp.screenshot({path:path.join(root,`account-audit-${suffix}.png`)});
  } finally { mp.disconnect(); clearTimeout(deadline); }
})().catch(error=>{clearTimeout(deadline);console.error(error.message);process.exitCode=1;});
