const { createAccountAdapter } = require('../storage/account-adapter');

const fingerprint = (s, projectId) => JSON.stringify([
  projectId, s.startedAtSec, s.endedAtSec, s.durationSeconds, s.targetSeconds ?? null,
  (s.pauses || []).map(p => [p.startedAtSec, p.endedAtSec, p.durationSeconds]).sort(),
]);

// Compare locally with the latest account facts; never upload guest contents
// before the user agrees. Deletion markers remain authoritative.
async function pendingGuest(raw, account) {
  const guest = createAccountAdapter(raw, 'guest');
  const source = Object.values((await guest.get('yotick/projects')) || {});
  const projects = Object.values((await account.get('yotick/projects')) || {});
  const mapping = {}, skipped = new Set(), done = new Set();
  let projectCount = 0, sessionCount = 0, remaining = source.slice();
  while (remaining.length) {
    const ready = remaining.filter(p => !p.parentId || done.has(p.parentId));
    if (!ready.length) return null; // Invalid hierarchy must not hide data.
    for (const p of ready) {
      const shadow = await account.get('yotick/shadow/project/' + p.id);
      const same = projects.find(row => row.id === p.id);
      if (skipped.has(p.parentId) || shadow?.deleted) skipped.add(p.id);
      else if (same) mapping[p.id] = p.id;
      else {
        const parentId = mapping[p.parentId] || p.parentId || null;
        const named = projects.find(row => row.name === p.name && (row.parentId || null) === parentId);
        if (named) mapping[p.id] = named.id;
        else { projectCount++; projects.push({ ...p, parentId }); }
      }
      done.add(p.id);
    }
    remaining = remaining.filter(p => !done.has(p.id));
  }
  const knownIds = new Set(), knownFacts = new Set();
  for (const key of await account.keys()) {
    if (!key.startsWith('yotick/shadow/session/') && !key.startsWith('yotick/s/')) continue;
    const value = await account.get(key);
    if (!value) continue;
    const s = key.startsWith('yotick/shadow/') ? value.data : value;
    knownIds.add(value.entityId || s?.id);
    if (s) knownFacts.add(fingerprint(s, s.projectId));
  }
  for (const key of await guest.keys()) {
    if (!key.startsWith('yotick/s/')) continue;
    const s = await guest.get(key);
    if (!s || s.status !== 'COMPLETED' || skipped.has(s.projectId)) continue;
    const fact = fingerprint(s, mapping[s.projectId] || s.projectId);
    if (knownIds.has(s.id) || knownFacts.has(fact)) continue;
    sessionCount++; knownIds.add(s.id); knownFacts.add(fact);
  }
  return { projectCount, sessionCount, hasData: projectCount > 0 || sessionCount > 0 };
}
module.exports = { pendingGuest };
