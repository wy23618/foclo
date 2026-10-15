import { requireValue } from './protocol.js';

// Account contents and deletion markers win over an older guest copy.
// Resolve names only inside the resolved parent, never across unrelated folders.
export function planGuestMerge(source: { projects:any[]; sessions:any[] }, projects:any[], sessions:any[], generation:string) {
  const mapping:Record<string,string> = {}, sessionMapping:Record<string,string> = {};
  const projectOverrides:Record<string,any> = {};
  const skippedProjects = new Set<string>(), done = new Set<string>();
  const targets = projects.slice();
  let ordered = source.projects.slice();
  while (ordered.length) {
    const ready = ordered.filter(p => !p.parentId || done.has(p.parentId));
    requireValue(ready.length > 0, 'INVALID_PARENT');
    for (const p of ready) {
      const same = projects.find(row => row.id === p.id);
      if (skippedProjects.has(p.parentId) || same && (same.deleted_at || String(same.generation) !== String(generation))) {
        skippedProjects.add(p.id);
      } else if (same) {
        mapping[p.id] = p.id;
      } else {
        const parentId = mapping[p.parentId] || p.parentId || null;
        const named = targets.find(row => !row.deleted_at && String(row.generation) === String(generation) &&
          row.data.name === p.name && (row.data.parentId || null) === parentId);
        if (named) mapping[p.id] = named.id;
        else {
          let name = p.name, suffix = 1;
          while (targets.some(row => !row.deleted_at && String(row.generation) === String(generation) && row.data.name === name)) {
            name = p.name.slice(0, 100) + '（登录前' + (suffix === 1 ? '' : suffix) + '）';
            suffix++;
          }
          const parent = targets.find(row => row.id === parentId);
          const data = { ...p, name, parentId, archived:!!p.archived || !!parent?.data.archived };
          projectOverrides[p.id] = data;
          targets.push({ id:p.id, generation, data, deleted_at:null });
        }
      }
      done.add(p.id);
    }
    ordered = ordered.filter(p => !done.has(p.id));
  }
  const fingerprint = (s:any, projectId:string) => JSON.stringify([
    projectId, s.startedAtSec, s.endedAtSec, s.durationSeconds, s.targetSeconds ?? null,
    (s.pauses || []).map((p:any) => [p.startedAtSec, p.endedAtSec, p.durationSeconds]).sort(),
  ]);
  const known = new Set(sessions.map(row => fingerprint(row.data, row.data.projectId)));
  for (const s of source.sessions) {
    const projectId = mapping[s.projectId] || s.projectId;
    const key = fingerprint(s, projectId);
    if (skippedProjects.has(s.projectId) || sessions.some(row => row.id === s.id) || known.has(key)) {
      sessionMapping[s.id] = 'skip';
    } else known.add(key);
  }
  return { mapping, sessionMapping, skippedProjects, projectOverrides };
}
