// Full private local backup. Never deletes older archives or reads app secrets
// into command arguments. Incomplete files retain .partial for diagnosis.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { encryptBackup, loadBackupKey } from './backup-crypto.mjs';
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '5433' || url.pathname !== '/yotick')
  throw new Error('Only the dedicated local YoTick database is accepted');
const privateRoot = join(process.env.LOCALAPPDATA, 'YoTick', 'LocalServer');
const backupRoot = join(privateRoot, 'backups');
const secrets = JSON.parse((await readFile(join(privateRoot, 'secrets.json'), 'utf8')).replace(/^\uFEFF/, ''));
let pgBin;
for (const candidate of [process.env.YOTICK_POSTGRES_BIN, join(process.env.ProgramFiles, 'PostgreSQL', '17', 'bin'), 'D:\\PostgreSQL\\17\\bin'].filter(Boolean)) {
  try { await access(join(candidate, 'pg_dump.exe')); pgBin = candidate; break; } catch {}
}
if (!pgBin) throw new Error('PostgreSQL 17 backup tools unavailable');
await mkdir(backupRoot, { recursive: true });
const basename = 'yotick-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') + '-' + randomUUID().slice(0, 8) + '.dump.enc';
const archive = join(backupRoot, basename), partial = archive + '.partial';
const env = { ...process.env, PGPASSWORD: secrets.adminPassword };
let contents;
try {
  execFileSync(join(pgBin, 'pg_dump.exe'), ['-h', '127.0.0.1', '-p', '5433', '-U', 'yotick_admin', '-d', 'yotick', '--format=custom', '--file=' + partial],
    { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  contents = execFileSync(join(pgBin, 'pg_restore.exe'), ['--list', partial], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
} catch { throw new Error('Backup/list verification failed; inspect the private .partial archive'); }
if (!contents.includes('schema_migrations') || !contents.includes('sync_operations') || !contents.includes('study_sessions'))
  throw new Error('Required tables absent; partial archive retained');
const key = loadBackupKey();
try { await writeFile(archive + '.encrypting', encryptBackup(await readFile(partial), key), { flag: 'wx' }); }
finally { key.fill(0); }
await rename(archive + '.encrypting', archive);
await unlink(partial); // Only this invocation's generated plaintext intermediate.
const evidence = { capturedAt: new Date().toISOString(), archive: basename, bytes: (await stat(archive)).size,
  sha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
  archiveReadable: true, encryption: 'AES-256-GCM', keyProtection: process.env.BACKUP_ENCRYPTION_KEY ? 'protected environment' : 'Windows current-user DPAPI',
  fullRestoreVerified: false, retention: 'Older files retained; no automatic deletion' };
await writeFile(archive + '.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ...evidence, privateDirectory: backupRoot }));
