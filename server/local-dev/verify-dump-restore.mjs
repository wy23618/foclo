// Restore a private pg_dump archive into a NEW isolated database. Never restores
// into yotick and never drops/overwrites an existing database.
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, access, unlink } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pull } from '../dist/src/sync.js';
import { decryptBackup, loadBackupKey } from './backup-crypto.mjs';

const started = performance.now();
const privateRoot = join(process.env.LOCALAPPDATA, 'YoTick', 'LocalServer');
const backupRoot = resolve(privateRoot, 'backups');
const backup = resolve(backupRoot, process.argv[2] || 'yotick-20261008-accepted.dump');
if (dirname(backup) !== backupRoot || !/\.dump(?:\.enc)?$/.test(backup))
  throw new Error('Only private LocalServer/backups archives are accepted');
const configured = new URL(process.env.DATABASE_URL);
if (configured.hostname !== '127.0.0.1' || configured.port !== '5433' || configured.pathname !== '/yotick')
  throw new Error('Only the dedicated local YoTick cluster is accepted');
const secret = JSON.parse((await readFile(join(privateRoot, 'secrets.json'), 'utf8')).replace(/^\uFEFF/, ''));
let pgBin;
for (const candidate of [process.env.YOTICK_POSTGRES_BIN, join(process.env.ProgramFiles, 'PostgreSQL', '17', 'bin'), 'D:\\PostgreSQL\\17\\bin'].filter(Boolean)) {
  try { await access(join(candidate, 'pg_restore.exe')); pgBin = candidate; break; } catch {}
}
if (!pgBin) throw new Error('PostgreSQL 17 restore tools unavailable');
const targetName = 'yotick_restore_drill_' + randomUUID().replaceAll('-', '').slice(0, 12);
const options = { host: '127.0.0.1', port: 5433, user: 'yotick_admin', password: secret.adminPassword };
const admin = new pg.Pool({ ...options, database: 'postgres' });
let restored;
let restoreArchive = backup, decryptedTemporary = null;
function tool(name, args) {
  try {
    return execFileSync(join(pgBin, name + '.exe'), args, {
      env: { ...process.env, PGPASSWORD: secret.adminPassword },
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Restore errors can contain personal row values; do not print their output.
    throw new Error(name + ' failed; isolated target retained for private diagnosis');
  }
}
function manifest(sql) {
  const result = {};
  const blocks = /COPY public\.([a-z_]+) \(([^\n]+)\) FROM stdin;\r?\n([\s\S]*?)^\\\.\r?$/gm;
  let block;
  while ((block = blocks.exec(sql))) {
    const rows = block[3].replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    if (rows.length === 1 && rows[0] === '') rows.length = 0;
    result[block[1]] = {
      columns: block[2], count: rows.length,
      hash: createHash('sha256').update(rows.sort().join('\n')).digest('hex'),
    };
  }
  if (!result.spaces || !result.schema_migrations) throw new Error('Backup manifest has no required schema tables');
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
try {
  if (backup.endsWith('.enc')) {
    const key = loadBackupKey();
    try {
      const clear = decryptBackup(await readFile(backup), key);
      decryptedTemporary = join(backupRoot, '.restore-' + randomUUID() + '.dump');
      await writeFile(decryptedTemporary, clear, { flag: 'wx' });
      clear.fill(0);
      restoreArchive = decryptedTemporary;
    } finally { key.fill(0); }
  }
  const archiveManifest = manifest(tool('pg_restore', ['--data-only', '--no-owner', '--no-privileges', '--file=-', restoreArchive]));
  await admin.query('CREATE DATABASE ' + targetName + ' TEMPLATE template0');
  await admin.query('REVOKE CONNECT ON DATABASE ' + targetName + ' FROM PUBLIC, yotick_app, yotick_migrator');
  tool('pg_restore', ['--exit-on-error', '-h', '127.0.0.1', '-p', '5433', '-U', 'yotick_admin', '-d', targetName, restoreArchive]);
  const targetManifest = manifest(tool('pg_dump', ['--data-only', '--no-owner', '--no-privileges', '-h', '127.0.0.1', '-p', '5433', '-U', 'yotick_admin', '-d', targetName]));
  if (JSON.stringify(archiveManifest) !== JSON.stringify(targetManifest))
    throw new Error('Restored rows differ from archive; source database untouched');
  restored = new pg.Pool({ ...options, database: targetName });
  const schemaVersion = Number((await restored.query('SELECT max(version) version FROM schema_migrations')).rows[0].version);
  if (schemaVersion !== 5) throw new Error('Unexpected restored schema version');
  const spaces = (await restored.query('SELECT id,user_id,generation,restore_epoch FROM spaces')).rows;
  const cursors = [];
  for (const space of spaces) {
    const who = { userId: space.user_id, spaceId: space.id, generation: space.generation, sessionId: randomUUID() };
    const page = await pull(restored, who, { generation: space.generation }, process.env.CURSOR_SECRET);
    cursors.push({ who, cursor: page.cursor });
  }
  await restored.query('UPDATE spaces SET restore_epoch=gen_random_uuid()');
  for (const item of cursors) {
    try {
      await pull(restored, item.who, { generation: item.who.generation, cursor: item.cursor }, process.env.CURSOR_SECRET);
      throw new Error('Old cursor incorrectly survived the restore epoch change');
    } catch (error) { if (error.code !== 'CURSOR_EXPIRED') throw error; }
  }
  const evidence = {
    result: 'passed', capturedAt: new Date().toISOString(), backup: basename(backup),
    backupHash: createHash('sha256').update(await readFile(backup)).digest('hex'),
    isolatedDatabase: targetName, schemaVersion, tables: archiveManifest,
    oldCursorsRejected: cursors.length, elapsedMs: Math.round(performance.now() - started),
    sourceRestoredOrModified: false,
  };
  const evidencePath = join(privateRoot, targetName + '.json');
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(JSON.stringify({ result: evidence.result, database: targetName, tableCount: Object.keys(archiveManifest).length,
    rowCounts: Object.fromEntries(Object.entries(archiveManifest).map(([k, v]) => [k, v.count])),
    oldCursorsRejected: evidence.oldCursorsRejected, elapsedMs: evidence.elapsedMs, evidencePath }));
} finally {
  if (restored) await restored.end();
  await admin.end();
  if (decryptedTemporary) await unlink(decryptedTemporary);
}
