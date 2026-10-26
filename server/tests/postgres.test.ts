import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { testPostgres } from "./native-postgres.js";
import pg from "pg";
import {
  push,
  pull,
  snapshot,
  readSnapshot,
  clear,
  type Identity,
} from "../src/sync.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { hashOpaqueToken } from "../src/auth.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logicalBackup, restoreEmptyDatabase } from "../src/backup.js";
import { fulfillAccountDeletion, reconcileDeletionLedger } from "../src/account-deletion.js";
import { readDeletionIntents } from "../src/deletion-ledger.js";
import { applyMigrations } from "../src/migration-runner.js";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const secret = "cursor-test-secret-at-least-32-characters";
let cluster: Awaited<ReturnType<typeof testPostgres>>,
  pool: pg.Pool,
  who: Identity;
let app: any;
const device = randomUUID();
test("approved deletion survives rollback and older backup restore without deleting another account", async () => {
  const ledger = await mkdtemp(join(tmpdir(), "yotick-ledger-pg-"));
  await writeFile(join(ledger,"initialized"),"YOTICK_DELETION_LEDGER_V1\n");
  const userId=randomUUID(),spaceId=randomUUID(),requestId=randomUUID();
  await pool.query("INSERT INTO users(id) VALUES($1)",[userId]);
  await pool.query("INSERT INTO spaces(id,user_id) VALUES($1,$2)",[spaceId,userId]);
  await pool.query("INSERT INTO auth_identities(provider,app_id,subject,user_id) VALUES('wechat-mini','test-app',$1,$2)",[randomUUID(),userId]);
  const oldBackup=JSON.parse(JSON.stringify(await logicalBackup(pool)));
  await pool.query("INSERT INTO account_deletion_requests(id,user_id) VALUES($1,$2)",[requestId,userId]);
  await pool.query("CREATE FUNCTION reject_sample_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='"+userId+"'::uuid THEN RAISE EXCEPTION 'injected deletion failure'; END IF; RETURN OLD; END $$; CREATE TRIGGER reject_sample_deletion BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION reject_sample_deletion();");
  await assert.rejects(fulfillAccountDeletion(pool,requestId,"PURGE_REQUESTED_ACCOUNT",ledger),/injected deletion failure/);
  assert.equal((await readDeletionIntents(ledger)).length,1);
  assert.equal((await pool.query("SELECT count(*) FROM users WHERE id=$1",[userId])).rows[0].count,"1");
  await pool.query("DROP TRIGGER reject_sample_deletion ON users; DROP FUNCTION reject_sample_deletion()");
  await fulfillAccountDeletion(pool,requestId,"PURGE_REQUESTED_ACCOUNT",ledger);
  await assert.rejects(reconcileDeletionLedger(pool,ledger),/ISOLATED_RESTORE_REQUIRED/);
  const database="yotick_restore_ledger_"+randomUUID().replaceAll("-","").slice(0,12);
  await pool.query("CREATE DATABASE "+database);
  const restored=new pg.Pool({host:"127.0.0.1",port:55439,user:"postgres",password:"test-only-password",database});
  try {
    for(const file of ["001_initial.sql","002_auth.sql","003_deletion_requests.sql","004_device_sessions.sql","005_client_privileges.sql"])
      await restored.query(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));
    await restoreEmptyDatabase(restored,oldBackup);
    assert.equal((await restored.query("SELECT count(*) FROM users WHERE id=$1",[userId])).rows[0].count,"1");
    assert.equal((await reconcileDeletionLedger(restored,ledger)).purged,1);
    assert.equal((await reconcileDeletionLedger(restored,ledger)).purged,0);
    for(const table of ["users","auth_identities","account_deletion_requests"])
      assert.equal((await restored.query("SELECT count(*) FROM "+table+" WHERE "+(table==="users"?"id":"user_id")+"=$1",[userId])).rows[0].count,"0");
    assert.equal((await restored.query("SELECT count(*) FROM users WHERE id=$1",[who.userId])).rows[0].count,"1");
  } finally {await restored.end();await rm(ledger,{recursive:true,force:true});}
});
before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "yotick-pg-"));
  cluster = await testPostgres(dir, 55439);
  await cluster.initialise();
  await cluster.start();
  pool = new pg.Pool({
    host: "127.0.0.1",
    port: 55439,
    user: "postgres",
    password: "test-only-password",
    database: "postgres",
    max: 8,
  });
  for (const f of [
    "001_initial.sql",
    "002_auth.sql",
    "003_deletion_requests.sql",
    "004_device_sessions.sql",
    "005_client_privileges.sql",
    "006_focus_presence.sql",
  ])
    await pool.query(
      await readFile(new URL("../migrations/" + f, import.meta.url), "utf8"),
    );
  who = {
    userId: randomUUID(),
    spaceId: randomUUID(),
    generation: "1",
    sessionId: randomUUID(),
  };
  await pool.query("INSERT INTO users(id) VALUES($1)", [who.userId]);
  await pool.query("INSERT INTO spaces(id,user_id) VALUES($1,$2)", [
    who.spaceId,
    who.userId,
  ]);
  app = buildApp(
    loadConfig({
      NODE_ENV: "test",
      DATABASE_URL:
        "postgres://postgres:test-only-password@127.0.0.1:55439/postgres",
      MIGRATION_DATABASE_URL:
        "postgres://postgres:test-only-password@127.0.0.1:55439/postgres",
      WECHAT_APP_ID: "test-app",
      WECHAT_APP_SECRET: "test-provider-secret",
      TOKEN_PEPPER: "token-test-pepper-at-least-32-characters",
      CURSOR_SECRET: secret,
      DATABASE_SSL: "false",
    }),
    pool,
  );
});
after(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (cluster) await cluster.stop();
});
function project(name: string, parentId: string | null = null) {
  return {
    id: randomUUID(),
    name,
    parentId,
    archived: false,
    color: "#123456",
    shortName: "",
    creationOrder: 1,
    createdAtSec: 1800000000,
    updatedAtSec: 1800000000,
  };
}
function body(ops: any[], identity = who) {
  return {
    protocolVersion: 1,
    spaceId: identity.spaceId,
    generation: identity.generation,
    deviceId: device,
    operations: ops,
  };
}
const create = (p: any) => ({
  operationId: randomUUID(),
  kind: "project.create",
  entityId: p.id,
  payload: p,
});

test("deployment migrations serialize concurrent runners and runtime role cannot administer the schema", async () => {
  const database = "migration_" + randomUUID().replaceAll("-", "");
  await pool.query("CREATE DATABASE " + database);
  const target = new pg.Pool({
    host: "127.0.0.1",
    port: 55439,
    user: "postgres",
    password: "test-only-password",
    database,
    max: 3,
  });
  try {
    const directory = fileURLToPath(new URL("../migrations", import.meta.url));
    const applied = await Promise.all([
      applyMigrations(target, directory),
      applyMigrations(target, directory),
    ]);
    assert.deepEqual(applied.flat().sort(), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(await applyMigrations(target, directory), []);
    const cli = await promisify(execFile)(
      process.execPath,
      ["dist/src/migrate.js"],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_SSL: "false",
          DATABASE_CA: "",
          DATABASE_URL:
            "postgres://postgres:test-only-password@127.0.0.1:55439/" +
            database,
          MIGRATION_DATABASE_URL:
            "postgres://postgres:test-only-password@127.0.0.1:55439/" +
            database,
          WECHAT_APP_ID: "test-only-app",
          WECHAT_APP_SECRET: "test-only-placeholder",
          TOKEN_PEPPER: "t".repeat(48),
          CURSOR_SECRET: "c".repeat(48),
        },
        windowsHide: true,
      },
    );
    assert.equal(cli.stdout, "");
    const broken = await mkdtemp(join(tmpdir(), "yotick-bad-migration-"));
    await writeFile(
      join(broken, "999_failure.sql"),
      "BEGIN; CREATE TABLE migration_failure(id integer); SELECT deliberately_missing_column; COMMIT;",
    );
    await assert.rejects(
      () => applyMigrations(target, broken),
      /does not exist/,
    );
    assert.equal(
      (await target.query("SELECT to_regclass('migration_failure') AS name"))
        .rows[0].name,
      null,
    );
    assert.deepEqual(await applyMigrations(target, directory), []);
    assert.equal(
      (await target.query("SELECT count(*) FROM schema_migrations")).rows[0]
        .count,
      "6",
    );
    await target.query(
      "CREATE ROLE yotick_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    );
    await target.query("CREATE ROLE yotick_anonymous NOLOGIN");
    await target.query(
      await readFile(
        new URL("../deploy/permissions.sql", import.meta.url),
        "utf8",
      ),
    );
    const db = await target.connect();
    try {
      await db.query("SET ROLE yotick_app");
      assert.equal(
        (
          await db.query(
            "SELECT max(version) AS version FROM schema_migrations",
          )
        ).rows[0].version,
        6,
      );
      const id = randomUUID();
      await db.query("INSERT INTO users(id) VALUES($1)", [id]);
      assert.equal(
        (await db.query("SELECT id FROM users WHERE id=$1", [id])).rows[0].id,
        id,
      );
      await assert.rejects(
        () => db.query("DELETE FROM schema_migrations"),
        /permission denied/,
      );
      await assert.rejects(
        () => db.query("CREATE TABLE public.forbidden_table(id integer)"),
        /permission denied/,
      );
      await assert.rejects(() => db.query("DROP TABLE users"), /must be owner/);
      await db.query("RESET ROLE");
      await db.query("SET ROLE yotick_anonymous");
      await assert.rejects(
        () => db.query("SELECT * FROM users"),
        /permission denied/,
      );
      await db.query("RESET ROLE");
    } finally {
      db.release();
    }
  } finally {
    await target.end();
  }
});

test("large subtree deletion bounds acknowledgement and preserves every durable change", async () => {
  const identity = {
    ...who,
    userId: randomUUID(),
    spaceId: randomUUID(),
    generation: "1",
  };
  await pool.query("INSERT INTO users(id) VALUES($1)", [identity.userId]);
  await pool.query("INSERT INTO spaces(id,user_id) VALUES($1,$2)", [
    identity.spaceId,
    identity.userId,
  ]);
  const p = project("大量暂停资料");
  await push(pool, identity, body([create(p)], identity));
  for (let n = 0; n < 6; n++) {
    const id = randomUUID(),
      started = 1800000000 + n * 2000;
    const pauses = Array.from({ length: 500 }, (_, i) => ({
      id: randomUUID(),
      sessionId: id,
      status: "COMPLETED",
      startedAtSec: started + 2 * i,
      endedAtSec: started + 2 * i + 1,
      durationSeconds: 1,
      createdAtSec: started + 2 * i,
    }));
    const payload = {
      id,
      projectId: p.id,
      status: "COMPLETED",
      startedAtSec: started,
      endedAtSec: started + 1500,
      durationSeconds: 1000,
      targetSeconds: 1500,
      createdAtSec: started,
      updatedAtSec: started + 1500,
      pauses,
    };
    const result = await push(
      pool,
      identity,
      body(
        [
          {
            operationId: randomUUID(),
            kind: "session.createCompleted",
            entityId: id,
            payload,
          },
        ],
        identity,
      ),
    );
    assert.equal(result.results[0].status, "applied");
  }
  const before = await pull(pool, identity, { generation: "1" }, secret);
  let cursor = before.cursor,
    more = before.hasMore;
  while (more) {
    const page = await pull(
      pool,
      identity,
      { generation: "1", cursor },
      secret,
    );
    cursor = page.cursor;
    more = page.hasMore;
  }
  const operation = {
    operationId: randomUUID(),
    kind: "project.deleteSubtree",
    entityId: p.id,
    baseServerVersion: "1",
    payload: { expectedVersions: { [p.id]: "1" } },
  };
  const deleted = await push(pool, identity, body([operation], identity));
  assert.equal(deleted.results[0].hasMoreChanges, true);
  assert.ok(Buffer.byteLength(JSON.stringify(deleted)) < 240 * 1024);
  assert.deepEqual(
    deleted.results,
    (await push(pool, identity, body([operation], identity))).results,
  );
  const changes: any[] = [];
  do {
    const page = await pull(
      pool,
      identity,
      { generation: "1", cursor },
      secret,
    );
    changes.push(...page.changes);
    cursor = page.cursor;
    more = page.hasMore;
  } while (more);
  assert.equal(changes.length, 7);
  assert.equal(
    changes.every((c) => c.deleted),
    true,
  );
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM pauses WHERE space_id=$1", [
        identity.spaceId,
      ])
    ).rows[0].count,
    "3000",
  );
});
async function tokens(identity = who) {
  const access = randomBytes(32).toString("base64url"),
    refresh = randomBytes(32).toString("base64url"),
    id = randomUUID();
  await pool.query(
    "INSERT INTO auth_sessions(id,user_id,space_id,family_id,access_token_hash,refresh_token_hash,access_expires_at,refresh_expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '15 minutes',now()+interval '30 days')",
    [
      id,
      identity.userId,
      identity.spaceId,
      randomUUID(),
      hashOpaqueToken(access, "token-test-pepper-at-least-32-characters"),
      hashOpaqueToken(refresh, "token-test-pepper-at-least-32-characters"),
    ],
  );
  return {
    access,
    refresh,
    id,
    headers: { authorization: "Bearer " + access },
  };
}
test('focus presence detects another device, isolates accounts and ignores stale stops', async () => {
  const identity={...who,userId:randomUUID(),spaceId:randomUUID(),generation:'1'};
  await pool.query('INSERT INTO users(id) VALUES($1)',[identity.userId]);
  await pool.query('INSERT INTO spaces(id,user_id) VALUES($1,$2)',[identity.spaceId,identity.userId]);
  const auth=await tokens(identity),a=randomUUID(),b=randomUUID(),s1=randomUUID(),s2=randomUUID();
  const call=(payload:any)=>app.inject({method:'POST',url:'/api/v1/focus/presence',headers:auth.headers,payload:{generation:'1',...payload}});
  assert.equal((await call({deviceId:a,state:'active',sessionId:s1,startedAtSec:1800000000})).statusCode,200);
  assert.equal((await call({deviceId:a,state:'check'})).json().otherDevices.length,0);
  assert.equal((await call({deviceId:b,state:'check'})).json().otherDevices.length,1);
  const outsider=await tokens();
  assert.equal((await app.inject({method:'POST',url:'/api/v1/focus/presence',headers:outsider.headers,payload:{generation:'1',deviceId:b,state:'check'}})).json().otherDevices.length,0);
  await call({deviceId:a,state:'active',sessionId:s2,startedAtSec:1800000100});
  await call({deviceId:a,state:'stopped',sessionId:s1});
  assert.equal((await call({deviceId:b,state:'check'})).json().otherDevices.length,1);
  await call({deviceId:a,state:'stopped',sessionId:s2});
  assert.equal((await call({deviceId:b,state:'check'})).json().otherDevices.length,0);
  await call({deviceId:a,state:'active',sessionId:s1,startedAtSec:1800000000});
  await pool.query("UPDATE focus_presence SET expires_at=now()-interval '1 second' WHERE space_id=$1",[identity.spaceId]);
  assert.equal((await call({deviceId:b,state:'check'})).json().otherDevices.length,0);
  assert.equal((await call({deviceId:b,state:'check',generation:'2'})).json().error.code,'GENERATION_MISMATCH');
});

test("PostgreSQL idempotency, changed operation digest, CAS and tombstone", async () => {
  const p = project("幂等"),
    op = create(p),
    a = await push(pool, who, body([op])),
    retry = await push(pool, who, body([op]));
  assert.deepEqual(a.results, retry.results);
  assert.equal(
    (await pool.query("SELECT count(*) FROM projects WHERE id=$1", [p.id]))
      .rows[0].count,
    "1",
  );
  const reused = await push(
    pool,
    who,
    body([{ ...op, payload: { ...p, name: "复用" } }]),
  );
  assert.equal((reused.results[0] as any).code, "OPERATION_ID_REUSED");
  const patch = {
    operationId: randomUUID(),
    kind: "project.patch",
    entityId: p.id,
    baseServerVersion: "1",
    payload: { name: "修改" },
  };
  const parallel = await Promise.all([
    push(pool, who, body([patch])),
    push(
      pool,
      who,
      body([
        { ...patch, operationId: randomUUID(), payload: { name: "另一设备" } },
      ]),
    ),
  ]);
  assert.equal(
    parallel.filter((r) => (r.results[0] as any).status === "applied").length,
    1,
  );
  assert.equal(
    parallel.filter((r) => (r.results[0] as any).code === "VERSION_CONFLICT")
      .length,
    1,
  );
  const del = await push(
    pool,
    who,
    body([
      {
        operationId: randomUUID(),
        kind: "project.deleteSubtree",
        entityId: p.id,
        baseServerVersion: "2",
        payload: { expectedVersions: { [p.id]: "2" } },
      },
    ]),
  );
  assert.equal(del.results[0]?.status, "applied");
  const resurrection = await push(pool, who, body([create(p)]));
  assert.equal((resurrection.results[0] as any).code, "ENTITY_DELETED");
});
test("atomic group operations reject partial versions and preserve all members", async () => {
  const parent = project("树根"),
    child = project("树子", parent.id);
  await push(pool, who, body([create(parent), create(child)]));
  const bad = await push(
    pool,
    who,
    body([
      {
        operationId: randomUUID(),
        kind: "project.archive",
        entityId: parent.id,
        baseServerVersion: "1",
        payload: { expectedVersions: { [parent.id]: "1", [child.id]: "9" } },
      },
    ]),
  );
  assert.equal((bad.results[0] as any).code, "VERSION_CONFLICT");
  const rows = (
    await pool.query("SELECT data FROM projects WHERE id=ANY($1::uuid[])", [
      [parent.id, child.id],
    ])
  ).rows;
  assert.equal(
    rows.every((r) => r.data.archived === false),
    true,
  );
});
test("fixed pull boundary and materialized snapshot remain complete during writes", async () => {
  await push(
    pool,
    who,
    body([create(project("分页A")), create(project("分页B"))]),
  );
  const first = await pull(pool, who, { generation: "1", limit: 1 }, secret),
    snap = await snapshot(pool, who, "1");
  await push(pool, who, body([create(project("分页C"))]));
  let page = first,
    seqs = first.changes.map((c) => c.seq);
  while (page.hasMore) {
    page = await pull(
      pool,
      who,
      { generation: "1", limit: 1, cursor: page.cursor },
      secret,
    );
    assert.equal(page.snapshotUpperSeq, first.snapshotUpperSeq);
    seqs.push(...page.changes.map((c) => c.seq));
  }
  assert.equal(seqs.length, Number(first.snapshotUpperSeq));
  const next = await pull(
    pool,
    who,
    { generation: "1", cursor: page.cursor },
    secret,
  );
  assert.equal(next.changes.length, 1);
  const frozen = await readSnapshot(pool, who, snap.id, { offset: 0 }, secret);
  assert.equal(
    frozen.changes.some((c) => c.data?.name === "分页C"),
    false,
  );
  assert.equal(frozen.upperSeq, snap.upperSeq);
  await assert.rejects(
    () =>
      pull(
        pool,
        who,
        { generation: "1", cursor: first.cursor + "tamper" },
        secret,
      ),
    /INVALID_CURSOR/,
  );
});
test("concurrent commit order gives gapless visible change sequence", async () => {
  const start = (
    await pool.query("SELECT change_seq FROM spaces WHERE id=$1", [who.spaceId])
  ).rows[0].change_seq;
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      push(pool, who, body([create(project("并发" + i))])),
    ),
  );
  const rows = (
    await pool.query(
      "SELECT seq FROM sync_changes WHERE space_id=$1 AND seq>$2 ORDER BY seq",
      [who.spaceId, start],
    )
  ).rows;
  assert.equal(rows.length, 8);
  rows.forEach((r, i) =>
    assert.equal(r.seq, (BigInt(start) + BigInt(i) + 1n).toString()),
  );
});
test("HTTP ownership and unauthenticated access fail without exposing facts", async () => {
  const result = await app.inject({ method: "GET", url: "/api/v1/me" });
  assert.equal(result.statusCode, 401);
  const other = { ...who, userId: randomUUID() };
  await assert.rejects(() => snapshot(pool, other, "1"), /AUTH_REQUIRED/);
  await assert.rejects(
    () => push(pool, who, { ...body([]), spaceId: randomUUID() }),
    /FORBIDDEN/,
  );
  await assert.rejects(
    () => readSnapshot(pool, other, randomUUID(), {}, secret),
    /SNAPSHOT_EXPIRED/,
  );
  const exported = await snapshot(pool, who, "1", "export");
  await assert.rejects(
    () => readSnapshot(pool, other, exported.id, {}, secret),
    /SNAPSHOT_EXPIRED/,
  );
  const ownCursor = (await pull(pool, who, { generation: "1" }, secret)).cursor;
  const foreign = { ...who, userId: randomUUID(), spaceId: randomUUID() };
  await pool.query("INSERT INTO users(id) VALUES($1)", [foreign.userId]);
  await pool.query("INSERT INTO spaces(id,user_id) VALUES($1,$2)", [
    foreign.spaceId,
    foreign.userId,
  ]);
  await assert.rejects(
    () => pull(pool, foreign, { generation: "1", cursor: ownCursor }, secret),
    /INVALID_CURSOR/,
  );
  const countBefore = (await pool.query("SELECT count(*) FROM sync_operations"))
    .rows[0].count;
  await assert.rejects(
    () => push(pool, who, { ...body([]), protocolVersion: 0 }),
    /UPGRADE_REQUIRED/,
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM sync_operations")).rows[0].count,
    countBefore,
  );
});
test("two real PostgreSQL client workers sync history, offline edits and response-loss retries", async () => {
  const { createMemoryAdapter } = require("../../storage/adapter"),
    { createService } = require("../../core/service"),
    { createWorker } = require("../../sync/worker"),
    local = require("../../sync/local");
  let lose = true;
  const make = async () => {
    const adapter = createMemoryAdapter();
    await adapter.set(local.STATE, {
      spaceId: who.spaceId,
      generation: "1",
      nextOrder: 0,
    });
    let now = 1800000000;
    const service = createService(adapter, { clock: () => now });
    await service.init();
    const request = async (method: string, path: string, data: any) => {
      if (path === "/sync/pull") return pull(pool, who, data, secret);
      if (path === "/sync/push") {
        const result = await push(pool, who, data);
        if (lose) {
          lose = false;
          throw Object.assign(new Error("lost response"), {
            code: "NETWORK_ERROR",
          });
        }
        return result;
      }
      throw new Error(path);
    };
    const worker = createWorker({ service, request, deviceId: randomUUID() });
    return { adapter, service, worker, tick: (n: number) => (now += n) };
  };
  const a = await make(),
    b = await make();
  try {
    const root = await a.service.createProject({
      operationId: randomUUID(),
      name: "双设备根",
    });
    const p = await a.service.createProject({
      operationId: randomUUID(),
      name: "双设备",
      parentId: root.data.project.id,
    });
    await a.service.start({
      operationId: randomUUID(),
      projectId: p.data.project.id,
      targetSeconds: 60,
    });
    a.tick(10);
    const active = await a.service.getCurrent();
    await a.service.pause({
      operationId: randomUUID(),
      sessionId: active.data.sessionId,
    });
    a.tick(20);
    await a.service.resume({
      operationId: randomUUID(),
      sessionId: active.data.sessionId,
    });
    a.tick(60);
    await a.service.getCurrent();
    const completedTask = (await local.pending(a.adapter)).find(
      (t: any) => t.kind === "session.createCompleted",
    );
    await a.worker.trigger();
    const frozen = (await local.pending(a.adapter))[0].frozen;
    assert.ok(frozen);
    await a.worker.trigger();
    await b.worker.trigger();
    const backup = await b.service.createBackup();
    assert.equal(
      backup.data.sessions.filter((s: any) => s.projectId === p.data.project.id)
        .length,
      1,
    );
    const session = backup.data.sessions.find(
      (s: any) => s.projectId === p.data.project.id,
    );
    assert.equal(session.durationSeconds, 60);
    assert.equal(session.pauses[0].durationSeconds, 20);
    assert.equal(
      (await b.adapter.get("yotick/projects"))[p.data.project.id].parentId,
      root.data.project.id,
    );
    await a.service.renameProject({
      operationId: randomUUID(),
      projectId: p.data.project.id,
      name: "连续离线改名",
    });
    await a.service.setProjectAppearance({
      operationId: randomUUID(),
      projectId: p.data.project.id,
      color: "#ABCDEF",
      shortName: "离线",
    });
    await a.worker.trigger();
    await b.worker.trigger();
    const synced = (await b.adapter.get("yotick/projects"))[p.data.project.id];
    assert.equal(synced.name, "连续离线改名");
    assert.equal(synced.color, "#ABCDEF");
    assert.equal((await local.pending(a.adapter)).length, 0);
    const removed = await b.service.deleteSession({
      operationId: randomUUID(),
      sessionId: session.id,
    });
    assert.equal(removed.ok, true);
    await b.worker.trigger();
    await a.worker.trigger();
    assert.equal(
      (await a.service.createBackup()).data.sessions.some(
        (s: any) => s.id === session.id,
      ),
      false,
    );
    // Retry an old offline upload after deletion using its unchanged request.
    await a.adapter.set(local.itemKey(completedTask.operationId), {
      ...completedTask,
      status: "sending",
      frozen: {
        operationId: completedTask.operationId,
        kind: completedTask.kind,
        entityId: completedTask.entityId,
        payload: completedTask.payload,
      },
    });
    await a.worker.trigger();
    assert.equal(
      (await a.service.createBackup()).data.sessions.some(
        (s: any) => s.id === session.id,
      ),
      false,
    );
    assert.equal((await local.pending(a.adapter)).length, 0);
  } finally {
    a.worker.stop();
    b.worker.stop();
  }
});
test("client login, explicit guest migration and second-device sync use authenticated HTTP with real PostgreSQL", async () => {
  const { createMemoryAdapter } = require("../../storage/adapter"),
    { createAccounts } = require("../../sync/accounts");
  const previousWx = (globalThis as any).wx,
    previousFetch = globalThis.fetch;
  (globalThis as any).wx = {
    login: ({ success }: any) => success({ code: "simulated-full-flow-code" }),
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ openid: "simulated-full-account-flow" }), {
      status: 200,
    });
  const transport = async (
    method: string,
    url: string,
    data: any,
    token: string,
  ) => {
    const parsed = new URL(url),
      response = await app.inject({
        method,
        url: parsed.pathname + parsed.search,
        headers: token ? { authorization: "Bearer " + token } : {},
        ...(method === "GET" ? {} : { payload: data }),
      });
    const value = response.body ? response.json() : undefined;
    if (response.statusCode >= 400)
      throw Object.assign(new Error(value.error.message), {
        code: value.error.code,
        status: response.statusCode,
      });
    return value;
  };
  const appA = { globalData: {} as any },
    appB = { globalData: {} as any },
    a = createAccounts(createMemoryAdapter(), appA, {
      baseUrl: "https://test.yotick.invalid/api/v1",
      transport,
    }),
    b = createAccounts(createMemoryAdapter(), appB, {
      baseUrl: "https://test.yotick.invalid/api/v1",
      transport,
    });
  try {
    await a.init();
    await b.init();
    const guest = await appA.globalData.service.createProject({
      operationId: randomUUID(),
      name: "显式迁移游客项目",
    });
    assert.equal(guest.ok, true);
    await a.login();
    await b.login();
    await a.trigger();
    await b.trigger();
    assert.deepEqual(a.getCurrent(), b.getCurrent());
    assert.equal(
      (await appB.globalData.service.createBackup()).data.projects.length,
      0,
    );
    const preview = await a.migrateGuest();
    assert.equal(preview.projectCount, 1);
    await a.commitGuestMigration({});
    await a.trigger();
    await b.trigger();
    assert.equal(
      (await appB.globalData.service.createBackup()).data.projects[0].id,
      guest.data.project.id,
    );
    const active = await appA.globalData.service.start({
      operationId: randomUUID(),
      projectId: guest.data.project.id,
      targetSeconds: 60,
    });
    assert.equal(active.ok, true);
    assert.equal(
      (
        await appA.globalData.service.stop({
          operationId: randomUUID(),
          sessionId: active.data.sessionId,
        })
      ).ok,
      true,
    );
    await a.trigger();
    await a.trigger();
    await b.trigger();
    const records = (await appB.globalData.service.createBackup()).data
      .sessions;
    assert.equal(records.length, 1);
    assert.equal(records[0].id, active.data.sessionId);
    await a.logout();
    assert.equal(a.getCurrent(), null);
    assert.equal(
      (await appA.globalData.service.createBackup()).data.projects[0].id,
      guest.data.project.id,
    );
    await b.logout();
  } finally {
    await a.logout().catch(() => {});
    await b.logout().catch(() => {});
    (globalThis as any).wx = previousWx;
    globalThis.fetch = previousFetch;
  }
});

test("clear advances generation, retries same receipt and rejects old device", async () => {
  const b = {
    operationId: randomUUID(),
    generation: "1",
    confirmation: "DELETE_ALL_ACCOUNT_DATA",
  };
  const a = await clear(pool, who, b),
    retry = await clear(pool, who, b);
  assert.deepEqual(a, retry);
  assert.equal(a.generation, "2");
  await assert.rejects(
    () => push(pool, who, body([create(project("旧设备"))])),
    /GENERATION_MISMATCH/,
  );
});
test("concurrent refresh and response-loss grace return same rotated credentials, stale replay revokes", async () => {
  const initial = await tokens();
  const responses = await Promise.all([
    app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: initial.refresh },
    }),
    app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: initial.refresh },
    }),
  ]);
  assert.deepEqual(
    responses.map((r) => r.statusCode),
    [200, 200],
  );
  const next = responses[0].json();
  assert.deepEqual(next, responses[1].json());
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { authorization: "Bearer " + next.accessToken },
  });
  assert.equal(me.statusCode, 200);
  await pool.query(
    "UPDATE auth_session_refresh_history SET replay_until=now()-interval '1 minute' WHERE session_id=$1",
    [initial.id],
  );
  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refreshToken: initial.refresh },
  });
  assert.equal(replay.statusCode, 401);
  const revoked = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { authorization: "Bearer " + next.accessToken },
  });
  assert.equal(revoked.statusCode, 401);
});
test("chunk migration stages invisibly, retries bytes, validates digest and publishes once", async () => {
  const identity = {
    ...who,
    userId: randomUUID(),
    spaceId: randomUUID(),
    generation: "1",
  };
  await pool.query("INSERT INTO users(id) VALUES($1)", [identity.userId]);
  await pool.query("INSERT INTO spaces(id,user_id) VALUES($1,$2)", [
    identity.spaceId,
    identity.userId,
  ]);
  const auth = await tokens(identity),
    jobId = randomUUID(),
    p = project("迁移项目");
  const send = (method: string, url: string, payload: any) =>
    app.inject({
      method,
      url: "/api/v1" + url,
      headers: auth.headers,
      payload,
    });
  assert.equal(
    (
      await send("POST", "/imports", {
        jobId,
        sourceId: "guest-source",
        generation: "1",
        chunkCount: 1,
      })
    ).statusCode,
    200,
  );
  const chunk = { projects: [p], sessions: [] };
  assert.equal(
    (await send("PUT", "/imports/" + jobId + "/chunks/0", chunk)).statusCode,
    200,
  );
  assert.equal(
    (await send("PUT", "/imports/" + jobId + "/chunks/0", chunk)).statusCode,
    200,
  );
  assert.equal(
    (
      await send("PUT", "/imports/" + jobId + "/chunks/0", {
        projects: [{ ...p, name: "changed" }],
        sessions: [],
      })
    ).json().error.code,
    "CHUNK_REUSED",
  );
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM projects WHERE space_id=$1", [
        identity.spaceId,
      ])
    ).rows[0].count,
    "0",
  );
  const preview = (await send("POST", "/imports/preview", { jobId })).json();
  assert.equal(preview.conflicts.length, 0);
  const b = {
    confirmation: "MERGE_GUEST_DATA",
    deviceId: device,
    sourceDigest: preview.digest,
    mapping: {},
  };
  const first = await send("POST", "/imports/" + jobId + "/commit", b);
  assert.equal(first.statusCode, 200);
  const retry = await send("POST", "/imports/" + jobId + "/commit", b);
  assert.deepEqual(retry.json(), first.json());
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM projects WHERE space_id=$1", [
        identity.spaceId,
      ])
    ).rows[0].count,
    "1",
  );
});
test("real PostgreSQL logical backup/restore recovers facts, receipts and invalidates old cursors", async () => {
  const backup = JSON.parse(JSON.stringify(await logicalBackup(pool)));
  await pool.query("CREATE DATABASE yotick_restore");
  const restored = new pg.Pool({
    host: "127.0.0.1",
    port: 55439,
    user: "postgres",
    password: "test-only-password",
    database: "yotick_restore",
  });
  try {
    for (const file of [
      "001_initial.sql",
      "002_auth.sql",
      "003_deletion_requests.sql",
      "004_device_sessions.sql",
      "005_client_privileges.sql",
    ])
      await restored.query(
        await readFile(
          new URL("../migrations/" + file, import.meta.url),
          "utf8",
        ),
      );
    await restoreEmptyDatabase(restored, backup);
    for (const t of backup.tables) {
      const source = (await pool.query("SELECT count(*) FROM " + t.name))
          .rows[0].count,
        target = (await restored.query("SELECT count(*) FROM " + t.name))
          .rows[0].count;
      assert.equal(target, source, t.name);
    }
    const generation = (
        await pool.query("SELECT generation FROM spaces WHERE id=$1", [
          who.spaceId,
        ])
      ).rows[0].generation,
      identity = { ...who, generation },
      before = await pull(pool, identity, { generation }, secret);
    await assert.rejects(
      () =>
        pull(restored, identity, { generation, cursor: before.cursor }, secret),
      /CURSOR_EXPIRED/,
    );
    await assert.rejects(() => restoreEmptyDatabase(restored, backup), /empty/);
  } finally {
    await restored.end();
  }
});
test("administrative deletion fulfills only requested account and revokes its identity and sessions", async () => {
  const identity = {
    ...who,
    userId: randomUUID(),
    spaceId: randomUUID(),
    generation: "1",
  };
  await pool.query("INSERT INTO users(id) VALUES($1)", [identity.userId]);
  await pool.query("INSERT INTO spaces(id,user_id) VALUES($1,$2)", [
    identity.spaceId,
    identity.userId,
  ]);
  await pool.query(
    "INSERT INTO auth_identities(provider,app_id,subject,user_id) VALUES('wechat-mini','test-app','delete-sample',$1)",
    [identity.userId],
  );
  const auth = await tokens(identity),
    p = project("注销样本");
  await push(pool, identity, body([create(p)], identity));
  const outsideBefore = (
    await pool.query("SELECT count(*) FROM users WHERE id=$1", [who.userId])
  ).rows[0].count;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/account/deletion-requests",
    headers: auth.headers,
    payload: { confirmation: "REQUEST_ACCOUNT_DELETION" },
  });
  assert.equal(response.statusCode, 200);
  const request = response.json();
  const queried = await app.inject({ method: "GET", url: "/api/v1/account/deletion-requests", headers: auth.headers });
  assert.equal(queried.statusCode, 200);
  assert.equal(queried.json().request.id, request.id);
  const unrelatedAuth = await tokens(who);
  const unrelated = await app.inject({ method: "GET", url: "/api/v1/account/deletion-requests", headers: unrelatedAuth.headers });
  assert.equal(unrelated.statusCode, 200);
  assert.equal(unrelated.json().request, null);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/account/deletion-requests" })).statusCode, 401);
  const repeated = await app.inject({ method: "POST", url: "/api/v1/account/deletion-requests", headers: auth.headers,
    payload: { confirmation: "REQUEST_ACCOUNT_DELETION" } });
  assert.equal(repeated.json().id, request.id);
  await assert.rejects(
    () => fulfillAccountDeletion(pool, request.id, "wrong"),
    /CONFIRMATION_REQUIRED/,
  );
  const result = await fulfillAccountDeletion(
    pool,
    request.id,
    "PURGE_REQUESTED_ACCOUNT",
  );
  assert.equal(result.fulfilled, true);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: auth.headers,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM users WHERE id=$1", [
        identity.userId,
      ])
    ).rows[0].count,
    "0",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM auth_identities WHERE user_id=$1",
        [identity.userId],
      )
    ).rows[0].count,
    "0",
  );
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM projects WHERE space_id=$1", [
        identity.spaceId,
      ])
    ).rows[0].count,
    "0",
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM users WHERE id=$1", [who.userId]))
      .rows[0].count,
    outsideBefore,
  );
});
test("simulated WeChat provider login race binds one internal account and persists device sessions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.weixin.qq.com");
    return new Response(
      JSON.stringify({
        openid: "simulated-wechat-subject",
        errcode: 0,
        session_key: "test-provider-private-field",
      }),
      { status: 200 },
    );
  };
  try {
    const deviceA = randomUUID(),
      deviceB = randomUUID(),
      responses = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/v1/auth/wechat-mini",
          payload: { code: "simulated-code-a", deviceId: deviceA },
        }),
        app.inject({
          method: "POST",
          url: "/api/v1/auth/wechat-mini",
          payload: { code: "simulated-code-b", deviceId: deviceB },
        }),
      ]);
    assert.deepEqual(
      responses.map((r) => r.statusCode),
      [200, 200],
    );
    const a = responses[0].json(),
      b = responses[1].json();
    assert.deepEqual(a.account, b.account);
    assert.notEqual(a.accessToken, b.accessToken);
    assert.equal(JSON.stringify(a).includes("session_key"), false);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM auth_identities WHERE subject='simulated-wechat-subject'",
        )
      ).rows[0].count,
      "1",
    );
    const sessions = (
      await pool.query("SELECT device_id FROM auth_sessions WHERE user_id=$1", [
        a.account.userId,
      ])
    ).rows;
    assert.deepEqual(
      new Set(sessions.map((s) => s.device_id)),
      new Set([deviceA, deviceB]),
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/me",
          headers: { authorization: "Bearer " + a.accessToken },
        })
      ).statusCode,
      200,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("migration preserves archived hierarchy and explicitly copies conflicting session UUID", async () => {
  const identity = {
    ...who,
    userId: randomUUID(),
    spaceId: randomUUID(),
    generation: "1",
  };
  await pool.query("INSERT INTO users(id) VALUES($1)", [identity.userId]);
  await pool.query("INSERT INTO spaces(id,user_id) VALUES($1,$2)", [
    identity.spaceId,
    identity.userId,
  ]);
  const auth = await tokens(identity),
    root = { ...project("归档根"), archived: true },
    child = { ...project("归档子", root.id), archived: true },
    session = {
      id: randomUUID(),
      projectId: child.id,
      status: "COMPLETED",
      startedAtSec: 1800000000,
      endedAtSec: 1800000030,
      durationSeconds: 30,
      targetSeconds: 60,
      pauses: [],
      createdAtSec: 1800000000,
      updatedAtSec: 1800000030,
    };
  const send = (method: string, path: string, payload: any) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: auth.headers,
      payload,
    });
  async function stage(chunk: any) {
    const jobId = randomUUID();
    await send("POST", "/imports", {
      jobId,
      sourceId: "archived-source",
      generation: "1",
      chunkCount: 1,
    });
    await send("PUT", "/imports/" + jobId + "/chunks/0", chunk);
    const preview = (await send("POST", "/imports/preview", { jobId })).json();
    return { jobId, preview };
  }
  const first = await stage({ projects: [root, child], sessions: [session] }),
    committed = await send("POST", "/imports/" + first.jobId + "/commit", {
      confirmation: "MERGE_GUEST_DATA",
      deviceId: device,
      sourceDigest: first.preview.digest,
      mapping: {},
    });
  assert.equal(committed.statusCode, 200);
  const rows = (
    await pool.query("SELECT data FROM projects WHERE space_id=$1", [
      identity.spaceId,
    ])
  ).rows;
  assert.equal(
    rows.every((r) => r.data.archived),
    true,
  );
  const changed = {
      ...session,
      endedAtSec: 1800000040,
      durationSeconds: 40,
      updatedAtSec: 1800000040,
    },
    second = await stage({ projects: [root, child], sessions: [changed] }),
    newId = randomUUID();
  const merged = await send("POST", "/imports/" + second.jobId + "/commit", {
    confirmation: "MERGE_GUEST_DATA",
    deviceId: device,
    sourceDigest: second.preview.digest,
    mapping: { [root.id]: root.id, [child.id]: child.id },
    sessionMapping: { [session.id]: newId },
  });
  assert.equal(merged.statusCode, 200);
  assert.equal(merged.json().sessionMapping[session.id], newId);
  const facts = (
    await pool.query(
      "SELECT data FROM study_sessions WHERE space_id=$1 ORDER BY id",
      [identity.spaceId],
    )
  ).rows;
  assert.equal(facts.length, 2);
  assert.deepEqual(
    new Set(facts.map((f) => f.data.durationSeconds)),
    new Set([30, 40]),
  );
});

test('automatic guest saving is idempotent, respects account deletions and retains account project names', async () => {
  const identity = { ...who, userId:randomUUID(), spaceId:randomUUID(), generation:'1' };
  await pool.query('INSERT INTO users(id) VALUES($1)', [identity.userId]);
  await pool.query('INSERT INTO spaces(id,user_id) VALUES($1,$2)', [identity.spaceId,identity.userId]);
  const auth = await tokens(identity), root = project('自动数学'), child = project('自动高数',root.id);
  const s = { id:randomUUID(), projectId:child.id, status:'COMPLETED', startedAtSec:1800000000,
    endedAtSec:1800000060, durationSeconds:60, targetSeconds:60, pauses:[], createdAtSec:1800000000,updatedAtSec:1800000060 };
  const send = (method:string,path:string,payload:any) => app.inject({method,url:'/api/v1'+path,headers:auth.headers,payload});
  const stage = async (projects:any[],sessions:any[]) => {
    const id = randomUUID();
    assert.equal((await send('POST','/imports',{ jobId:id,sourceId:'guest:test',generation:'1',chunkCount:1 })).statusCode,200);
    assert.equal((await send('PUT','/imports/'+id+'/chunks/0',{projects,sessions})).statusCode,200);
    const preview = (await send('POST','/imports/preview',{jobId:id})).json();
    assert.equal(preview.mergePolicy,'KEEP_ACCOUNT');
    return {id,body:{confirmation:'MERGE_GUEST_DATA',deviceId:device,sourceDigest:preview.digest,mergePolicy:'KEEP_ACCOUNT'}};
  };
  const first = await stage([root,child],[s]);
  const result = await send('POST','/imports/'+first.id+'/commit',first.body);
  assert.equal(result.statusCode,200,result.body);
  assert.equal(result.json().addedProjectCount,2);
  assert.equal(result.json().addedSessionCount,1);
  assert.deepEqual((await send('POST','/imports/'+first.id+'/commit',first.body)).json(),result.json());
  const second = await stage([root,child],[{...s,id:randomUUID()}]);
  const repeated = await send('POST','/imports/'+second.id+'/commit',second.body);
  assert.equal(repeated.statusCode,200,repeated.body);
  assert.equal(repeated.json().addedSessionCount,0);
  assert.equal(repeated.json().skippedSessionCount,1);
  await pool.query('UPDATE study_sessions SET deleted_at=now() WHERE space_id=$1 AND id=$2',[identity.spaceId,s.id]);
  await pool.query("UPDATE projects SET name=$3,data=jsonb_set(data,'{name}',to_jsonb($3::text)) WHERE space_id=$1 AND id=$2",[identity.spaceId,root.id,'账号新名称']);
  const third = await stage([root,child],[s]);
  const deleted = await send('POST','/imports/'+third.id+'/commit',third.body);
  assert.equal(deleted.statusCode,200,deleted.body);
  assert.equal(deleted.json().addedSessionCount,0);
  assert.equal((await pool.query('SELECT name FROM projects WHERE space_id=$1 AND id=$2',[identity.spaceId,root.id])).rows[0].name,'账号新名称');
  assert.equal((await pool.query('SELECT count(*) FROM study_sessions WHERE space_id=$1 AND deleted_at IS NULL',[identity.spaceId])).rows[0].count,'0');
  await pool.query('UPDATE projects SET deleted_at=now() WHERE space_id=$1 AND id=$2',[identity.spaceId,root.id]);
  const fourth = await stage([root,child],[{...s,id:randomUUID()}]);
  const removedTree = await send('POST','/imports/'+fourth.id+'/commit',fourth.body);
  assert.equal(removedTree.statusCode,200,removedTree.body);
  assert.equal(removedTree.json().skippedProjectCount,2);
  assert.equal(removedTree.json().addedSessionCount,0);
});


test("completed records can only be shortened, including pauses, retries and concurrent versions", async () => {
  const identity={...who,userId:randomUUID(),spaceId:randomUUID(),generation:"1"};
  await pool.query("INSERT INTO users(id) VALUES($1)",[identity.userId]);
  await pool.query("INSERT INTO spaces(id,user_id) VALUES($1,$2)",[identity.spaceId,identity.userId]);
  const send=(operations:any[])=>push(pool,identity,body(operations,identity));
  const p = project("只能减少时长-" + randomUUID());
  await send([create(p)]);
  const id = randomUUID(), start = 1800000000;
  const original = { id, projectId:p.id, status:"COMPLETED", startedAtSec:start,
    endedAtSec:start+300, durationSeconds:180, targetSeconds:null, createdAtSec:start,
    updatedAtSec:start+300, pauses:[{id:randomUUID(),sessionId:id,status:"COMPLETED",
      startedAtSec:start+60,endedAtSec:start+180,durationSeconds:120,createdAtSec:start+60}] };
  await send([{operationId:randomUUID(),kind:"session.createCompleted",entityId:id,payload:original}]);
  const reduce = require("../../core/session-reduction").reduceSession;
  const operation = {operationId:randomUUID(),kind:"session.reduceDuration",entityId:id,
    baseServerVersion:"1",payload:reduce(original,90)};
  const first = await send([operation]);
  assert.equal(first.results[0]!.status,"applied");
  const stored = (await pool.query("SELECT data,server_version FROM study_sessions WHERE space_id=$1 AND id=$2",[identity.spaceId,id])).rows[0];
  assert.equal(stored.data.durationSeconds,90);assert.equal(stored.data.endedAtSec,start+210);
  assert.equal(stored.data.pauses.length,1);assert.equal(stored.server_version,"2");
  const replay = await send([operation]);
  assert.deepEqual(replay.results,first.results);
  for(const payload of [reduce(original,91),reduce(original,90),{...reduce(original,30),startedAtSec:start+1,endedAtSec:start+31}]) {
    const result=await send([{...operation,operationId:randomUUID(),baseServerVersion:"2",payload}]);
    assert.equal((result.results[0] as any).code,"INVALID_DURATION");
  }
  const concurrent=await Promise.all([30,20].map(duration=>send([{
    ...operation,operationId:randomUUID(),baseServerVersion:"2",payload:reduce(original,duration)
  }])));
  assert.equal(concurrent.filter(result=>result.results[0]!.status==="applied").length,1);
  assert.equal(concurrent.filter(result=>(result.results[0] as any).code==="VERSION_CONFLICT").length,1);
  assert.equal((await pool.query("SELECT count(*) FROM pauses WHERE space_id=$1 AND session_id=$2",[identity.spaceId,id])).rows[0].count,"0");
  const current=(await pool.query("SELECT data FROM study_sessions WHERE space_id=$1 AND id=$2",[identity.spaceId,id])).rows[0].data;
  assert.ok(current.durationSeconds<=30);assert.equal(current.startedAtSec,start);
});
