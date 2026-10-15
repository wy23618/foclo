import { chmod, rename } from 'node:fs/promises';

export async function retainFailedPartial(cipherPath, partialPath) {
  await chmod(cipherPath, 0o600).catch(() => {});
  await rename(cipherPath, partialPath);
}
