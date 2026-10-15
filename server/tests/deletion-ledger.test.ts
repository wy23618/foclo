import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { recordDeletionIntent, readDeletionIntents } from "../src/deletion-ledger.js";

test("deletion intent survives retry, refuses wrong user, and missing/corrupt ledger fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yotick-ledger-"));
  try {
    await assert.rejects(readDeletionIntents(dir));
    await writeFile(join(dir, "initialized"), "YOTICK_DELETION_LEDGER_V1\n");
    assert.deepEqual(await readDeletionIntents(dir), []);
    const intent = {formatVersion: 1 as const, requestId:randomUUID(),userId:randomUUID(),approvedAt:new Date().toISOString()};
    await recordDeletionIntent(dir, intent);
    await recordDeletionIntent(dir, {...intent,approvedAt:new Date().toISOString()});
    assert.deepEqual(await readDeletionIntents(dir), [intent]);
    await assert.rejects(recordDeletionIntent(dir,{...intent,userId:randomUUID()}), /DELETION_LEDGER_CONFLICT/);
    assert.equal(JSON.parse(await readFile(join(dir,intent.requestId+".json"),"utf8")).userId,intent.userId);
    await writeFile(join(dir, randomUUID()+".json"),'{');
    await assert.rejects(readDeletionIntents(dir));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
