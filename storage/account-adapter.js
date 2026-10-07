// Fixed per-account storage views and resumable migration of the original
// unscoped YoTick data into the guest namespace.

const repository = require("../core/repository");
const { createService } = require("../core/service");
const { createMemoryAdapter } = require("./adapter");

const SPACE_PREFIX = "yotick-space/";
const MIGRATION_KEY = "yotick-global/legacy-migration";
const SNAPSHOT_PREFIX = "yotick-legacy-snapshot/";

const FACT_VIEW_KEY = "yotick/fact-view";
const isFactKey = (key) =>
  /^yotick\/(meta$|projects$|prefs$|s\/|d\/|p\/|shadow\/|conflicts\/)/.test(
    key,
  );
function createAccountAdapter(raw, namespace, options) {
  options = options || {};
  if (
    !raw ||
    typeof raw.get !== "function" ||
    typeof raw.set !== "function" ||
    typeof raw.remove !== "function" ||
    typeof raw.keys !== "function"
  ) {
    throw new TypeError("raw must implement get, set, remove, and keys");
  }
  if (typeof namespace !== "string" || !namespace) {
    throw new TypeError("namespace must be a non-empty string");
  }

  const prefix = SPACE_PREFIX + encodeURIComponent(namespace) + "/";
  const forcedView = Object.prototype.hasOwnProperty.call(options, "viewId");
  let viewId = options.viewId || null,
    viewLoaded = forcedView;
  async function loadView() {
    if (!viewLoaded) {
      viewId = (await raw.get(prefix + FACT_VIEW_KEY)) || null;
      viewLoaded = true;
    }
  }
  const physicalKey = (key) =>
    prefix +
    (viewId && isFactKey(key)
      ? "@views/" + encodeURIComponent(viewId) + "/"
      : "") +
    String(key);
  const view = {
    raw,
    namespace,
    type: raw.type,
    physicalKey,
    forView: (id) => createAccountAdapter(raw, namespace, { viewId: id }),
    async get(key) {
      await loadView();
      return raw.get(physicalKey(key));
    },
    async set(key, value) {
      await loadView();
      await raw.set(physicalKey(key), value);
      if (key === FACT_VIEW_KEY && !forcedView) viewId = value || null;
    },
    async remove(key) {
      await loadView();
      await raw.remove(physicalKey(key));
      if (key === FACT_VIEW_KEY && !forcedView) viewId = null;
    },
    async keys() {
      await loadView();
      const all = await raw.keys();
      const base = all
        .filter((key) => typeof key === "string" && key.indexOf(prefix) === 0)
        .map((key) => key.slice(prefix.length))
        .filter(
          (key) => !key.startsWith("@views/") && (!viewId || !isFactKey(key)),
        );
      if (viewId) {
        const active = prefix + "@views/" + encodeURIComponent(viewId) + "/";
        for (const key of all)
          if (key.startsWith(active)) base.push(key.slice(active.length));
      }
      return Array.from(new Set(base));
    },
  };

  if (typeof raw.getStorageSync === "function") {
    view.getSync = (key) => raw.getStorageSync(physicalKey(key));
  }
  if (typeof raw.setStorageSync === "function") {
    view.setSync = (key, value) => raw.setStorageSync(physicalKey(key), value);
  }
  if (typeof raw.removeStorageSync === "function") {
    view.removeSync = (key) => raw.removeStorageSync(physicalKey(key));
  }
  return view;
}

function snapshotKey(key) {
  return SNAPSHOT_PREFIX + encodeURIComponent(key);
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

async function migrateLegacy(raw, options) {
  options = options || {};
  const guest = createAccountAdapter(raw, "guest");
  let marker = await raw.get(MIGRATION_KEY);
  if (marker && marker.stage === "done") return guest;

  if (!marker) {
    // Finish durable repository transactions before deciding which legacy
    // values form the source of truth.
    await repository.recoverCommits(raw);
    const keys = (await raw.keys())
      .filter((key) => typeof key === "string" && key.indexOf("yotick/") === 0)
      .sort();
    if (raw.capacity) {
      const capacity = await raw.capacity();
      let bytes = 0;
      for (const key of keys) {
        const value = await raw.get(key);
        bytes +=
          unescape(encodeURIComponent(JSON.stringify(value) || "")).length +
          key.length;
      }
      if (capacity.limitBytes - capacity.usedBytes < bytes * 2 + 32768)
        throw Object.assign(
          new Error("本机剩余空间不足以保全旧副本并升级，请先导出备份"),
          { code: "LOCAL_CAPACITY_REQUIRED" },
        );
    }
    marker = {
      version: 1,
      stage: "snapshot",
      keys,
      snapshotIndex: 0,
      copyIndex: 0,
    };
    await raw.set(MIGRATION_KEY, marker);
  }
  if (marker.version !== 1 || !Array.isArray(marker.keys)) {
    throw new Error("Legacy migration marker is invalid");
  }

  // Snapshot each original value separately so the old source remains
  // recoverable without storing one potentially huge JSON blob.
  if (marker.stage === "snapshot") {
    while (marker.snapshotIndex < marker.keys.length) {
      const key = marker.keys[marker.snapshotIndex];
      const existing = await raw.get(snapshotKey(key));
      if (existing === undefined) {
        const value = await raw.get(key);
        await raw.set(snapshotKey(key), { exists: value !== undefined, value });
      }
      marker.snapshotIndex++;
      await raw.set(MIGRATION_KEY, marker);
    }
    marker.stage = "validate";
    await raw.set(MIGRATION_KEY, marker);
  }

  if (marker.stage === "validate") {
    // Run validation against an isolated copy of the durable snapshot. init and
    // createBackup may settle an expired ACTIVE session, so they must not touch
    // the user's legacy facts while migration is still being prepared.
    const snapshotRaw = createMemoryAdapter();
    for (const key of marker.keys) {
      const snap = await raw.get(snapshotKey(key));
      if (!snap || typeof snap.exists !== "boolean") {
        throw new Error("Legacy snapshot is missing for " + key);
      }
      if (snap.exists) await snapshotRaw.set(key, snap.value);
    }

    const service = createService(snapshotRaw, options.serviceOptions);
    const initialized = await service.init();
    if (!initialized || !initialized.ok) {
      throw new Error(
        "Legacy facts failed validation: " +
          ((initialized && initialized.error && initialized.error.message) ||
            "service init failed"),
      );
    }
    const backup = await service.createBackup();
    if (!backup || !backup.ok || !backup.data) {
      throw new Error(
        "Legacy facts could not be backed up: " +
          ((backup && backup.error && backup.error.message) || "backup failed"),
      );
    }
    // createBackup collects the entire history but does not validate every
    // completed session. Preview it against a clean service to run the normal
    // backup validators over projects, sessions, pauses, and references.
    const emptyRaw = createMemoryAdapter();
    const emptyService = createService(emptyRaw, options.serviceOptions);
    const emptyInit = await emptyService.init();
    if (!emptyInit || !emptyInit.ok)
      throw new Error("Empty validation space failed to initialize");
    const preview = await emptyService.previewBackup(backup.data);
    if (!preview || !preview.ok) {
      throw new Error(
        "Legacy facts failed backup validation: " +
          ((preview && preview.error && preview.error.message) ||
            "backup preview failed"),
      );
    }
    marker.stage = "copy";
    await raw.set(MIGRATION_KEY, marker);
  }

  if (marker.stage === "copy") {
    while (marker.copyIndex < marker.keys.length) {
      const key = marker.keys[marker.copyIndex];
      const snap = await raw.get(snapshotKey(key));
      if (!snap || typeof snap.exists !== "boolean") {
        throw new Error("Legacy snapshot is missing for " + key);
      }
      if (snap.exists) {
        await guest.set(key, snap.value);
        const copied = await guest.get(key);
        if (!sameValue(copied, snap.value)) {
          throw new Error("Legacy copy verification failed for " + key);
        }
      }
      marker.copyIndex++;
      await raw.set(MIGRATION_KEY, marker);
    }
    marker.stage = "verify";
    await raw.set(MIGRATION_KEY, marker);
  }

  if (marker.stage === "verify") {
    for (const key of marker.keys) {
      const snap = await raw.get(snapshotKey(key));
      if (!snap || typeof snap.exists !== "boolean") {
        throw new Error("Legacy snapshot is missing for " + key);
      }
      if (snap.exists && !sameValue(await guest.get(key), snap.value)) {
        throw new Error("Legacy copy verification failed for " + key);
      }
    }
    marker.stage = "done";
    marker.completedAt = Date.now();
    await raw.set(MIGRATION_KEY, marker);
  }

  return guest;
}

module.exports = {
  FACT_VIEW_KEY,
  isFactKey,
  createAccountAdapter,
  migrateLegacy,
  MIGRATION_KEY,
  SNAPSHOT_PREFIX,
};
