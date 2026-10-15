import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const magic = Buffer.from('YOTICKBK1');

export function encryptBackup(contents, key, nonce = randomBytes(12)) {
  if (key.length !== 32 || nonce.length !== 12) throw new Error('Expected a 32-byte key and 12-byte nonce');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(contents), cipher.final()]);
  return Buffer.concat([magic, nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptBackup(contents, key) {
  if (key.length !== 32) throw new Error('Backup key must contain exactly 32 bytes');
  if (contents.length < magic.length + 28 || !contents.subarray(0, magic.length).equals(magic))
    throw new Error('Not a YoTick encrypted backup');
  const decipher = createDecipheriv('aes-256-gcm', key, contents.subarray(magic.length, magic.length + 12));
  decipher.setAuthTag(contents.subarray(magic.length + 12, magic.length + 28));
  try { return Buffer.concat([decipher.update(contents.subarray(magic.length + 28)), decipher.final()]); }
  catch { throw new Error('Backup authentication failed; key or archive does not match'); }
}
