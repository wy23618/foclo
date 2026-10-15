import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptBackup, decryptBackup } from './backup-crypto.mjs';
test('encrypted backup authenticates contents and rejects damage or wrong keys', () => {
  const key = randomBytes(32), source = Buffer.from('private database sample');
  const archive = encryptBackup(source, key);
  assert.deepEqual(decryptBackup(archive, key), source);
  assert.ok(!archive.includes(source));
  const damaged = Buffer.from(archive); damaged[damaged.length - 1] ^= 1;
  assert.throws(() => decryptBackup(damaged, key), /authentication failed/);
  assert.throws(() => decryptBackup(archive, randomBytes(32)), /authentication failed/);
});
