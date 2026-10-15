import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptBackup, encryptBackup } from './backup-crypto.mjs';
import { retainFailedPartial } from './backup-files.mjs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('AES-256-GCM backup format decrypts and rejects tampering and wrong keys', () => {
  const key = randomBytes(32), source = Buffer.from('isolated database sample');
  const encrypted = encryptBackup(source, key);
  assert.equal(encrypted.subarray(0, 9).toString(), 'YOTICKBK1');
  assert.deepEqual(decryptBackup(encrypted, key), source);
  assert.ok(!encrypted.includes(source));
  const damaged = Buffer.from(encrypted); damaged[damaged.length - 1] ^= 1;
  assert.throws(() => decryptBackup(damaged, key), /authentication failed/);
  assert.throws(() => decryptBackup(encrypted, randomBytes(32)), /authentication failed/);
  assert.throws(() => decryptBackup(Buffer.from('bad'), key), /Not a YoTick/);
});

test('failed dump leaves a non-success .partial artifact, never a final archive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yotick-backup-failure-'));
  try {
    const ciphertext = join(dir, '.ciphertext'), partial = join(dir, 'backup.dump.enc.partial');
    await writeFile(ciphertext, Buffer.from('incomplete ciphertext'));
    await retainFailedPartial(ciphertext, partial);
    assert.deepEqual(await readFile(partial), Buffer.from('incomplete ciphertext'));
    assert.deepEqual(await readdir(dir), ['backup.dump.enc.partial']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
