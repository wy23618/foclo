// Verify an extracted delivery bundle, then load its compiled app with only
// production dependencies. Health/auth checks are read-only against local PG.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !path.basename(root).startsWith('YoTick-bundle-check-') || !root.startsWith(path.resolve(process.env.TEMP) + path.sep))
  throw new Error('Extract into a dedicated TEMP/YoTick-bundle-check-* directory');
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '5433' || url.pathname !== '/yotick') throw new Error('Local database required');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
for (const item of manifest) {
  const file = path.resolve(root, item.path);
  if (!file.startsWith(root + path.sep)) throw new Error('Manifest path leaves the bundle');
  if (/(^|\/)(node_modules|tests|local-dev|data)(\/|$)|(^|\/)\.env(?!\.example$)|\.(dump|log)$/.test(item.path))
    throw new Error('Private/runtime data included in bundle: ' + item.path);
  const contents = fs.readFileSync(file);
  if (contents.length !== item.bytes || createHash('sha256').update(contents).digest('hex') !== item.sha256)
    throw new Error('Bundle hash mismatch: ' + item.path);
}
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const install = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts'], { cwd: root, encoding: 'utf8', timeout: 120000 });
if (install.status !== 0) throw new Error('Clean runtime dependency installation failed');
if (fs.existsSync(path.join(root, 'node_modules', 'tsx')) || fs.existsSync(path.join(root, 'node_modules', 'typescript')))
  throw new Error('Development dependencies installed unexpectedly');
const { loadConfig } = await import(pathToFileURL(path.join(root, 'dist/src/config.js')));
const { createPool } = await import(pathToFileURL(path.join(root, 'dist/src/db.js')));
const { buildApp } = await import(pathToFileURL(path.join(root, 'dist/src/app.js')));
const config = loadConfig({ ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1' });
const pool = createPool(config), app = buildApp(config, pool);
let evidence;
try {
  const live = await app.inject({ method: 'GET', url: '/health/live' });
  const ready = await app.inject({ method: 'GET', url: '/health/ready' });
  const protectedRoute = await app.inject({ method: 'GET', url: '/api/v1/me' });
  if (live.statusCode !== 200 || ready.statusCode !== 200 || protectedRoute.statusCode !== 401)
    throw new Error('Compiled bundle health/auth checks failed');
  evidence = { result: 'passed', capturedAt: new Date().toISOString(), filesVerified: manifest.length,
    cleanRuntimeDependencies: true, developmentDependenciesAbsent: true,
    live: live.statusCode, ready: ready.statusCode, unauthenticatedAccount: protectedRoute.statusCode,
    scope: 'Extracted Node bundle, local PostgreSQL, no Docker/TLS/public deployment' };
} finally { await app.close(); await pool.end(); }
const evidencePath = path.join(process.env.LOCALAPPDATA, 'YoTick', 'LocalServer', 'delivery-bundle-check.json');
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ...evidence, evidencePath }));
