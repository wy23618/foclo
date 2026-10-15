import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const magic = Buffer.from('YOTICKBK1');
export function loadBackupKey() {
  let encoded = process.env.BACKUP_ENCRYPTION_KEY;
  if (!encoded) {
    if (process.platform !== 'win32') throw new Error('Configure a protected BACKUP_ENCRYPTION_KEY');
    try {
      encoded = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./protected-backup-key.ps1', import.meta.url))],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
          env: { ...process.env, PSModulePath: join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') } }).trim();
    } catch { throw new Error('Protected backup key unavailable for this Windows account'); }
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('Backup encryption key must be a 32-byte base64 secret');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Backup encryption key is invalid');
  return key;
}
export function encryptBackup(contents, key) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(contents), cipher.final()]);
  return Buffer.concat([magic, nonce, cipher.getAuthTag(), ciphertext]);
}
export function decryptBackup(contents, key) {
  if (contents.length < magic.length + 28 || !contents.subarray(0, magic.length).equals(magic))
    throw new Error('Not a YoTick encrypted backup');
  const decipher = createDecipheriv('aes-256-gcm', key, contents.subarray(magic.length, magic.length + 12));
  decipher.setAuthTag(contents.subarray(magic.length + 12, magic.length + 28));
  try { return Buffer.concat([decipher.update(contents.subarray(magic.length + 28)), decipher.final()]); }
  catch { throw new Error('Backup authentication failed; key or archive does not match'); }
}
