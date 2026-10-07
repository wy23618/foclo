const test = require("node:test");
const assert = require("node:assert/strict");

const { createMemoryAdapter } = require("../storage/adapter");
const { createService } = require("../core/service");
const {
  createAccountAdapter,
  migrateLegacy,
  MIGRATION_KEY,
  SNAPSHOT_PREFIX,
} = require("../storage/account-adapter");

function legacyStorage() {
  const raw = createMemoryAdapter();
  raw._map.set("yotick/meta", {
    id: "old-space",
    schemaVersion: 1,
    dataRevision: 0,
    utcOffsetMinutes: 480,
    activeSessionId: null,
    nextCreationOrder: 1,
    lastMonotonicSec: 100,
    createdAtSec: 100,
  });
  raw._map.set("yotick/projects", {});
  raw._map.set("yotick/prefs", { theme: "night" });
  raw._map.set("yotick/extension/opaque", { retained: [1, 2, 3] });
  raw._map.set("yotick-global/current-account", { spaceId: "account-1" });
  raw._map.set("yotick-space/account-1/yotick/meta", { id: "account-1" });
  return raw;
}

test("fixed account views scope reads, writes, keys, and removals", async () => {
  const raw = createMemoryAdapter();
  const guest = createAccountAdapter(raw, "guest");
  const account = createAccountAdapter(raw, "space/a");

  await guest.set("yotick/meta", { id: "guest" });
  await account.set("yotick/meta", { id: "account" });
  await raw.set("yotick-global/current-account", "space/a");
  await raw.set("yotick-space/another/yotick/meta", { id: "another" });

  assert.deepEqual(await guest.get("yotick/meta"), { id: "guest" });
  assert.deepEqual(await account.get("yotick/meta"), { id: "account" });
  assert.deepEqual(await guest.keys(), ["yotick/meta"]);
  assert.deepEqual(await account.keys(), ["yotick/meta"]);
  await guest.remove("yotick/meta");
  assert.equal(await guest.get("yotick/meta"), undefined);
  assert.deepEqual(await account.get("yotick/meta"), { id: "account" });
  assert.deepEqual(await raw.get("yotick-space/another/yotick/meta"), {
    id: "another",
  });
  assert.equal(
    guest.physicalKey("yotick/meta"),
    "yotick-space/guest/yotick/meta",
  );
  assert.equal(guest.raw, raw);
  assert.equal(guest.namespace, "guest");
});

test("migration snapshots legacy extras and resumes after failures at each durable boundary", async (t) => {
  const cases = [
    {
      name: "before marker",
      faultKey: (key) => key === MIGRATION_KEY,
      prepare: null,
    },
    {
      name: "during source snapshot write",
      faultKey: (key) => key.indexOf(SNAPSHOT_PREFIX) === 0,
      prepare: null,
    },
    {
      name: "during guest copy",
      faultKey: (key) => key.indexOf("yotick-space/guest/") === 0,
      prepare: null,
    },
    {
      name: "while switching to done",
      faultKey: (key) => key === MIGRATION_KEY,
      prepare: async (raw) => {
        const keys = (await raw.keys())
          .filter((key) => key.indexOf("yotick/") === 0)
          .sort();
        for (const key of keys) {
          const value = await raw.get(key);
          await raw.set(SNAPSHOT_PREFIX + encodeURIComponent(key), {
            exists: true,
            value,
          });
          await raw.set("yotick-space/guest/" + key, value);
        }
        await raw.set(MIGRATION_KEY, {
          version: 1,
          stage: "verify",
          keys,
          snapshotIndex: keys.length,
          copyIndex: keys.length,
        });
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const raw = legacyStorage();
      const originalKeys = (await raw.keys())
        .filter((key) => key.indexOf("yotick/") === 0)
        .sort();
      const originals = new Map();
      for (const key of originalKeys) originals.set(key, await raw.get(key));
      if (scenario.prepare) await scenario.prepare(raw);

      raw.inject(
        scenario.faultKey,
        1,
        new Error("simulated interruption"),
        "set",
      );
      await assert.rejects(
        migrateLegacy(raw, { serviceOptions: { clock: () => 100 } }),
        /simulated interruption/,
      );
      raw.clearFaults();

      const guest = await migrateLegacy(raw, {
        serviceOptions: { clock: () => 100 },
      });
      assert.equal((await raw.get(MIGRATION_KEY)).stage, "done");
      for (const key of originalKeys) {
        assert.deepEqual(await guest.get(key), originals.get(key), key);
        assert.deepEqual(
          await raw.get(key),
          originals.get(key),
          "legacy copy retained: " + key,
        );
      }
      assert.equal(await guest.get("yotick-global/current-account"), undefined);
      assert.equal(
        await guest.get("yotick-space/account-1/yotick/meta"),
        undefined,
      );
      assert.deepEqual((await guest.keys()).sort(), originalKeys);
    });
  }
});

test("invalid legacy facts stop migration and preserve the original values", async () => {
  const raw = legacyStorage();
  const corruptProjects = { broken: { id: "broken", name: 4 } };
  raw._map.set("yotick/projects", corruptProjects);

  await assert.rejects(
    migrateLegacy(raw, { serviceOptions: { clock: () => 100 } }),
    /failed validation/,
  );
  assert.deepEqual(await raw.get("yotick/projects"), corruptProjects);
  assert.equal(await raw.get("yotick-space/guest/yotick/projects"), undefined);
  assert.equal((await raw.get(MIGRATION_KEY)).stage, "validate");
});

test("interrupted migration of an expired countdown settles to one record on source and guest recovery", async () => {
  let now = 100;
  let id = 0;
  const raw = createMemoryAdapter();
  const setup = createService(raw, {
    clock: () => now,
    genId: () => "id-" + ++id,
  });
  assert.equal((await setup.init()).ok, true);
  const created = await setup.createProject({
    operationId: "create-project",
    name: "Study",
  });
  const projectId = created.data.project.id;
  assert.equal(
    (await setup.start({ operationId: "start", projectId, targetSeconds: 60 }))
      .ok,
    true,
  );
  const sessionId = (await raw.get("yotick/meta")).activeSessionId;
  const sessionKey = "yotick/s/" + sessionId;
  const activeBeforeMigration = await raw.get(sessionKey);
  assert.equal(activeBeforeMigration.status, "ACTIVE");

  now = 161;
  raw.inject(
    (key) => key.indexOf("yotick-space/guest/") === 0,
    1,
    new Error("copy interruption"),
    "set",
  );
  await assert.rejects(
    migrateLegacy(raw, { serviceOptions: { clock: () => now } }),
    /copy interruption/,
  );
  raw.clearFaults();
  assert.deepEqual(
    await raw.get(sessionKey),
    activeBeforeMigration,
    "validation did not settle legacy facts",
  );

  const guest = await migrateLegacy(raw, {
    serviceOptions: { clock: () => now },
  });
  assert.deepEqual(
    await guest.get(sessionKey),
    activeBeforeMigration,
    "stable guest snapshot retains source facts",
  );

  const sourceRecovery = createService(raw, { clock: () => now });
  const guestRecovery = createService(guest, { clock: () => now });
  assert.equal((await sourceRecovery.init()).ok, true);
  assert.equal((await guestRecovery.init()).ok, true);
  const [sourceBackup, guestBackup] = await Promise.all([
    sourceRecovery.createBackup(),
    guestRecovery.createBackup(),
  ]);
  for (const backup of [sourceBackup, guestBackup]) {
    assert.equal(backup.ok, true);
    assert.equal(backup.data.sessions.length, 1);
    assert.equal(backup.data.sessions[0].id, sessionId);
    assert.equal(backup.data.sessions[0].status, "COMPLETED");
  }
});

test("sync helpers are exposed only when the raw adapter supports them and remain scoped", () => {
  const values = new Map();
  const raw = {
    get: async () => undefined,
    set: async () => {},
    remove: async () => {},
    keys: async () => [],
    getStorageSync(key) {
      return values.get(key);
    },
    setStorageSync(key, value) {
      values.set(key, value);
    },
    removeStorageSync(key) {
      values.delete(key);
    },
  };
  const account = createAccountAdapter(raw, "id/1");
  account.setSync("key", 7);
  assert.equal(account.getSync("key"), 7);
  assert.equal(values.has("yotick-space/id%2F1/key"), true);
  account.removeSync("key");
  assert.equal(account.getSync("key"), undefined);
  assert.equal(
    createAccountAdapter(createMemoryAdapter(), "guest").getSync,
    undefined,
  );
});
