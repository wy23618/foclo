import { readFile, writeFile } from 'node:fs/promises';
import { decryptBackup } from './backup-crypto.mjs';

const [source, destination] = process.argv.slice(2);
if (!source || !destination || process.argv.length !== 4) {
  console.error('Usage: sudo node decrypt-backup.mjs ARCHIVE.dump.enc NEW-ISOLATED.dump');
  process.exit(2);
}
const key = await readFile('/etc/yotick/backup.key');
if (key.length !== 32) throw new Error('Backup key must contain exactly 32 raw bytes');
try {
  const clear = decryptBackup(await readFile(source), key);
  await writeFile(destination, clear, { flag: 'wx', mode: 0o600 });
} finally { key.fill(0); }
console.log(`Decrypted archive written with mode 0600: ${destination}`);
