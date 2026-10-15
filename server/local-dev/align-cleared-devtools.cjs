// Preserve the old device namespace, then login to the cleared generation.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const automator = require(path.join(process.env.LOCALAPPDATA, 'YoTick', 'AcceptanceTools', 'node_modules', 'miniprogram-automator'));
const reference = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (reference.target !== 'local' || !reference.applied || reference.suffix !== 'b520')
  throw new Error('Verified local clear receipt for b520 is required.');
let mp;
(async () => {
  mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
  const old = await mp.evaluate(async expected => {
    const app = getApp(); await app.globalData.readyPromise;
    const accounts = app.globalData.accounts, current = accounts.getCurrent();
    if (!current || current.userId !== expected.userId || current.spaceId !== expected.spaceId)
      return { skipped: true, reason: 'Different or guest device account; device storage preserved.' };
    await accounts.trigger();
    return { backup: await accounts.exportRecovery() };
  }, reference);
  if (old.skipped) { console.log(JSON.stringify(old)); return; }
  const crypto = await import('./backup-crypto.mjs'), key = crypto.loadBackupKey();
  const plaintext = Buffer.from(JSON.stringify(old.backup));
  const encrypted = crypto.encryptBackup(plaintext, key);
  const privateRoot = path.join(process.env.LOCALAPPDATA, 'YoTick', 'CloudServer');
  const backupPath = path.join(privateRoot, 'b520-devtools-before-relogin-' + randomUUID() + '.json.enc');
  const file = fs.openSync(backupPath, 'wx', 0o600);
  try { fs.writeFileSync(file, encrypted); fs.fsyncSync(file); } finally { fs.closeSync(file); }
  if (!crypto.decryptBackup(fs.readFileSync(backupPath), key).equals(plaintext)) throw new Error('Device recovery copy failed verification.');
  key.fill(0); plaintext.fill(0);
  const result = await mp.evaluate(async expected => {
    const app = getApp(), accounts = app.globalData.accounts;
    const before = accounts.getCurrent();
    if (before.userId !== expected.userId || before.spaceId !== expected.spaceId) throw new Error('Account changed.');
    await accounts.login(); // Existing canSwitch guard preserves running timers.
    await accounts.trigger();
    const current = accounts.getCurrent();
    if (current.userId !== expected.userId || current.spaceId !== expected.spaceId || current.generation !== expected.generationAfter)
      throw new Error('Relogin identity mismatch.');
    const backup = await app.globalData.service.createBackup();
    if (!backup.ok || backup.data.projects.length || backup.data.sessions.length) throw new Error('Current device space is not empty.');
    return { suffix: current.userId.slice(-4), generation: current.generation,
      projects: backup.data.projects.length, sessions: backup.data.sessions.length,
      status: accounts.getStatus().state, historicalDeviceNamespacePreserved: true };
  }, reference);
  await mp.navigateTo('/pages/account/account');
  const screenshotPath = path.join(privateRoot, 'b520-cleared-devtools-20261009.png');
  await mp.screenshot({ path: screenshotPath });
  const evidence = { ...result, backupPath, backupSha256: createHash('sha256').update(encrypted).digest('hex'), screenshotPath, capturedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(privateRoot, 'b520-cleared-devtools-20261009.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
})().catch(error => { console.error('Device alignment stopped: ' + error.message); process.exitCode = 1; })
  .finally(() => { if (mp) mp.disconnect(); });
