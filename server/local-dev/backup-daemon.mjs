// Local server companion. Current-user process, no Windows scheduler/login.
// One daily backup, catch-up on startup; errors retain data and retry later.
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(process.env.LOCALAPPDATA, 'YoTick', 'LocalServer');
const statePath = join(root, 'backup-maintenance.json');
const log = join(root, 'backup-maintenance.log');
let running = false;
function localDay() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
async function tick(catchUp = false) {
  if (running) return;
  running = true;
  try {
    let state = {};
    try { state = JSON.parse((await readFile(statePath, 'utf8')).replace(/^\uFEFF/, '')); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('Backup maintenance state unreadable'); }
    if (state.lastSuccessfulDay === localDay()) return;
    const hour = new Date(Date.now() + 8 * 3600000).getUTCHours();
    if (!catchUp && hour < 20) return;
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./backup.mjs', import.meta.url))], {
        env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', () => {}); // No credentials in diagnostics.
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error('Encrypted backup command failed')));
    });
    const next = { lastSuccessfulDay: localDay(), completedAt: new Date().toISOString(), archive: outcome.archive, encryption: outcome.encryption };
    await writeFile(statePath + '.tmp', JSON.stringify(next, null, 2));
    await rename(statePath + '.tmp', statePath);
    await appendFile(log, JSON.stringify({ ...next, status: 'ok' }) + '\n');
  } catch (error) {
    await appendFile(log, JSON.stringify({ at: new Date().toISOString(), status: 'failed', message: error.message }) + '\n');
  } finally { running = false; }
}
await tick(true);
setInterval(() => { void tick(); }, 5 * 60000);
