// Large local-storage acceptance run. It uses a fresh namespace and file path
// inside the current DevTools USER_DATA_PATH; generated sample facts are kept.
const path = require("node:path");
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const automator = require(path.join(process.env.LOCALAPPDATA, "YoTick", "AcceptanceTools", "node_modules", "miniprogram-automator"));
const artifactRoot = path.join(process.env.LOCALAPPDATA, "YoTick", "LocalServer");
const progressIntervalMs = 2000;
const maxRunMs = 15 * 60 * 1000;
const resumeIndex = process.argv.indexOf("--resume-namespace");
const resumeNamespace = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : null;
const measureStatistics = process.argv.includes("--measure-statistics");

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 3 | 8)).toString(16);
  });
}

function summarize(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted[sorted.length - 1], samplesMs: samples };
}

const startedAt = Date.now();
const deadline = setTimeout(() => {
  console.error("DevTools scale run exceeded 15 minutes; sample files are retained.");
  process.exit(1);
}, maxRunMs);

(async () => {
  fs.mkdirSync(artifactRoot, { recursive: true });
  const mp = await automator.connect({ wsEndpoint: "ws://127.0.0.1:9421" });
  try {
    const existing = await mp.evaluate(() => {
      const g = getApp().globalData;
      return [g._yotickScaleRun, g._yotickScaleColdRun].find(s =>
        s && ["starting", "initializing", "seeding", "measuring", "reopening"].includes(s.phase)) || null;
    });
    if (existing)
      throw Object.assign(new Error("An acceptance scale run is still active; refusing to replace its state"), { code: "SCALE_RUN_ACTIVE" });

    if (resumeNamespace) {
      await mp.evaluate(async options => {
        const namespace = options.namespace;
        const measureStatistics = options.measureStatistics;
        const app = getApp();
        const previous = app.globalData._yotickScaleRun;
        const state = app.globalData._yotickScaleColdRun = { phase: "reopening", done: 0, total: 1, result: null };
        (async () => {
          try {
            const serviceModule = require("core/service.js");
            const fileModule = require("storage/file-adapter.js");
            const accountModule = require("storage/account-adapter.js");
            const adapterModule = require("storage/adapter.js");
            const time = require("core/time.js");
            const match = /^scale-acceptance-([0-9a-f-]{36})$/.exec(namespace);
            if (!match) throw Object.assign(new Error("Invalid scale acceptance namespace"), { code: "SCALE_NAMESPACE_INVALID" });
            const basePath = wx.env.USER_DATA_PATH + "/yotick-acceptance-" + match[1];
            const raw = adapterModule.createMemoryAdapter();
            const fileTier = fileModule.createFileTierAdapter(raw, wx, { basePath });
            const adapter = accountModule.createAccountAdapter(fileTier, namespace);
            const scanStarted = Date.now();
            const capacity = await fileTier.capacity();
            const indexScanMs = Date.now() - scanStarted;
            let clockNow = Math.max(time.nowSeconds(), ((await adapter.get("yotick/meta")) || {}).lastMonotonicSec || 0);
            const service = serviceModule.createService(adapter, { clock: () => clockNow });
            const initStarted = Date.now();
            const initialized = await service.init();
            const serviceInitMs = Date.now() - initStarted;
            if (!initialized || !initialized.ok) throw Object.assign(new Error("Reopened service init failed"), { code: initialized && initialized.error && initialized.error.code });
            const existingFact = await adapter.get("yotick/s/00000000-0000-4000-8000-0000000003e9");
            if (!existingFact || existingFact.status !== "COMPLETED" || existingFact.pauses.length !== 2)
              throw Object.assign(new Error("Could not read back the seeded durable sample"), { code: "SCALE_READBACK_MISMATCH" });
            let statisticsMeasurement = null;
            if (measureStatistics) {
              const base = 1700000000;
              const lastEnd = base + 9999 * 1800 + 1710;
              const startDate = time.dayKey(base);
              const endDate = time.dayKey(lastEnd - 1);
              const statisticsStarted = Date.now();
              const stats = await service.getStatistics({ startDate, endDate, mode: "completed" });
              const statisticsMs = Date.now() - statisticsStarted;
              if (!stats || !stats.ok || stats.data.totalSeconds !== 15000000)
                throw Object.assign(new Error("Reopened custom range total did not match the seeded facts"), { code: "SCALE_STATS_MISMATCH" });
              statisticsMeasurement = { elapsedMs: statisticsMs, totalSeconds: stats.data.totalSeconds, startDate, endDate };
            }
            const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); });
            const timingsMs = {};
            const doAction = async (name, fn) => {
              const t0 = Date.now();
              const result = await fn();
              timingsMs[name] = Date.now() - t0;
              if (!result || !result.ok) throw Object.assign(new Error(name + " action failed"), { code: result && result.error && result.error.code });
              return result;
            };
            clockNow++;
            const start = await doAction("start", () => service.start({ operationId: uuid(), projectId: "00000000-0000-4000-8000-000000000002" }));
            const sessionId = start.data.sessionId;
            clockNow++;
            await doAction("pause", () => service.pause({ operationId: uuid(), sessionId }));
            clockNow++;
            await doAction("resume", () => service.resume({ operationId: uuid(), sessionId }));
            clockNow++;
            await doAction("stop", () => service.stop({ operationId: uuid(), sessionId }));
            const actionFact = await adapter.get("yotick/s/" + sessionId);
            if (!actionFact || actionFact.status !== "COMPLETED" || actionFact.pauses.length !== 1)
              throw Object.assign(new Error("Reopened action facts were not durable"), { code: "SCALE_ACTION_READBACK_MISMATCH" });
            state.phase = "complete";
            state.done = 1;
            state.result = {
              namespace, basePath, previousRun: previous && previous.result || null,
              reopeningMeasurement: { classification: "new-file-adapter-index-scan-and-service-init", indexScanMs, serviceInitMs, fullCustomRangeStatistics: statisticsMeasurement, actionPersistenceMs: timingsMs, durableSeedReadback: true, durableActionReadback: true, reopenedFileTierBytes: capacity.usedBytes, fileTierLimitBytes: capacity.limitBytes },
              sampleRetained: true,
              environment: { measurement: "WeChat DevTools wx file tier; not a phone performance result", backendConnected: false, rawAdapter: "new isolated memory adapter; persistent facts loaded from the file tier" },
            };
          } catch (error) {
            state.phase = "failed";
            state.result = { namespace, sampleRetained: true, error: { message: String(error && error.message || error), code: error && error.code || null } };
          }
        })();
      }, { namespace: resumeNamespace, measureStatistics });
      let lastProgress = "";
      while (Date.now() - startedAt < maxRunMs) {
        await delay(progressIntervalMs);
        const status = await mp.evaluate(() => getApp().globalData._yotickScaleColdRun || null);
        if (!status) throw new Error("Reopen measurement state disappeared");
        const key = `${status.phase}:${status.done}/${status.total}`;
        if (key !== lastProgress) {
          console.log(JSON.stringify({ phase: status.phase, done: status.done, total: status.total }));
          lastProgress = key;
        }
        if (status.result) {
          const evidencePath = path.join(artifactRoot, "devtools-scale-reopen-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
          const evidence = { capturedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, ...status.result };
          fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
          console.log(JSON.stringify({ evidencePath, result: evidence }));
          if (status.phase === "failed") process.exitCode = 1;
          return;
        }
      }
      throw new Error("Reopen measurement exceeded 15 minutes; sample files are retained");
    }

    await mp.evaluate(async () => {
      const app = getApp();
      app.globalData._yotickScaleRun = { phase: "starting", done: 0, total: 0, result: null };
      (async () => {
        const state = app.globalData._yotickScaleRun;
        try {
          const serviceModule = require("core/service.js");
          const fileModule = require("storage/file-adapter.js");
          const accountModule = require("storage/account-adapter.js");
          const adapterModule = require("storage/adapter.js");
          const time = require("core/time.js");
          const randomUUID = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === "x" ? r : (r & 3 | 8)).toString(16);
          });
          const suffix = randomUUID();
          const namespace = "scale-acceptance-" + suffix;
          const basePath = wx.env.USER_DATA_PATH + "/yotick-acceptance-" + suffix;
          const raw = adapterModule.createMemoryAdapter();
          const fileTier = fileModule.createFileTierAdapter(raw, wx, { basePath });
          const makeAdapter = () => accountModule.createAccountAdapter(fileTier, namespace);
          let clockNow = time.nowSeconds();
          const makeService = () => serviceModule.createService(makeAdapter(), { clock: () => clockNow });
          state.namespace = namespace;
          state.phase = "initializing";
          const initService = makeService();
          const initialized = await initService.init();
          if (!initialized || !initialized.ok) throw Object.assign(new Error("Initial service setup failed"), { code: initialized && initialized.error && initialized.error.code });
          const adapter = makeAdapter();
          const meta = await adapter.get("yotick/meta");
          const base = 1700000000;
          const id = n => "00000000-0000-4000-8000-" + n.toString(16).padStart(12, "0");
          const projects = {};
          for (let i = 0; i < 500; i++) {
            const projectId = id(i + 1);
            projects[projectId] = { id: projectId, spaceId: meta.id, name: "样本项目 " + (i + 1), parentId: i ? id(1) : null, archived: false, creationOrder: i + 1, revision: 1, color: "#425B42", shortName: "", lastUsedAtSec: null, createdAtSec: base, updatedAtSec: base };
          }
          await adapter.set("yotick/projects", projects);
          const prefs = await initService.getPrefs();
          await adapter.set("yotick/prefs", Object.assign({ startupMode: "remember", defaultMinutes: 30, commonMinutes: [15, 30, 45, 60] }, prefs || {}));
          const dayIndexes = {};
          const projectIndexes = {};
          state.phase = "seeding";
          state.total = 10000;
          for (let i = 0; i < 10000; i++) {
            const started = base + i * 1800;
            const sessionId = id(1001 + i);
            const projectId = id(2 + i % 499);
            const session = { id: sessionId, spaceId: meta.id, projectId, startedAtSec: started, endedAtSec: started + 1710, durationSeconds: 1500, targetSeconds: 1800, status: "COMPLETED", createdAtSec: started, updatedAtSec: started + 1710, revision: 1, pauses: [
              { id: id(20001 + i * 2), sessionId, startedAtSec: started + 300, endedAtSec: started + 390, durationSeconds: 90, status: "COMPLETED", createdAtSec: started + 300 },
              { id: id(20002 + i * 2), sessionId, startedAtSec: started + 800, endedAtSec: started + 920, durationSeconds: 120, status: "COMPLETED", createdAtSec: started + 800 },
            ] };
            await adapter.set("yotick/s/" + sessionId, session);
            const first = time.dayIndex(started);
            const last = time.dayIndex(session.endedAtSec - 1);
            for (let day = first; day <= last; day++) {
              const key = time.dayKey(time.dayStartByIndex(day));
              (dayIndexes[key] || (dayIndexes[key] = [])).push(sessionId);
            }
            (projectIndexes[projectId] || (projectIndexes[projectId] = [])).push(sessionId);
            if ((i + 1) % 100 === 0) state.done = i + 1;
          }
          for (const day of Object.keys(dayIndexes)) await adapter.set("yotick/d/" + day, dayIndexes[day]);
          for (const projectId of Object.keys(projectIndexes)) await adapter.set("yotick/p/" + projectId, projectIndexes[projectId]);
          state.phase = "measuring";
          state.done = 0;
          const allDates = Object.keys(dayIndexes).sort();
          const makeFresh = async () => {
            const service = makeService();
            const t0 = Date.now();
            const result = await service.init();
            const ms = Date.now() - t0;
            if (!result || !result.ok) throw Object.assign(new Error("Cold service init failed"), { code: result && result.error && result.error.code });
            return { service, ms };
          };
          const serviceReinit = [];
          const statistics = [];
          for (let i = 0; i < 3; i++) {
            const fresh = await makeFresh();
            serviceReinit.push(fresh.ms);
            const t0 = Date.now();
            const stats = await fresh.service.getStatistics({ startDate: allDates[0], endDate: allDates[allDates.length - 1], mode: "completed" });
            statistics.push(Date.now() - t0);
            if (!stats.ok || stats.data.totalSeconds !== 15000000) throw Object.assign(new Error("Custom range totals did not match the seeded facts"), { code: "SCALE_STATS_MISMATCH" });
            state.done = i + 1;
          }
          const actionMs = { start: [], pause: [], resume: [], stop: [] };
          for (let i = 0; i < 3; i++) {
            const fresh = await makeFresh();
            const projectId = id(2 + i);
            const measure = async (name, fn) => {
              const t0 = Date.now();
              const result = await fn();
              const elapsed = Date.now() - t0;
              if (!result || !result.ok) throw Object.assign(new Error(name + " action failed"), { code: result && result.error && result.error.code });
              actionMs[name].push(elapsed);
              return result;
            };
            clockNow++;
            const start = await measure("start", () => fresh.service.start({ operationId: randomUUID(), projectId }));
            const sessionId = start.data.sessionId;
            clockNow++;
            await measure("pause", () => fresh.service.pause({ operationId: randomUUID(), sessionId }));
            clockNow++;
            await measure("resume", () => fresh.service.resume({ operationId: randomUUID(), sessionId }));
            clockNow++;
            await measure("stop", () => fresh.service.stop({ operationId: randomUUID(), sessionId }));
            const persisted = await makeAdapter().get("yotick/s/" + sessionId);
            if (!persisted || persisted.status !== "COMPLETED" || persisted.pauses.length !== 1) throw Object.assign(new Error("Completed action facts were not durable"), { code: "SCALE_PERSISTENCE_MISMATCH" });
            state.done = i + 1;
          }
          const capacity = await fileTier.capacity();
          state.phase = "complete";
          state.result = {
            namespace, basePath, sample: { projects: 500, sessions: 10000, pauses: 20000, totalSeconds: 15000000, touchedDays: allDates.length },
            timingsMs: { serviceReinit: { medianMs: serviceReinit.slice().sort((a,b)=>a-b)[1], maxMs: Math.max(...serviceReinit), samplesMs: serviceReinit }, fullCustomRangeStatistics: { medianMs: statistics.slice().sort((a,b)=>a-b)[1], maxMs: Math.max(...statistics), samplesMs: statistics }, actions: Object.fromEntries(Object.keys(actionMs).map(name => [name, { medianMs: actionMs[name].slice().sort((a,b)=>a-b)[1], maxMs: Math.max(...actionMs[name]), samplesMs: actionMs[name] }])) },
            durableReadback: true, fileTierBytes: capacity.usedBytes, fileTierLimitBytes: capacity.limitBytes,
            environment: { measurement: "WeChat DevTools wx file tier; not a phone performance result", backendConnected: false, rawAdapter: "isolated memory adapter; facts routed to file tier" },
          };
        } catch (error) {
          state.phase = "failed";
          state.result = { error: { message: String(error && error.message || error), code: error && error.code || null }, sampleRetained: true, namespace: state.namespace || null };
        }
      })();
    });
    let lastProgress = "";
    while (Date.now() - startedAt < maxRunMs) {
      await delay(progressIntervalMs);
      const status = await mp.evaluate(() => {
        const s = getApp().globalData._yotickScaleRun;
        return s ? { phase: s.phase, done: s.done, total: s.total, result: s.result } : null;
      });
      if (!status) throw new Error("Scale run progress state disappeared");
      const key = `${status.phase}:${status.done}/${status.total}`;
      if (key !== lastProgress) {
        console.log(JSON.stringify({ phase: status.phase, done: status.done, total: status.total }));
        lastProgress = key;
      }
      if (status.result) {
        const evidencePath = path.join(artifactRoot, "devtools-scale-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
        const evidence = { capturedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, ...status.result };
        fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
        console.log(JSON.stringify({ evidencePath, result: evidence }));
        if (status.phase === "failed") process.exitCode = 1;
        return;
      }
    }
    throw new Error("Scale run exceeded 15 minutes; sample files are retained");
  } finally {
    mp.disconnect();
    clearTimeout(deadline);
  }
})().catch(error => {
  clearTimeout(deadline);
  console.error(JSON.stringify({ error: { message: error.message, code: error.code || null } }));
  process.exitCode = 1;
});
