import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { retainFailedPartial } from './backup-files.mjs';

const magic = Buffer.from('YOTICKBK1');
const root = '/var/lib/yotick-backups';
const keyPath = '/etc/yotick/backup.key';
const database = 'yotick';
const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z');
const name = `yotick-${stamp}.dump.enc`;
const finalPath = join(root, name);
const partialPath = finalPath + '.partial';
const cipherPath = join(root, `.${name}.${process.pid}.ciphertext`);

async function main() {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const keyStat = await stat(keyPath);
  if (keyStat.uid !== 0 || (keyStat.mode & 0o777) !== 0o600 || !keyStat.isFile())
    throw new Error('Backup key must be a root-owned regular file with mode 0600');
  const key = await readFile(keyPath);
  if (key.length !== 32) throw new Error('Backup key must contain exactly 32 raw bytes');

  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  key.fill(0);
  const output = createWriteStream(cipherPath, { flags: 'wx', mode: 0o600 });
  const pg = spawn('/usr/sbin/runuser', ['-u', 'postgres', '--', '/usr/bin/pg_dump', '--no-password', '--format=custom', '--dbname=' + database], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/postgresql', LANG: 'C.UTF-8' },
  });
  let errorText = '';
  pg.stderr.setEncoding('utf8');
  pg.stderr.on('data', chunk => { errorText += chunk; });
  const pipeDone = pipeline(pg.stdout, cipher, output);
  let exitCode;
  try {
    [exitCode] = await Promise.all([new Promise((resolve, reject) => {
      pg.once('error', reject);
      pg.once('close', resolve);
    }), pipeDone]);
  } catch (error) {
    pg.kill('SIGTERM');
    await pipeDone.catch(() => {});
    await retainFailedPartial(cipherPath, partialPath).catch(() => {});
    throw new Error(`pg_dump/encryption failed; incomplete .partial retained. ${error.message}`);
  }
  if (exitCode !== 0) {
    await retainFailedPartial(cipherPath, partialPath);
    throw new Error(`pg_dump exited ${exitCode}; incomplete encrypted .partial retained. ${errorText.trim()}`);
  }

  const tag = cipher.getAuthTag();
  const partial = await open(partialPath, 'wx', 0o600);
  try {
    await partial.writeFile(Buffer.concat([magic, nonce, tag]));
    await partial.sync();
    await partial.close();
    await pipeline(createReadStream(cipherPath), createWriteStream(partialPath, { flags: 'a', mode: 0o600 }));
  } catch (error) {
    await partial.close().catch(() => {});
    throw new Error(`Could not assemble encrypted archive; .partial retained. ${error.message}`);
  }
  await rename(partialPath, finalPath);
  await unlink(cipherPath);
  const archiveStat = await stat(finalPath);
  const hash = createHash('sha256');
  await pipeline(createReadStream(finalPath), hash);
  const summary = {
    capturedAt: new Date().toISOString(), archive: name, bytes: archiveStat.size,
    sha256: hash.digest('hex'),
    encryption: 'AES-256-GCM', database, pgDumpExitCode: 0,
    restoreVerified: false, retention: 'No automatic deletion',
  };
  await writeFile(finalPath + '.json', JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(summary));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
