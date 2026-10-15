// Independent, administrator-only intent records must survive DB backup rollback.
// Intent is durable before purge; failures leave an approved deletion to retry.
import { open, mkdir, readFile, readdir, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { uuid, requireValue } from "./protocol.js";
export type DeletionIntent = { formatVersion: 1; requestId: string; userId: string; approvedAt: string };
async function ledgerRoot(directory: string) {
  requireValue(directory && resolve(directory) === directory, "DELETION_LEDGER_PATH_REQUIRED");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  requireValue(info.isDirectory(), "DELETION_LEDGER_NOT_PROTECTED");
  if (process.platform !== "win32")
    requireValue(info.uid === process.getuid?.() && (info.mode & 0o777) === 0o700, "DELETION_LEDGER_NOT_PROTECTED");
  return directory;
}
function validate(value: unknown): asserts value is DeletionIntent {
  const v = value as DeletionIntent;
  requireValue(v?.formatVersion === 1 && uuid(v.requestId) && uuid(v.userId) && typeof v.approvedAt === "string" && Number.isFinite(Date.parse(v.approvedAt)), "DELETION_LEDGER_INVALID");
}
async function protectedRecord(path: string) {
  const info = await lstat(path);
  requireValue(info.isFile(), "DELETION_LEDGER_NOT_PROTECTED");
  if (process.platform !== "win32")
    requireValue(info.uid === process.getuid?.() && (info.mode & 0o777) === 0o600, "DELETION_LEDGER_NOT_PROTECTED");
}
async function syncDirectory(directory: string) {
  // Linux directory fsync seals the newly-created name; Windows uses protected NTFS.
  if (process.platform !== "win32") {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
export async function recordDeletionIntent(directory: string, value: DeletionIntent) {
  validate(value); const root = await ledgerRoot(directory), path = join(root, value.requestId + ".json");
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await protectedRecord(path);
    const previous: unknown = JSON.parse(await readFile(path, "utf8")); validate(previous);
    requireValue(previous.requestId === value.requestId && previous.userId === value.userId, "DELETION_LEDGER_CONFLICT");
    const existing = await open(path, "r+");
    try { await existing.sync(); } finally { await existing.close(); }
    await syncDirectory(root);
    return previous;
  }
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(root); return value;
}
export async function readDeletionIntents(directory: string) {
  const root = await ledgerRoot(directory), result: DeletionIntent[] = [];
  // Require an explicit initialization marker; missing/lost ledger is never empty success.
  requireValue((await readFile(join(root, "initialized"), "utf8")).trim() === "YOTICK_DELETION_LEDGER_V1", "DELETION_LEDGER_NOT_INITIALIZED");
  for (const name of (await readdir(root)).sort()) {
    if (name === "initialized") continue;
    requireValue(/^[a-f0-9-]{36}\.json$/i.test(name), "DELETION_LEDGER_INVALID");
    await protectedRecord(join(root, name));
    const value: unknown = JSON.parse(await readFile(join(root, name), "utf8")); validate(value);
    requireValue(name === value.requestId + ".json", "DELETION_LEDGER_INVALID"); result.push(value);
  }
  return result;
}
