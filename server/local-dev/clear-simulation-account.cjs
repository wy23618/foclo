// Account-scoped maintenance for explicitly disposable samples. No SQL purge,
// token logging, identity deletion, or device-storage deletion.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createService } = require('../../core/service');
const { createMemoryAdapter } = require('../../storage/adapter');
const automator = require(path.join(process.env.LOCALAPPDATA, 'YoTick', 'AcceptanceTools', 'node_modules', 'miniprogram-automator'));
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const suffix = args.includes('--suffix') && option('--suffix');
const target = args.includes('--target') ? option('--target') : 'cloud';
if (!/^[0-9a-f]{4}$/.test(suffix || '') || !['cloud', 'local'].includes(target))
  throw new Error('Supply an exact four-character account suffix and cloud/local target.');
const apply = args.includes('--apply');
const base = target === 'cloud' ? 'https://121.199.74.171/api/v1' : 'http://127.0.0.1:3000/api/v1';
const privateRoot = path.join(process.env.LOCALAPPDATA, 'YoTick', 'CloudServer');
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const prefix = path.join(privateRoot, `clear-${target}-${suffix}-${runId}`);
let mp, accessToken;
function writeDurable(file, data) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}
async function api(method, route, body, authenticated = true) {
  const response = await fetch(base + route, {
    method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer ' + accessToken } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return null;
  const value = await response.json();
  if (!response.ok) {
    const code = String(value?.error?.code || 'UNKNOWN').replace(/[^A-Z0-9_]/g, '').slice(0, 60);
    throw new Error('API rejected maintenance: HTTP ' + response.status + ' ' + code);
  }
  return value;
}
async function exportSnapshot(ref) {
  const job = await api('POST', '/exports', { generation: ref.generation });
  const items = [];
  let offset = 0, cursor;
  for (let pages = 0; pages < 10000; pages++) {
    const page = await api('GET', '/exports/' + job.id + '?offset=' + offset);
    if (page.generation !== ref.generation || page.upperSeq !== job.upperSeq || !Array.isArray(page.changes))
      throw new Error('Snapshot identity or boundary changed.');
    items.push(...page.changes);
    if (!page.hasMore) { cursor = page.cursor; break; }
    if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('Invalid snapshot offset.');
    offset = page.nextOffset;
  }
  if (!cursor) throw new Error('Snapshot export is incomplete.');
  return { formatVersion: 2, spaceId: ref.spaceId, generation: ref.generation, upperSeq: job.upperSeq, items, cursor };
}
function counts(items) {
  const result = { projects: 0, sessions: 0, prefs: 0, tombstones: 0 };
  for (const item of items) {
    if (item.deleted) result.tombstones++;
    else if (item.entityType === 'project') result.projects++;
    else if (item.entityType === 'session') result.sessions++;
    else if (item.entityType === 'prefs') result.prefs++;
  }
  return result;
}
(async () => {
  fs.mkdirSync(privateRoot, { recursive: true });
  mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
  const login = await mp.evaluate(async () => {
    const info = wx.getAccountInfoSync();
    if (info?.miniProgram?.appId !== 'wx6ed8386f53a1801b') throw new Error('Wrong mini-program.');
    const result = await new Promise((resolve, reject) => wx.login({ success: resolve, fail: reject, timeout: 10000 }));
    if (!result.code) throw new Error('WeChat did not provide login code.');
    return { code: result.code };
  });
  const tokens = await api('POST', '/auth/wechat-mini', { code: login.code, deviceId: randomUUID() }, false);
  login.code = null;
  accessToken = tokens.accessToken;
  tokens.refreshToken = null;
  const ref = await api('GET', '/me');
  if (!ref.userId?.endsWith(suffix)) throw new Error('Authenticated account suffix does not match; nothing cleared.');
  if (args.includes('--reference')) {
    const reference = JSON.parse(fs.readFileSync(option('--reference'), 'utf8'));
    if (reference.userId !== ref.userId || reference.spaceId !== ref.spaceId)
      throw new Error('Local identity differs from cloud identity; nothing cleared.');
  }
  const snapshot = await exportSnapshot(ref), before = counts(snapshot.items);
  const localBackup = {
    formatVersion: 1, exportedAtSec: Math.floor(Date.now() / 1000), spaceId: ref.spaceId,
    meta: { schemaVersion: 1, utcOffsetMinutes: 480 },
    projects: snapshot.items.filter(item => item.entityType === 'project' && !item.deleted).map(item => item.data),
    sessions: snapshot.items.filter(item => item.entityType === 'session' && !item.deleted).map(item => item.data),
    prefs: snapshot.items.find(item => item.entityType === 'prefs' && !item.deleted)?.data || {},
  };
  const validator = createService(createMemoryAdapter());
  await validator.init();
  const preview = await validator.previewBackup(localBackup);
  if (!preview.ok) throw new Error('Recovery backup validation failed; nothing cleared.');
  const crypto = await import('./backup-crypto.mjs');
  const key = crypto.loadBackupKey();
  const plaintext = Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), account: ref, accountExport: snapshot, localBackup }));
  const archive = crypto.encryptBackup(plaintext, key);
  const archivePath = prefix + '.json.enc';
  writeDurable(archivePath, archive);
  if (!crypto.decryptBackup(fs.readFileSync(archivePath), key).equals(plaintext))
    throw new Error('Saved recovery backup failed verification; nothing cleared.');
  key.fill(0); plaintext.fill(0);
  const evidence = { target, userId: ref.userId, spaceId: ref.spaceId, suffix, before,
    generationBefore: ref.generation, archivePath,
    archiveSha256: createHash('sha256').update(archive).digest('hex'),
    backupVerified: true, backupImportValidated: true, applied: false, capturedAt: new Date().toISOString() };
  if (apply) {
    const head = await api('GET', '/sync/pull?generation=' + encodeURIComponent(ref.generation) + '&cursor=' + encodeURIComponent(snapshot.cursor));
    if (head.hasMore || head.changes.length) throw new Error('Account changed after backup; nothing cleared.');
    const request = { generation: ref.generation, operationId: randomUUID(), confirmation: 'DELETE_ALL_ACCOUNT_DATA' };
    writeDurable(prefix + '.request.json', JSON.stringify({ account: ref, target, request, archivePath }));
    let result;
    try { result = await api('POST', '/data/clear', request); }
    catch (error) {
      // The same operation is safe to replay after an ambiguous network failure.
      if (/^API rejected/.test(error.message)) throw error;
      result = await api('POST', '/data/clear', request);
    }
    if (!result.committed || result.generation !== (BigInt(ref.generation) + 1n).toString())
      throw new Error('Unexpected clear receipt; retained request must be inspected before retrying.');
    const afterRef = await api('GET', '/me');
    if (afterRef.userId !== ref.userId || afterRef.spaceId !== ref.spaceId || afterRef.generation !== result.generation)
      throw new Error('Post-clear identity verification failed.');
    const after = counts((await exportSnapshot(afterRef)).items);
    if (after.projects || after.sessions || after.prefs) throw new Error('Post-clear space is not empty.');
    const oldGeneration = await fetch(base + '/sync/pull?generation=' + encodeURIComponent(ref.generation), {
      headers: { authorization: 'Bearer ' + accessToken }, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    const rejected = await oldGeneration.json();
    if (rejected?.error?.code !== 'GENERATION_MISMATCH') throw new Error('Old generation was not rejected.');
    Object.assign(evidence, { applied: true, after, generationAfter: result.generation, oldGenerationRejected: true, identityPreserved: true, operationId: request.operationId });
  }
  const evidencePath = prefix + '.receipt.json';
  writeDurable(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, userId: undefined, spaceId: undefined, evidencePath }, null, 2));
})().catch(error => {
  // No credentials or private record values appear in output.
  console.error('Account maintenance stopped: ' + String(error.message).replace(/https?:\/\/\S+/g, '[address]').slice(0, 200));
  process.exitCode = 1;
}).finally(async () => {
  if (accessToken) { try { await api('POST', '/auth/logout', {}); } catch {} accessToken = null; }
  if (mp) mp.disconnect();
});
