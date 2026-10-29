// core/service.js
// 应用服务：页面唯一的业务入口。
// - 命令在串行队列中执行；命令携带 operationId（幂等）与 expectedDataRevision（防过期）；
// - 所有命令与查询快照前先统一惰性结算到期倒计时（D01）；
// - 命令遵循“准备（只读拷贝）→ 提交描述与事实 → 生效内存”，描述未落盘绝不改事实；
// - 返回统一信封 { ok, data/error, dataRevision, asOfSec }（补充规格 §3.4）。

const idsMod = require("./ids");
const time = require("./time");
const ranges = require("./ranges");
const timer = require("./timer");
const treeMod = require("./tree");
const statistics = require("./statistics");
const repo = require("./repository");
const { readInBatches } = require("./bounded-read");

const SCHEMA_VERSION = 1;
const CLOCK_BACK_TOLERANCE = 60; // 回退超过 60 秒视为时钟异常
const CLOCK_FORWARD_TOLERANCE = 86400 * 400; // 向前跳超过 400 天提示

function coded(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) e.extra = extra;
  return e;
}

function deepClone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function spaceReadErrorMessage(error) {
  // Keep platform storage failures actionable without exposing saved values or paths.
  const code = error && (error.code || error.errCode || error.errno);
  const codeText = code !== undefined && /^[A-Za-z0-9_-]{1,32}$/.test(String(code))
    ? String(code) : "";
  const platform = String((error && error.errMsg) || "");
  const match = platform.match(/^(?:getStorage|readFile|readdir|stat):fail[^,\r\n]*/);
  const reason = match ? match[0]
    .replace(/(?:wxfile|https?):\/\/\S+|[A-Za-z]:[\\/]\S+|\/\S+/g, "[path]")
    .slice(0, 120) : "";
  const detail = [codeText, reason].filter(Boolean).join("：");
  return "空间信息无法读取" + (detail ? "（" + detail + "）" : "");
}

function createService(adapter, options) {
  options = options || {};
  const clock = options.clock || time.nowSeconds;
  const genId = options.genId || idsMod.uuid;

  const state = {
    blocked: null,
    meta: null,
    projects: {},
    active: null,
    prefs: null,
    dayCache: {},
    projSessionCache: {},
    highWater: 0,
    lastNow: 0,
    clockAnomaly: null,
    operationResults: new Map(),
    recoveredOperations: new Map(),
    notices: [],
  };

  let queue = Promise.resolve();
  let syncEpoch = 0;
  let retired = false;
  function enqueue(fn) {
    const run = queue.then(() => fn());
    queue = run.catch(() => undefined);
    return run;
  }

  // ---------------- 信封 ----------------
  function okEnvelope(data) {
    return {
      ok: true,
      data: data,
      dataRevision: state.meta ? state.meta.dataRevision : 0,
      asOfSec: (data && data.asOfSec) || state.lastNow,
    };
  }

  function failEnvelope(code, message, extra) {
    return {
      ok: false,
      error: Object.assign({ code: code, message: message }, extra || {}),
      dataRevision: state.meta ? state.meta.dataRevision : 0,
    };
  }

  // ---------------- 时钟 ----------------
  function nowSnapshot() {
    const now = clock();
    const hw =
      state.highWater || (state.meta && state.meta.lastMonotonicSec) || now;
    if (now + CLOCK_BACK_TOLERANCE < hw) {
      state.clockAnomaly = { type: "backward", seconds: hw - now, atSec: now };
    } else if (now - hw > CLOCK_FORWARD_TOLERANCE) {
      state.clockAnomaly = { type: "forward", seconds: now - hw, atSec: now };
    }
    if (now > state.highWater) state.highWater = now;
    state.lastNow = now;
    return now;
  }

  // 在拷贝上准备版本递增的 meta（不触碰 state.meta）
  function bumpedMeta(now) {
    return Object.assign({}, state.meta, {
      dataRevision: state.meta.dataRevision + 1,
      lastMonotonicSec: Math.max(
        state.meta.lastMonotonicSec || 0,
        state.highWater,
        now,
      ),
    });
  }
  function applyMeta(newMeta) {
    const keys = Object.keys(newMeta);
    for (let i = 0; i < keys.length; i++)
      state.meta[keys[i]] = newMeta[keys[i]];
  }

  // ---------------- 形状校验（DATA_CORRUPT 防线） ----------------
  function validateMetaShape(m) {
    if (!m || typeof m !== "object") return "空间信息损坏";
    if (typeof m.id !== "string" || !m.id) return "空间标识缺失";
    if (!Number.isInteger(m.schemaVersion)) return "schemaVersion 异常";
    if (!Number.isInteger(m.dataRevision)) return "dataRevision 异常";
    if (m.utcOffsetMinutes !== 480) return "时区配置异常";
    return null;
  }

  function validateProject(p) {
    if (!p || typeof p !== "object") return "项目数据损坏";
    if (typeof p.id !== "string") return "项目 ID 异常";
    if (typeof p.name !== "string") return "项目名称异常";
    if (p.color != null && !/^#[0-9a-f]{6}$/i.test(p.color))
      return "项目颜色异常";
    if (
      p.shortName != null &&
      (typeof p.shortName !== "string" || Array.from(p.shortName).length > 8)
    )
      return "项目简称异常";
    if (typeof p.archived !== "boolean") return "项目归档状态异常";
    if (!Number.isInteger(p.creationOrder)) return "creationOrder 异常";
    if (p.parentId !== null && typeof p.parentId !== "string")
      return "父项目字段异常";
    if (!Number.isInteger(p.revision)) return "项目 revision 异常";
    return null;
  }

  function validateRegistry(projects) {
    if (!projects || typeof projects !== "object") return "项目注册表损坏";
    const names = new Map();
    const ids = Object.keys(projects);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const e = validateProject(projects[id]);
      if (e) return e;
      const p = projects[id];
      if (p.id !== id) return "项目 ID 与键不一致";
      if (names.has(p.name)) return "存在重名项目（数据损坏）";
      names.set(p.name, id);
    }
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const p = projects[id];
      if (p.parentId !== null) {
        if (!projects[p.parentId]) return "父项目缺失（数据损坏）";
        const seen = new Set();
        let cur = id;
        while (cur) {
          if (seen.has(cur)) return "项目树存在环（数据损坏）";
          seen.add(cur);
          const node = projects[cur];
          if (!node) break;
          cur = node.parentId;
        }
      }
    }
    return null;
  }

  function validateSession(s) {
    if (!s || typeof s !== "object") return "会话数据损坏";
    if (typeof s.id !== "string") return "会话 ID 异常";
    if (s.status !== "ACTIVE" && s.status !== "COMPLETED")
      return "会话状态异常";
    if (!Number.isInteger(s.startedAtSec)) return "开始时间异常";
    if (!state.projects[s.projectId]) return "会话所属项目缺失（数据损坏）";
    if (!Array.isArray(s.pauses)) return "暂停数据异常";
    if (s.status === "COMPLETED") {
      if (!Number.isInteger(s.endedAtSec)) return "结束时间异常";
      if (!Number.isInteger(s.durationSeconds)) return "结算时长异常";
    }
    for (let i = 0; i < s.pauses.length; i++) {
      const p = s.pauses[i];
      if (typeof p.id !== "string") return "暂停 ID 异常";
      if (p.status !== "ACTIVE" && p.status !== "COMPLETED")
        return "暂停状态异常";
      if (!Number.isInteger(p.startedAtSec)) return "暂停开始时间异常";
      if (p.status === "COMPLETED" && !Number.isInteger(p.durationSeconds))
        return "暂停时长异常";
    }
    return null;
  }

  // ---------------- 日/项目索引 ----------------
  async function loadDayIndex(dk) {
    if (!Object.prototype.hasOwnProperty.call(state.dayCache, dk)) {
      let arr;
      try {
        arr = await adapter.get(repo.dayIndexKey(dk));
      } catch (e) {
        throw coded("DATA_CORRUPT", "日索引无法读取：" + dk);
      }
      if (arr !== undefined && !Array.isArray(arr)) {
        const repairEnv = await repairLocalDataInternal();
        if (!repairEnv.ok) throw coded("DATA_CORRUPT", "日索引损坏且重建失败");
        arr = state.dayCache[dk] || [];
      }
      state.dayCache[dk] = arr || [];
    }
    return state.dayCache[dk];
  }

  // 在拷贝上准备会话跨度的日索引（不触碰缓存）
  async function prepareSpan(sessionLike) {
    const first = time.dayIndex(sessionLike.startedAtSec);
    const last = time.dayIndex(
      Math.max(sessionLike.startedAtSec, sessionLike.endedAtSec - 1),
    );
    const updates = [];
    for (let i = first; i <= last; i++) {
      const dk = time.dayKeyOfIndex(i);
      const arr = (await loadDayIndex(dk)).slice();
      if (arr.indexOf(sessionLike.id) === -1) {
        arr.push(sessionLike.id);
        arr.sort();
      }
      updates.push({ dk: dk, arr: arr });
    }
    return {
      ops: updates.map((u) => ({
        t: "set",
        k: repo.dayIndexKey(u.dk),
        v: u.arr,
      })),
      apply() {
        for (let i = 0; i < updates.length; i++)
          state.dayCache[updates[i].dk] = updates[i].arr.slice();
      },
    };
  }

  async function prepareProjectIndex(pid, sid) {
    const arr = (
      (await adapter.get(repo.projectSessionsKey(pid))) || []
    ).slice();
    if (arr.indexOf(sid) === -1) arr.push(sid);
    return {
      op: { t: "set", k: repo.projectSessionsKey(pid), v: arr },
      apply() {
        state.projSessionCache[pid] = arr.slice();
      },
    };
  }

  // ---------------- 提交协议 ----------------
  async function persist(operationId, ops, remote) {
    if (retired) throw coded("SPACE_CHANGED", "账号已切换，请刷新后重试");
    syncEpoch++;
    const syncOps =
      remote || options.syncEnabled === false
        ? []
        : await require("../sync/local").prepareOutbox(
            adapter,
            ops,
            state.projects,
            state.prefs,
          );
    const safeOps = ops.concat(syncOps).map((op) => ({
      t: op.t,
      k: op.k,
      v: op.t === "set" ? deepClone(op.v) : undefined,
    }));
    const desc = {
      operationId: operationId,
      baseRevision: state.meta.dataRevision,
      capturedAtSec: state.lastNow,
      ops: safeOps,
    };
    let stage = "descriptor";
    try {
      await adapter.set(repo.commitKey(operationId), desc);
      stage = "ops";
      for (let i = 0; i < safeOps.length; i++) {
        const op = safeOps[i];
        if (op.t === "set") await adapter.set(op.k, op.v);
        else await adapter.remove(op.k);
      }
      stage = "cleanup";
      await adapter.remove(repo.commitKey(operationId));
      if (syncOps.length && options.onLocalCommit)
        setTimeout(() => options.onLocalCommit(), 0);
      return "committed";
    } catch (e) {
      if (stage === "descriptor") {
        throw coded("STORAGE_WRITE_FAILED", "保存失败，请重试");
      }
      try {
        const rec = await repo.recoverCommits(adapter);
        registerRecovered(rec);
        await reloadFromStorage();
        return "recovered";
      } catch (e2) {
        state.blocked = {
          code: "RECOVERY_REQUIRED",
          message: "本地数据恢复未完成，请重启应用",
        };
        try {
          await reloadFromStorage();
        } catch (e3) {}
        throw coded("RECOVERY_REQUIRED", "本地数据恢复未完成，请重启应用");
      }
    }
  }

  function registerRecovered(descs) {
    for (let i = 0; i < descs.length; i++) {
      const d = descs[i];
      if (d && d.operationId) state.recoveredOperations.set(d.operationId, d);
    }
  }

  // 已存在 meta 时，只有“从未写过任何事实的全新空间”（版本未递增、创建序号未推进）
  // 才允许项目注册表缺键；其他情况一律视为损坏，阻断而不是静默清空。
  function registryMayBeAbsent(meta) {
    return meta.dataRevision === 0 && meta.nextCreationOrder === 1;
  }

  async function loadProjectsFact(meta) {
    let projects;
    try {
      projects = await adapter.get(repo.PROJECTS);
    } catch (e) {
      throw coded("DATA_CORRUPT", "项目注册表无法读取");
    }
    if (projects === undefined) {
      if (registryMayBeAbsent(meta)) return {};
      throw coded("DATA_CORRUPT", "项目注册表缺失（数据损坏）");
    }
    const pe = validateRegistry(projects);
    if (pe) throw coded("DATA_CORRUPT", pe);
    return projects;
  }

  // 加载 meta 指向的活动会话事实。
  // - ACTIVE 且校验通过：恢复活动状态；
  // - 非 ACTIVE（结束流程中断的孤儿会话，L04）：交由调用方补索引后清指针；
  // - 事实缺失/读取失败/ACTIVE 损坏：抛出 DATA_CORRUPT，保留原始数据并阻断，
  //   绝不静默把活动状态清空。
  async function loadActiveFact(meta) {
    let s;
    try {
      s = await adapter.get(repo.sessionKey(meta.activeSessionId));
    } catch (e) {
      throw coded("DATA_CORRUPT", "当前会话无法读取");
    }
    if (s === undefined)
      throw coded("DATA_CORRUPT", "当前会话缺失（数据损坏）");
    if (s.status !== "ACTIVE")
      return { session: s, active: null, completedOrphan: true };
    const se = validateSession(s);
    if (se) throw coded("DATA_CORRUPT", se);
    return { session: s, active: s, completedOrphan: false };
  }

  async function reloadFromStorage() {
    let meta;
    try {
      meta = await adapter.get(repo.META);
    } catch (e) {
      throw coded("DATA_CORRUPT", spaceReadErrorMessage(e));
    }
    if (!meta) throw coded("DATA_CORRUPT", "空间信息缺失");
    const me = validateMetaShape(meta);
    if (me) throw coded("DATA_CORRUPT", me);
    state.meta = meta;
    state.projects = await loadProjectsFact(meta);
    state.active = null;
    if (meta.activeSessionId) {
      const loaded = await loadActiveFact(meta);
      if (loaded.completedOrphan) {
        // 结束流程中断的孤儿会话在恢复路径下无法当场补索引：阻断，重启后由 init L04 流程修复
        throw coded("DATA_CORRUPT", "存在未完成结算的会话，请重启应用");
      }
      state.active = loaded.active;
    }
  }

  // ---------------- 取数 ----------------
  async function loadSessionById(id) {
    if (state.active && state.active.id === id) return state.active;
    return adapter.get(repo.sessionKey(id));
  }

  async function sessionsForRange(range) {
    const indices = ranges.dayIndicesOf(range);
    const idSet = new Set();
    for (let i = 0; i < indices.length; i++) {
      const arr = await loadDayIndex(time.dayKeyOfIndex(indices[i]));
      for (let j = 0; j < arr.length; j++) idSet.add(arr[j]);
    }
    if (state.active) idSet.add(state.active.id);
    const out = [];
    const ids = Array.from(idSet);
    const loaded = await readInBatches(ids, loadSessionById);
    for (const s of loaded) {
      if (s) out.push(s);
    }
    return out;
  }

  function resolveRange(spec) {
    spec = spec || {};
    const now = nowSnapshot();
    if (spec.preset === "today") return ranges.rangeToday(now);
    if (spec.preset === "last7") return ranges.rangeLastNDays(now, 7);
    if (spec.preset === "last30") return ranges.rangeLastNDays(now, 30);
    if (spec.startDate && spec.endDate) {
      return ranges.rangeCustom(spec.startDate, spec.endDate);
    }
    return ranges.rangeToday(now);
  }

  // ---------------- 当前快照 ----------------
  function currentData() {
    const now = nowSnapshot();
    const s = state.active;
    if (!s) {
      const lastId = state.prefs && state.prefs.lastProjectId;
      const last = lastId ? state.projects[lastId] : null;
      const usable = last && !last.archived;
      return {
        state: "IDLE",
        sessionId: null,
        projectId: usable ? last.id : null,
        projectName: usable ? last.name : null,
        mode: "stopwatch",
        elapsedSeconds: 0,
        remainingSeconds: null,
        clockAnomaly: state.clockAnomaly,
        asOfSec: now,
      };
    }
    const ap = timer.getActivePause(s);
    const elapsed = timer.netSeconds(s, now);
    return {
      state: ap ? "PAUSED" : "STUDYING",
      sessionId: s.id,
      projectId: s.projectId,
      projectName: (state.projects[s.projectId] || {}).name || "未知项目",
      mode: s.targetSeconds == null ? "stopwatch" : "countdown",
      targetSeconds: s.targetSeconds,
      startedAtSec: s.startedAtSec,
      elapsedSeconds: elapsed,
      remainingSeconds:
        s.targetSeconds == null ? null : Math.max(0, s.targetSeconds - elapsed),
      pauseCount: s.pauses.length,
      closedPauseSeconds: timer.closedPauseSeconds(s),
      activePauseStartedAtSec: ap ? ap.startedAtSec : null,
      clockAnomaly: state.clockAnomaly,
      asOfSec: now,
    };
  }

  // ---------------- 到期结算 ----------------
  async function settleInternal() {
    const now = nowSnapshot();
    const s = state.active;
    if (s && timer.isExpired(s, now)) {
      const sCopy = deepClone(s);
      Object.assign(sCopy, timer.settleResult(sCopy));
      sCopy.updatedAtSec = now;
      sCopy.revision = (sCopy.revision || 1) + 1;

      const span = await prepareSpan(sCopy);
      const newMeta = bumpedMeta(now);
      newMeta.activeSessionId = null;
      const ops = [{ t: "set", k: repo.sessionKey(sCopy.id), v: sCopy }]
        .concat(span.ops)
        .concat([{ t: "set", k: repo.META, v: newMeta }]);
      await persist("system:settle:" + sCopy.id, ops);

      span.apply();
      applyMeta(newMeta);
      state.notices.push({
        sessionId: sCopy.id,
        projectId: sCopy.projectId,
        durationSeconds: sCopy.durationSeconds,
        endedAtSec: sCopy.endedAtSec,
        auto: true,
      });
      state.active = null;
      state.lastNow = nowSnapshot();
      return sCopy.id;
    }
    return null;
  }

  // 启动时 ACTIVE 会话补登索引
  async function reconcileActive(s) {
    const now = nowSnapshot();
    const span = await prepareSpan({
      id: s.id,
      startedAtSec: s.startedAtSec,
      endedAtSec: now + 1,
    });
    if (span.ops.length) {
      await persist("system:reconcile:" + s.id, span.ops);
      span.apply();
    }
  }

  // ---------------- 初始化 ----------------
  async function init() {
    return enqueue(async () => {
      // 重新初始化即一次完整重校验：成功路径必须清掉历史阻断标记，
      // 否则修复存储后重跑 init 仍会被旧的 state.blocked 永久拦截。
      state.blocked = null;
      try {
        const rec = await repo.recoverCommits(adapter);
        registerRecovered(rec);
      } catch (e) {
        state.blocked = {
          code: "RECOVERY_REQUIRED",
          message: "未完成提交恢复失败",
        };
        return failEnvelope(
          "RECOVERY_REQUIRED",
          "未完成提交恢复失败，请重启应用",
        );
      }

      let meta;
      try {
        meta = await adapter.get(repo.META);
      } catch (e) {
        const message = spaceReadErrorMessage(e);
        state.blocked = { code: "DATA_CORRUPT", message };
        return failEnvelope("DATA_CORRUPT", message);
      }

      if (meta === undefined) {
        const now = clock();
        meta = {
          id: genId(),
          schemaVersion: SCHEMA_VERSION,
          dataRevision: 0,
          utcOffsetMinutes: 480,
          activeSessionId: null,
          nextCreationOrder: 1,
          lastMonotonicSec: now,
          createdAtSec: now,
        };
        try {
          await adapter.set(repo.META, meta);
        } catch (e) {
          return failEnvelope("STORAGE_WRITE_FAILED", "初始化写入失败");
        }
      } else {
        const e0 = validateMetaShape(meta);
        if (e0) {
          state.blocked = { code: "DATA_CORRUPT", message: e0 };
          return failEnvelope("DATA_CORRUPT", e0);
        }
        if (meta.schemaVersion > SCHEMA_VERSION) {
          state.blocked = { code: "DATA_CORRUPT", message: "数据版本不受支持" };
          return failEnvelope("DATA_CORRUPT", "数据版本不受支持，请升级应用");
        }
      }
      state.meta = meta;

      try {
        state.projects = await loadProjectsFact(meta);
      } catch (e) {
        state.blocked = { code: e.code || "DATA_CORRUPT", message: e.message };
        return failEnvelope(e.code || "DATA_CORRUPT", e.message);
      }

      try {
        state.prefs = (await adapter.get(repo.PREFS)) || null;
      } catch (e) {
        state.blocked = {
          code: "DATA_CORRUPT",
          message: "偏好事实无法读取，原资料已保留",
        };
        return failEnvelope(state.blocked.code, state.blocked.message);
      }
      state.highWater = meta.lastMonotonicSec || 0;

      if (meta.activeSessionId) {
        let loaded;
        try {
          loaded = await loadActiveFact(meta);
        } catch (e) {
          state.blocked = {
            code: e.code || "DATA_CORRUPT",
            message: e.message,
          };
          return failEnvelope(e.code || "DATA_CORRUPT", e.message);
        }
        if (loaded.completedOrphan) {
          // L04：会话事实已写入但 meta 指针未清——先补索引再清指针
          const s = loaded.session;
          try {
            const se = validateSession(s);
            if (!se) {
              const endRef =
                s.endedAtSec != null ? s.endedAtSec : s.startedAtSec;
              const span = await prepareSpan({
                id: s.id,
                startedAtSec: s.startedAtSec,
                endedAtSec: endRef,
              });
              const pidx = await prepareProjectIndex(s.projectId, s.id);
              const newMeta = Object.assign({}, meta, {
                activeSessionId: null,
              });
              const ops = span.ops.concat([
                pidx.op,
                { t: "set", k: repo.META, v: newMeta },
              ]);
              await persist("system:recover-index:" + s.id, ops);
              span.apply();
              pidx.apply();
              applyMeta(newMeta);
            } else {
              // 孤儿会话本身损坏：阻断，保留原始数据
              state.blocked = { code: "DATA_CORRUPT", message: se };
              return failEnvelope("DATA_CORRUPT", se);
            }
          } catch (e) {
            // 补索引失败：阻断并保留原始数据，等待重启恢复（不静默清指针）
            state.blocked = {
              code: e.code || "RECOVERY_REQUIRED",
              message: e.message,
            };
            return failEnvelope(e.code || "RECOVERY_REQUIRED", e.message);
          }
        } else {
          state.active = loaded.active;
          const s = loaded.session;
          try {
            await reconcileActive(s);
          } catch (e) {}
        }
      }

      nowSnapshot();
      await settleInternal();
      return okEnvelope(currentData());
    });
  }

  // ---------------- 命令通用包装 ----------------
  function command(kind, input, handler) {
    return enqueue(async () => {
      if (state.blocked)
        return failEnvelope(state.blocked.code, state.blocked.message);
      const opId = input && input.operationId;
      if (!opId) return failEnvelope("INVALID_OPERATION", "缺少 operationId");
      if (state.operationResults.has(opId))
        return state.operationResults.get(opId);
      if (state.recoveredOperations.has(opId)) {
        const env = await recoveredEnvelope(
          kind,
          state.recoveredOperations.get(opId),
          input,
        );
        state.operationResults.set(opId, env);
        return env;
      }
      if (
        input.expectedDataRevision != null &&
        input.expectedDataRevision !== state.meta.dataRevision
      ) {
        const env = failEnvelope("STALE_COMMAND", "数据已变化，请刷新后重试");
        state.operationResults.set(opId, env);
        return env;
      }
      let data;
      try {
        data = await handler();
      } catch (e) {
        const env = failEnvelope(e.code || "INTERNAL", e.message, e.extra);
        if (
          ![
            "STORAGE_WRITE_FAILED",
            "RECOVERY_REQUIRED",
            "RETRYABLE_ERROR",
          ].includes(e.code)
        )
          state.operationResults.set(opId, env);
        return env;
      }
      const env = okEnvelope(data);
      state.operationResults.set(opId, env);
      return env;
    });
  }

  function findSessionIdInDesc(desc) {
    for (let i = 0; i < desc.ops.length; i++) {
      const op = desc.ops[i];
      if (op.t === "set" && op.k.indexOf("yotick/s/") === 0) {
        return op.k.slice("yotick/s/".length);
      }
    }
    return null;
  }

  async function recoveredEnvelope(kind, desc, input) {
    if (kind === "reduceSessionDuration") {
      const saved = desc.ops.find(op => op.t === "set" && op.k === repo.sessionKey(input.sessionId));
      if (!saved) return failEnvelope("RECOVERY_REQUIRED", "记录调整尚未完成");
      return okEnvelope({ sessionId: input.sessionId, durationSeconds: saved.v.durationSeconds,
        endedAtSec: saved.v.endedAtSec, recovered: true });
    }
    if (kind === "deleteSession") {
      const removed = desc.ops.find(
        (op) => op.t === "remove" && op.k === repo.sessionKey(input.sessionId),
      );
      if (!removed || (await adapter.get(removed.k)) !== undefined)
        return failEnvelope("RECOVERY_REQUIRED", "记录删除尚未完成");
      return okEnvelope({ deletedSessionId: input.sessionId, recovered: true });
    }
    if (kind === "updateProjectDetails") {
      const project = state.projects[input.projectId];
      return project
        ? okEnvelope({ project, recovered: true })
        : failEnvelope("RECOVERY_REQUIRED", "未找到恢复的项目");
    }
    if (kind === "createProject") {
      const name = (input.name || "").trim();
      const ids = Object.keys(state.projects);
      for (let i = 0; i < ids.length; i++) {
        if (state.projects[ids[i]].name === name) {
          return okEnvelope({
            project: state.projects[ids[i]],
            recovered: true,
          });
        }
      }
      return failEnvelope("RECOVERY_REQUIRED", "未找到恢复的项目");
    }
    const sid = input.sessionId || findSessionIdInDesc(desc);
    if (!sid) return failEnvelope("RECOVERY_REQUIRED", "未找到恢复的会话");
    let s;
    try {
      s = await adapter.get(repo.sessionKey(sid));
    } catch (e) {
      return failEnvelope("DATA_CORRUPT", "恢复的会话无法读取");
    }
    if (!s) return failEnvelope("RECOVERY_REQUIRED", "恢复的会话不存在");
    state.active = s.status === "ACTIVE" ? s : null;
    return okEnvelope(Object.assign(currentData(), { recovered: true }));
  }

  // ---------------- 项目命令 ----------------
  async function createProject(input) {
    return command("createProject", input, async () => {
      await settleInternal();
      const raw = input || {};
      const name = (raw.name || "").trim();
      if (!name) throw coded("INVALID_NAME", "项目名称不能为空");
      if (Array.from(name).length > 120)
        throw coded("INVALID_NAME", "项目名称最多 120 个字符");
      if (raw.newProjectId) {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            raw.newProjectId,
          )
        )
          throw coded("INVALID_PROJECT_ID", "项目标识不合法");
        const existing = state.projects[raw.newProjectId];
        if (existing) {
          if (
            existing.name !== name ||
            existing.parentId !== (raw.parentId || null)
          )
            throw coded("BACKUP_CONFLICT", "恢复项目标识内容冲突");
          return { project: existing, asOfSec: nowSnapshot() };
        }
      }
      const existIds = Object.keys(state.projects);
      for (let i = 0; i < existIds.length; i++) {
        if (state.projects[existIds[i]].name === name) {
          throw coded("NAME_EXISTS", "已存在同名项目（含已归档项目）", {
            existingId: existIds[i],
          });
        }
      }
      let parentId = null;
      if (raw.parentId) {
        const parent = state.projects[raw.parentId];
        if (!parent) throw coded("INVALID_PARENT", "所选父项目不存在");
        if (parent.archived)
          throw coded("INVALID_PARENT", "父项目已归档，无法在其下新建");
        parentId = raw.parentId;
      }
      const now = nowSnapshot();
      const id = raw.newProjectId || genId();
      const project = {
        id: id,
        spaceId: state.meta.id,
        name: name,
        parentId: parentId,
        archived: false,
        creationOrder: state.meta.nextCreationOrder,
        createdAtSec: now,
        updatedAtSec: now,
        revision: 1,
        color: require("../utils/color").colorOf(id),
        lastUsedAtSec: null,
      };
      const newProjects = Object.assign({}, state.projects);
      newProjects[id] = project;
      const newMeta = bumpedMeta(now);
      newMeta.nextCreationOrder = state.meta.nextCreationOrder + 1;

      await persist(input.operationId, [
        { t: "set", k: repo.PROJECTS, v: newProjects },
        { t: "set", k: repo.META, v: newMeta },
      ]);
      state.projects = newProjects;
      applyMeta(newMeta);
      return { project: project, asOfSec: now };
    });
  }

  async function renameProject(input) {
    return command("renameProject", input, async () => {
      await settleInternal();
      const id = input.projectId,
        old = state.projects[id];
      if (!old) throw coded("PROJECT_NOT_FOUND", "项目不存在");
      const name = String(input.name || "").trim();
      if (!name) throw coded("INVALID_NAME", "项目名称不能为空");
      if (Array.from(name).length > 120)
        throw coded("INVALID_NAME", "项目名称最多 120 个字符");
      if (
        Object.keys(state.projects).some(
          (otherId) => otherId !== id && state.projects[otherId].name === name,
        )
      )
        throw coded("NAME_EXISTS", "已存在同名项目（含已归档项目）");
      const now = nowSnapshot(),
        projects = Object.assign({}, state.projects);
      projects[id] = Object.assign({}, old, {
        name,
        updatedAtSec: now,
        revision: (old.revision || 1) + 1,
      });
      const meta = bumpedMeta(now);
      await persist(input.operationId, [
        { t: "set", k: repo.PROJECTS, v: projects },
        { t: "set", k: repo.META, v: meta },
      ]);
      state.projects = projects;
      applyMeta(meta);
      return { project: projects[id], asOfSec: now };
    });
  }

  async function setProjectAppearance(input) {
    return command("setProjectAppearance", input, async () => {
      await settleInternal();
      const id = input.projectId,
        old = state.projects[id];
      if (!old) throw coded("PROJECT_NOT_FOUND", "项目不存在");
      const color =
        input.color == null || input.color === ""
          ? null
          : String(input.color).toUpperCase();
      const shortName = String(input.shortName || "").trim();
      if (color && !/^#[0-9A-F]{6}$/.test(color))
        throw coded("INVALID_COLOR", "请选择有效颜色");
      if (Array.from(shortName).length > 8)
        throw coded("INVALID_SHORT_NAME", "简称最多 8 个字");
      const now = nowSnapshot(),
        projects = Object.assign({}, state.projects);
      projects[id] = Object.assign({}, old, {
        color,
        shortName,
        updatedAtSec: now,
        revision: (old.revision || 1) + 1,
      });
      const meta = bumpedMeta(now);
      await persist(input.operationId, [
        { t: "set", k: repo.PROJECTS, v: projects },
        { t: "set", k: repo.META, v: meta },
      ]);
      state.projects = projects;
      applyMeta(meta);
      if (color || old.color)
        require("../utils/color").setProjectColor(id, color);
      return { project: projects[id], asOfSec: now };
    });
  }

  // Save the editor's fields in one durable operation; failed validation must
  // never leave only the name or only the appearance changed.
  async function updateProjectDetails(input) {
    return command("updateProjectDetails", input, async () => {
      await settleInternal();
      const old = state.projects[input.projectId];
      if (!old) throw coded("PROJECT_NOT_FOUND", "项目不存在");
      const name = String(input.name || "").trim();
      const shortName = String(input.shortName || "").trim();
      const color = input.color == null || input.color === "" ? null : String(input.color).toUpperCase();
      if (!name || Array.from(name).length > 120) throw coded("INVALID_NAME", "项目名称须为 1 至 120 个字符");
      if (Object.values(state.projects).some(p => p.id !== old.id && p.name === name)) throw coded("NAME_EXISTS", "已存在同名项目（含已归档项目）");
      if (Array.from(shortName).length > 8) throw coded("INVALID_SHORT_NAME", "简称最多 8 个字");
      if (color && !/^#[0-9A-F]{6}$/.test(color)) throw coded("INVALID_COLOR", "请选择有效颜色");
      const now = nowSnapshot();
      const project = Object.assign({}, old, { name, shortName, color, updatedAtSec: now, revision: (old.revision || 1) + 1 });
      const projects = Object.assign({}, state.projects, { [old.id]: project });
      const meta = bumpedMeta(now);
      await persist(input.operationId, [
        { t: "set", k: repo.PROJECTS, v: projects },
        { t: "set", k: repo.META, v: meta },
      ]);
      state.projects = projects;
      applyMeta(meta);
      require("../utils/color").setProjectColor(old.id, color);
      return { project, asOfSec: now };
    });
  }

  async function moveProjectOrder(input) {
    return command("moveProjectOrder", input, async () => {
      await settleInternal();
      const project = state.projects[input.projectId];
      if (!project) throw coded("PROJECT_NOT_FOUND", "项目不存在");
      const siblings = Object.values(state.projects)
        .filter(
          (p) =>
            p.parentId === project.parentId && p.archived === project.archived,
        )
        .sort((a, b) => a.creationOrder - b.creationOrder);
      if (input.targetProjectId) {
        const target = siblings.find((p) => p.id === input.targetProjectId);
        if (!target || target.id === project.id) return { changed: false };
        const remaining = siblings.filter((p) => p.id !== project.id);
        const targetIndex = remaining.findIndex((p) => p.id === target.id);
        remaining.splice(targetIndex + (input.after ? 1 : 0), 0, project);
        if (remaining.every((p, i) => p.id === siblings[i].id))
          return { changed: false };
        const now = nowSnapshot(),
          projects = Object.assign({}, state.projects);
        remaining.forEach((p, i) => {
          projects[p.id] = Object.assign({}, p, {
            creationOrder: siblings[i].creationOrder,
            updatedAtSec: now,
            revision: (p.revision || 1) + 1,
          });
        });
        const meta = bumpedMeta(now);
        await persist(input.operationId, [
          { t: "set", k: repo.PROJECTS, v: projects },
          { t: "set", k: repo.META, v: meta },
        ]);
        state.projects = projects;
        applyMeta(meta);
        return { changed: true };
      }
      const index = siblings.findIndex((p) => p.id === project.id),
        otherIndex = index + (input.direction === "up" ? -1 : 1);
      if (index < 0 || otherIndex < 0 || otherIndex >= siblings.length)
        return { changed: false };
      const now = nowSnapshot(),
        projects = Object.assign({}, state.projects),
        first = siblings[index],
        second = siblings[otherIndex];
      projects[first.id] = Object.assign({}, first, {
        creationOrder: second.creationOrder,
        updatedAtSec: now,
        revision: (first.revision || 1) + 1,
      });
      projects[second.id] = Object.assign({}, second, {
        creationOrder: first.creationOrder,
        updatedAtSec: now,
        revision: (second.revision || 1) + 1,
      });
      const meta = bumpedMeta(now);
      await persist(input.operationId, [
        { t: "set", k: repo.PROJECTS, v: projects },
        { t: "set", k: repo.META, v: meta },
      ]);
      state.projects = projects;
      applyMeta(meta);
      return { changed: true };
    });
  }

  // ---------------- 计时命令 ----------------
  async function start(input) {
    return command("start", input, async () => {
      await settleInternal();
      if (state.active)
        throw coded("ACTIVE_SESSION_EXISTS", "已有进行中的专注，请先结束本轮");
      const raw = input || {};
      const project = raw.projectId ? state.projects[raw.projectId] : null;
      if (!project)
        throw coded("PROJECT_NOT_FOUND", "请先选择项目（不会自动创建项目）");
      const cloudProject = await adapter.get(
        "yotick/shadow/project/" + project.id,
      );
      if (cloudProject && cloudProject.deleted)
        throw coded(
          "ENTITY_DELETED",
          "该项目已在云端删除，请先恢复或选择有效项目",
        );
      if (project.archived)
        throw coded("PROJECT_ARCHIVED", "项目已归档，请重新选择");
      const pIndex = treeMod.buildIndex(state.projects);
      if (!treeMod.isStartable(pIndex, project.id)) {
        throw coded(
          "PROJECT_IS_GROUP",
          "这个项目下还有内容，请展开后选择具体学习内容",
        );
      }
      const target = timer.normalizeTarget(
        raw.targetSeconds == null ? null : raw.targetSeconds,
      );
      const now = nowSnapshot();
      const s = {
        id: genId(),
        spaceId: state.meta.id,
        projectId: project.id,
        startedAtSec: now,
        endedAtSec: null,
        durationSeconds: null,
        targetSeconds: target,
        status: "ACTIVE",
        pauses: [],
        createdAtSec: now,
        updatedAtSec: now,
        revision: 1,
      };

      const span = await prepareSpan({
        id: s.id,
        startedAtSec: s.startedAtSec,
        endedAtSec: now,
      });
      const pidx = await prepareProjectIndex(project.id, s.id);
      const newProjects = Object.assign({}, state.projects);
      newProjects[project.id] = Object.assign({}, project, {
        lastUsedAtSec: now,
      });
      const newMeta = bumpedMeta(now);
      newMeta.activeSessionId = s.id;

      const ops = [{ t: "set", k: repo.sessionKey(s.id), v: s }]
        .concat(span.ops)
        .concat([
          pidx.op,
          { t: "set", k: repo.PROJECTS, v: newProjects },
          { t: "set", k: repo.META, v: newMeta },
        ]);
      await persist(input.operationId, ops);

      span.apply();
      pidx.apply();
      state.projects = newProjects;
      applyMeta(newMeta);
      state.active = s;
      return currentData();
    });
  }

  async function pause(input) {
    return command("pause", input, async () => {
      await settleInternal();
      const s = state.active;
      if (!s) throw coded("NO_ACTIVE_SESSION", "当前没有进行中的专注");
      if (input.sessionId !== s.id)
        throw coded("STALE_COMMAND", "该暂停命令属于已结束的旧会话");
      if (timer.getActivePause(s))
        throw coded("NOT_STUDYING", "已经处于暂停状态");
      const now = nowSnapshot();
      const sCopy = deepClone(s);
      sCopy.pauses.push({
        id: genId(),
        sessionId: sCopy.id,
        startedAtSec: now,
        endedAtSec: null,
        durationSeconds: null,
        status: "ACTIVE",
        createdAtSec: now,
      });
      sCopy.updatedAtSec = now;
      sCopy.revision = (sCopy.revision || 1) + 1;
      const newMeta = bumpedMeta(now);
      await persist(input.operationId, [
        { t: "set", k: repo.sessionKey(sCopy.id), v: sCopy },
        { t: "set", k: repo.META, v: newMeta },
      ]);
      state.active = sCopy;
      applyMeta(newMeta);
      return currentData();
    });
  }

  async function resume(input) {
    return command("resume", input, async () => {
      await settleInternal();
      const s = state.active;
      if (!s) throw coded("NO_ACTIVE_SESSION", "当前没有进行中的专注");
      if (input.sessionId !== s.id)
        throw coded("STALE_COMMAND", "该继续命令属于已结束的旧会话");
      if (!timer.getActivePause(s))
        throw coded("NOT_PAUSED", "当前不在暂停状态");
      const now = nowSnapshot();
      const sCopy = deepClone(s);
      timer.closeActivePause(sCopy, now, false); // 时钟倒退 → CLOCK_BEFORE_FACT
      sCopy.updatedAtSec = now;
      sCopy.revision = (sCopy.revision || 1) + 1;
      const newMeta = bumpedMeta(now);
      await persist(input.operationId, [
        { t: "set", k: repo.sessionKey(sCopy.id), v: sCopy },
        { t: "set", k: repo.META, v: newMeta },
      ]);
      state.active = sCopy;
      applyMeta(newMeta);
      return currentData();
    });
  }

  async function stop(input) {
    return command("stop", input, async () => {
      const settledId = await settleInternal();
      if (settledId && input.sessionId === settledId) {
        return Object.assign(currentData(), { settledByExpiry: true });
      }
      const s = state.active;
      if (!s) throw coded("NO_ACTIVE_SESSION", "当前没有进行中的专注");
      if (input.sessionId !== s.id)
        throw coded("STALE_COMMAND", "该结束命令属于已结束的旧会话");
      const now = nowSnapshot();
      if (now < s.startedAtSec)
        throw coded(
          "CLOCK_BEFORE_FACT",
          "设备时间早于本轮开始时间，数据已保留",
        );
      const sCopy = deepClone(s);
      if (timer.getActivePause(sCopy)) {
        timer.closeActivePause(sCopy, now, false); // 时钟倒退 → CLOCK_BEFORE_FACT
      }
      const r = timer.stopResult(sCopy, now);
      Object.assign(sCopy, r);
      sCopy.updatedAtSec = now;
      sCopy.revision = (sCopy.revision || 1) + 1;

      const span = await prepareSpan(sCopy);
      const newMeta = bumpedMeta(now);
      newMeta.activeSessionId = null;
      const ops = [{ t: "set", k: repo.sessionKey(sCopy.id), v: sCopy }]
        .concat(span.ops)
        .concat([{ t: "set", k: repo.META, v: newMeta }]);
      await persist(input.operationId, ops);

      span.apply();
      applyMeta(newMeta);
      state.notices.push({
        sessionId: sCopy.id,
        projectId: sCopy.projectId,
        durationSeconds: sCopy.durationSeconds,
        endedAtSec: sCopy.endedAtSec,
        auto: false,
      });
      state.active = null;
      return currentData();
    });
  }

  // ---------------- 归档 / 恢复 / 删除 ----------------
  async function archiveProject(input) {
    return command("archive", input, async () => {
      await settleInternal();
      const id = input.projectId;
      if (!state.projects[id]) throw coded("PROJECT_NOT_FOUND", "项目不存在");
      const pIndex = treeMod.buildIndex(state.projects);
      const members = treeMod.subtreeIds(pIndex, id);
      if (state.active && members.indexOf(state.active.projectId) !== -1) {
        throw coded("PROJECT_IN_USE", "该项目或其子项目正在专注中，无法归档");
      }
      const now = nowSnapshot();
      const newProjects = Object.assign({}, state.projects);
      let changed = 0;
      for (let i = 0; i < members.length; i++) {
        const p = state.projects[members[i]];
        if (!p.archived) {
          newProjects[members[i]] = Object.assign({}, p, {
            archived: true,
            updatedAtSec: now,
            revision: (p.revision || 1) + 1,
          });
          changed++;
        }
      }
      const newMeta = bumpedMeta(now);
      await persist(input.operationId, [
        { t: "set", k: repo.PROJECTS, v: newProjects },
        { t: "set", k: repo.META, v: newMeta },
      ]);
      state.projects = newProjects;
      applyMeta(newMeta);
      return { changed: changed, asOfSec: now };
    });
  }

  async function restoreProject(input) {
    return command("restore", input, async () => {
      await settleInternal();
      const id = input.projectId;
      if (!state.projects[id]) throw coded("PROJECT_NOT_FOUND", "项目不存在");
      const pIndex = treeMod.buildIndex(state.projects);
      const members = treeMod.subtreeIds(pIndex, id);
      const ancestorChain = treeMod.ancestors(pIndex, id);
      const restoreIds = new Set(members.concat(ancestorChain));
      const now = nowSnapshot();
      const newProjects = Object.assign({}, state.projects);
      let changed = 0;
      restoreIds.forEach((mid) => {
        const p = state.projects[mid];
        if (p && p.archived) {
          newProjects[mid] = Object.assign({}, p, {
            archived: false,
            updatedAtSec: now,
            revision: (p.revision || 1) + 1,
          });
          changed++;
        }
      });
      const newMeta = bumpedMeta(now);
      await persist(input.operationId, [
        { t: "set", k: repo.PROJECTS, v: newProjects },
        { t: "set", k: repo.META, v: newMeta },
      ]);
      state.projects = newProjects;
      applyMeta(newMeta);
      return { changed: changed, asOfSec: now };
    });
  }

  async function deleteProject(input) {
    return command("delete", input, async () => {
      await settleInternal();
      const id = input.projectId;
      if (!state.projects[id]) throw coded("PROJECT_NOT_FOUND", "项目不存在");
      const pIndex = treeMod.buildIndex(state.projects);
      const members = treeMod.subtreeIds(pIndex, id);
      if (state.active && members.indexOf(state.active.projectId) !== -1) {
        throw coded("PROJECT_IN_USE", "该项目或其子项目正在专注中，无法删除");
      }

      const sessionIds = new Set();
      for (let i = 0; i < members.length; i++) {
        const arr =
          (await adapter.get(repo.projectSessionsKey(members[i]))) || [];
        for (let j = 0; j < arr.length; j++) sessionIds.add(arr[j]);
      }

      const dayKeysTouched = new Set();
      const sidArr = Array.from(sessionIds);
      for (let i = 0; i < sidArr.length; i++) {
        const s = await adapter.get(repo.sessionKey(sidArr[i]));
        if (!s) continue;
        const endRef = s.endedAtSec != null ? s.endedAtSec : s.startedAtSec;
        const first = time.dayIndex(s.startedAtSec);
        const last = time.dayIndex(endRef - 1);
        for (let d = first; d <= last; d++)
          dayKeysTouched.add(time.dayKeyOfIndex(d));
      }

      const ops = [];
      const dayApplies = [];
      const dkArr = Array.from(dayKeysTouched);
      for (let i = 0; i < dkArr.length; i++) {
        const dk = dkArr[i];
        const cur = (await loadDayIndex(dk)).slice();
        const kept = cur.filter((x) => sidArr.indexOf(x) === -1);
        if (kept.length === 0) {
          ops.push({ t: "remove", k: repo.dayIndexKey(dk) });
          dayApplies.push({ dk: dk, arr: [] });
        } else {
          ops.push({ t: "set", k: repo.dayIndexKey(dk), v: kept });
          dayApplies.push({ dk: dk, arr: kept });
        }
      }
      for (let i = 0; i < sidArr.length; i++) {
        ops.push({ t: "remove", k: repo.sessionKey(sidArr[i]) });
      }
      for (let i = 0; i < members.length; i++) {
        ops.push({ t: "remove", k: repo.projectSessionsKey(members[i]) });
      }

      const newProjects = Object.assign({}, state.projects);
      for (let i = 0; i < members.length; i++) delete newProjects[members[i]];
      ops.push({ t: "set", k: repo.PROJECTS, v: newProjects });

      let newPrefs = state.prefs;
      if (
        state.prefs &&
        state.prefs.lastProjectId &&
        members.indexOf(state.prefs.lastProjectId) !== -1
      ) {
        newPrefs = Object.assign({}, state.prefs, { lastProjectId: null });
        ops.push({ t: "set", k: repo.PREFS, v: newPrefs });
      }

      const newMeta = bumpedMeta(nowSnapshot());
      ops.push({ t: "set", k: repo.META, v: newMeta });
      await persist(input.operationId, ops);

      for (let i = 0; i < dayApplies.length; i++)
        state.dayCache[dayApplies[i].dk] = dayApplies[i].arr.slice();
      for (let i = 0; i < members.length; i++)
        delete state.projSessionCache[members[i]];
      state.projects = newProjects;
      state.prefs = newPrefs;
      applyMeta(newMeta);
      return {
        deletedProjects: members.length,
        deletedSessions: sidArr.length,
      };
    });
  }

  async function deleteSession(input) {
    return command("deleteSession", input, async () => {
      const id = input.sessionId;
      if (typeof id !== "string" || !id)
        throw coded("INVALID_SESSION", "请选择要删除的记录");
      const session = await adapter.get(repo.sessionKey(id));
      if (!session) throw coded("SESSION_NOT_FOUND", "这条记录已不存在");
      const invalid = validateSession(session);
      if (invalid) throw coded("DATA_CORRUPT", invalid);
      if (session.status !== "COMPLETED" || state.meta.activeSessionId === id) {
        throw coded(
          "SESSION_IN_PROGRESS",
          "这次计时尚未结束，请先结束后再删除",
        );
      }

      // Remove every indexed occurrence, including both days of a midnight crossing.
      // Prepare copies first; caches become visible only after the durable commit.
      const keys = await adapter.keys();
      const indexKeys = keys.filter(
        (key) =>
          key.indexOf("yotick/d/") === 0 || key.indexOf("yotick/p/") === 0,
      );
      const ops = [],
        patches = [];
      for (const key of indexKeys) {
        const ids = await adapter.get(key);
        if (!Array.isArray(ids))
          throw coded("DATA_CORRUPT", "记录索引异常，请先修复本地数据");
        if (!ids.includes(id)) continue;
        const kept = ids.filter((sid) => sid !== id);
        ops.push(
          kept.length ? { t: "set", k: key, v: kept } : { t: "remove", k: key },
        );
        patches.push({ key, kept });
      }
      ops.push({ t: "remove", k: repo.sessionKey(id) });
      const meta = bumpedMeta(nowSnapshot());
      ops.push({ t: "set", k: repo.META, v: meta });
      await persist(input.operationId, ops);
      patches.forEach(({ key, kept }) => {
        if (key.indexOf("yotick/d/") === 0)
          state.dayCache[key.slice("yotick/d/".length)] = kept.slice();
        else
          state.projSessionCache[key.slice("yotick/p/".length)] = kept.slice();
      });
      applyMeta(meta);
      return { deletedSessionId: id };
    });
  }

  async function reduceSessionDuration(input) {
    return command("reduceSessionDuration", input, async () => {
      const id = input.sessionId;
      if (typeof id !== "string" || !id)
        throw coded("INVALID_SESSION", "请选择要减少时长的记录");
      const session = await adapter.get(repo.sessionKey(id));
      if (!session) throw coded("SESSION_NOT_FOUND", "这条记录已不存在");
      const invalid = validateSession(session);
      if (invalid) throw coded("DATA_CORRUPT", invalid);
      if (state.meta.activeSessionId === id)
        throw coded("SESSION_IN_PROGRESS", "请先结束计时后再调整");
      const reduced = require("./session-reduction").reduceSession(session, input.durationSeconds);
      const now = nowSnapshot();
      reduced.updatedAtSec = Math.max(now, session.updatedAtSec || 0);
      reduced.revision = (session.revision || 0) + 1;
      const span = await prepareSpan(reduced);
      const first = time.dayIndex(reduced.startedAtSec);
      const last = time.dayIndex(Math.max(reduced.startedAtSec, reduced.endedAtSec - 1));
      const keptDays = new Set();
      for (let day = first; day <= last; day++) keptDays.add(time.dayKeyOfIndex(day));
      const ops = span.ops.slice(), patches = [];
      for (const key of (await adapter.keys()).filter(key => key.indexOf("yotick/d/") === 0)) {
        const day = key.slice("yotick/d/".length);
        if (keptDays.has(day)) continue;
        const ids = await adapter.get(key);
        if (!Array.isArray(ids)) throw coded("DATA_CORRUPT", "记录索引异常，请先修复本地数据");
        if (!ids.includes(id)) continue;
        const kept = ids.filter(value => value !== id);
        ops.push(kept.length ? { t: "set", k: key, v: kept } : { t: "remove", k: key });
        patches.push({ day, kept });
      }
      const meta = bumpedMeta(now);
      ops.push({ t: "set", k: repo.sessionKey(id), v: reduced }, { t: "set", k: repo.META, v: meta });
      await persist(input.operationId, ops);
      span.apply();
      patches.forEach(({ day, kept }) => { state.dayCache[day] = kept.slice(); });
      applyMeta(meta);
      return { sessionId: id, durationSeconds: reduced.durationSeconds, endedAtSec: reduced.endedAtSec };
    });
  }

  // ---------------- 查询 ----------------
  async function getCurrent() {
    return enqueue(async () => {
      if (state.blocked)
        return failEnvelope(state.blocked.code, state.blocked.message);
      await settleInternal();
      return okEnvelope(currentData());
    });
  }

  function peekCurrent() {
    if (state.blocked)
      return failEnvelope(state.blocked.code, state.blocked.message);
    return okEnvelope(currentData());
  }

  async function getRecords(input) {
    return enqueue(async () => {
      if (state.blocked)
        return failEnvelope(state.blocked.code, state.blocked.message);
      await settleInternal();
      const spec = input || {};
      let range;
      try {
        if (spec.date) {
          range = ranges.rangeCustom(spec.date, spec.date);
        } else if (spec.startDate && spec.endDate) {
          range = ranges.rangeCustom(spec.startDate, spec.endDate);
        } else {
          range = ranges.rangeToday(nowSnapshot());
        }
      } catch (e) {
        return failEnvelope("INVALID_RANGE", e.message);
      }
      const now = nowSnapshot();
      const sessions = await sessionsForRange(range);
      const mode = spec.mode === "completed" ? "completed" : "realtime";
      const used =
        mode === "completed"
          ? sessions.filter((s) => s.status === "COMPLETED")
          : sessions;

      const pIndex = treeMod.buildIndex(state.projects);
      let rows = statistics.recordsInRange(
        used,
        range,
        now,
        pIndex,
        !!spec.includeZeroCompleted,
      );

      if (spec.projectId) {
        if (!state.projects[spec.projectId])
          return failEnvelope("PROJECT_NOT_FOUND", "项目不存在");
        const members = new Set(treeMod.subtreeIds(pIndex, spec.projectId));
        rows = rows.filter((r) => members.has(r.projectId));
      }

      const page = Math.max(1, Number(spec.page) || 1);
      const pageSize = Math.max(1, Number(spec.pageSize) || 50);
      const start = (page - 1) * pageSize;
      return okEnvelope({
        range: range,
        mode: mode,
        totalCount: rows.length,
        page: page,
        pageSize: pageSize,
        rows: rows.slice(start, start + pageSize),
      });
    });
  }

  async function getStatistics(input) {
    return enqueue(async () => {
      if (state.blocked)
        return failEnvelope(state.blocked.code, state.blocked.message);
      await settleInternal();
      const spec = input || {};
      let range;
      try {
        range = resolveRange(spec);
      } catch (e) {
        return failEnvelope("INVALID_RANGE", e.message);
      }
      const now = nowSnapshot();
      const sessions = await sessionsForRange(range);
      const mode = spec.mode === "completed" ? "completed" : "realtime";
      const used =
        mode === "completed"
          ? sessions.filter((s) => s.status === "COMPLETED")
          : sessions;
      const pIndex = treeMod.buildIndex(state.projects);

      if (spec.projectId) {
        if (!state.projects[spec.projectId])
          return failEnvelope("PROJECT_NOT_FOUND", "项目不存在");
        const result = statistics.subjectStatistics(
          used,
          spec.projectId,
          range,
          now,
          pIndex,
          mode,
        );
        result.range = range;
        result.projects = Object.values(state.projects).map((p) => ({
          projectId: p.id,
          name: p.name,
          shortName: p.shortName || "",
          color: p.color || null,
          parentId: p.parentId,
          archived: !!p.archived,
        }));
        return okEnvelope(result);
      }
      const result = statistics.rangeStatistics(used, range, now, pIndex, mode);
      result.range = range;
      result.projects = Object.values(state.projects).map((p) => ({
        projectId: p.id,
        name: p.name,
        shortName: p.shortName || "",
        color: p.color || null,
        parentId: p.parentId,
        archived: !!p.archived,
      }));
      return okEnvelope(result);
    });
  }

  async function getHeatmap(input) {
    return enqueue(async () => {
      if (state.blocked)
        return failEnvelope(state.blocked.code, state.blocked.message);
      const spec = input || {};
      await settleInternal();
      const monthKeyStr = spec.monthKey;
      const info = time.parseMonthKey(monthKeyStr);
      if (!info) return failEnvelope("INVALID_RANGE", "月份不合法");
      const range = {
        start: time.dayStartByIndex(info.startIndex),
        end: time.dayStartByIndex(info.startIndex + info.days),
      };
      const now = nowSnapshot();
      const sessions = await sessionsForRange(range);
      const pIndex = treeMod.buildIndex(state.projects);
      const scopeProjectId = spec.scopeProjectId || null;
      const cells = statistics.heatmapMonth(
        sessions,
        info,
        now,
        pIndex,
        scopeProjectId,
      );

      const firstWeekday = time.weekdayOfDayIndex(info.startIndex);
      const grid = [];
      let row = [];
      for (let i = 0; i < firstWeekday; i++) row.push(null);
      for (let i = 0; i < cells.length; i++) {
        row.push(cells[i]);
        if (row.length === 7) {
          grid.push(row);
          row = [];
        }
      }
      if (row.length) {
        while (row.length < 7) row.push(null);
        grid.push(row);
      }
      let scopeName = null;
      if (scopeProjectId) {
        const sp = state.projects[scopeProjectId];
        scopeName = sp ? sp.name : null;
      }
      return okEnvelope({
        monthKey: monthKeyStr,
        year: info.year,
        month: info.month,
        cells: cells,
        grid: grid,
        scopeProjectId: scopeProjectId,
        scopeName: scopeName,
      });
    });
  }

  // 同级项目按用户保存的 creationOrder 排序，供专注选择与项目管理共用。
  function makeOrdering(pIndex) {
    function sortedKids(id) {
      return treeMod
        .directChildren(pIndex, id)
        .filter((kid) => !state.projects[kid].archived)
        .sort(
          (a, b) =>
            state.projects[a].creationOrder - state.projects[b].creationOrder,
        );
    }
    return { sortedKids: sortedKids };
  }

  async function getPickerData() {
    return enqueue(async () => {
      if (state.blocked)
        return failEnvelope(state.blocked.code, state.blocked.message);
      await settleInternal();
      const pIndex = treeMod.buildIndex(state.projects);
      const ordering = makeOrdering(pIndex);
      const allIds = Object.keys(state.projects);
      const activeIds = allIds.filter((id) => !state.projects[id].archived);
      const leaves = activeIds.filter((id) => treeMod.isStartable(pIndex, id));
      const recent = leaves
        .map((id) => ({
          projectId: id,
          name: state.projects[id].name,
          path: treeMod.pathNames(pIndex, id),
          lastUsedAtSec: state.projects[id].lastUsedAtSec || 0,
        }))
        .filter((x) => x.lastUsedAtSec > 0)
        .sort((a, b) => b.lastUsedAtSec - a.lastUsedAtSec)
        .slice(0, 3);

      const treeRows = [];
      function walk(id, depth) {
        const p = state.projects[id];
        treeRows.push({
          projectId: id,
          name: p.name,
          color: p.color || null,
          shortName: p.shortName || "",
          depth: depth,
          startable: treeMod.isStartable(pIndex, id),
          parentId: p.parentId,
        });
        const kids = ordering.sortedKids(id);
        for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
      }
      const roots = ordering.sortedKids(null);
      for (let i = 0; i < roots.length; i++) walk(roots[i], 0);
      return okEnvelope({ recent: recent, treeRows: treeRows });
    });
  }

  async function getManageData() {
    return enqueue(async () => {
      if (state.blocked)
        return failEnvelope(state.blocked.code, state.blocked.message);
      await settleInternal();
      const pIndex = treeMod.buildIndex(state.projects);
      const allIds = Object.keys(state.projects);
      for (let i = 0; i < allIds.length; i++) {
        const id = allIds[i];
        if (!state.projSessionCache[id]) {
          state.projSessionCache[id] =
            (await adapter.get(repo.projectSessionsKey(id))) || [];
        }
      }
      function row(id) {
        const p = state.projects[id];
        const subtree = treeMod.subtreeIds(pIndex, id);
        let subtreeSessionCount = 0;
        for (let i = 0; i < subtree.length; i++) {
          subtreeSessionCount += (state.projSessionCache[subtree[i]] || [])
            .length;
        }
        return {
          projectId: id,
          name: p.name,
          color: p.color || null,
          shortName: p.shortName || "",
          parentId: p.parentId,
          path: treeMod.pathNames(pIndex, id),
          pathText: treeMod.pathNames(pIndex, id).join(" / "),
          depth: treeMod.ancestors(pIndex, id).length,
          archived: p.archived,
          childCount: treeMod.directChildren(pIndex, id).length,
          startable: treeMod.isStartable(pIndex, id),
          ownSessionCount: (state.projSessionCache[id] || []).length,
          subtreeProjectCount: subtree.length,
          subtreeSessionCount: subtreeSessionCount,
          createdAtSec: p.createdAtSec,
          updatedAtSec: p.updatedAtSec,
        };
      }
      const activeRows = [],
        archivedRows = [];
      function walkManage(id, out) {
        out.push(row(id));
        const kids = treeMod
          .directChildren(pIndex, id)
          .filter(
            (kid) =>
              state.projects[kid].archived === state.projects[id].archived,
          )
          .sort(
            (a, b) =>
              state.projects[a].creationOrder - state.projects[b].creationOrder,
          );
        for (let i = 0; i < kids.length; i++) walkManage(kids[i], out);
      }
      const roots = treeMod
        .directChildren(pIndex, null)
        .sort(
          (a, b) =>
            state.projects[a].creationOrder - state.projects[b].creationOrder,
        );
      for (let i = 0; i < roots.length; i++)
        walkManage(
          roots[i],
          state.projects[roots[i]].archived ? archivedRows : activeRows,
        );
      const missing = allIds.filter((id) => !roots.includes(id));
      for (let i = 0; i < missing.length; i++) {
        const p = state.projects[missing[i]],
          out = p.archived ? archivedRows : activeRows;
        if (!out.some((r) => r.projectId === p.id)) out.push(row(p.id));
      }
      return okEnvelope({ active: activeRows, archived: archivedRows });
    });
  }

  async function createBackup() {
    return enqueue(async () => {
      if (state.blocked)
        return failEnvelope(state.blocked.code, state.blocked.message);
      await settleInternal();
      const keys = await adapter.keys(),
        sessionKeys = keys.filter((k) => k.indexOf("yotick/s/") === 0),
        sessions = [];
      for (let i = 0; i < sessionKeys.length; i++) {
        const s = await adapter.get(sessionKeys[i]);
        if (s) sessions.push(s);
      }
      return okEnvelope({
        formatVersion: 1,
        exportedAtSec: nowSnapshot(),
        spaceId: state.meta.id,
        meta: {
          schemaVersion: state.meta.schemaVersion,
          utcOffsetMinutes: state.meta.utcOffsetMinutes,
        },
        projects: Object.values(state.projects),
        sessions,
        prefs: deepClone(state.prefs || {}),
      });
    });
  }

  function planBackupMerge(backup) {
    if (backup && backup.formatVersion === 2 && backup.localBackup)
      backup = backup.localBackup;
    if (!backup || typeof backup !== "object" || backup.formatVersion !== 1)
      throw coded("BACKUP_VERSION_UNSUPPORTED", "备份版本不受支持");
    if (
      !Array.isArray(backup.projects) ||
      !Array.isArray(backup.sessions) ||
      !backup.meta ||
      backup.meta.schemaVersion !== SCHEMA_VERSION ||
      backup.meta.utcOffsetMinutes !== 480 ||
      typeof backup.spaceId !== "string" ||
      !backup.spaceId
    )
      throw coded("BACKUP_INVALID", "备份内容不完整或数据版本、时区不受支持");
    if (state.active)
      throw coded("ACTIVE_SESSION_EXISTS", "专注进行中，暂时不能恢复备份");
    const projects = Object.assign({}, state.projects),
      newProjects = {},
      incomingProjectIds = new Set();
    let nextOrder = state.meta.nextCreationOrder;
    for (let i = 0; i < backup.projects.length; i++) {
      const source = backup.projects[i];
      if (!source || typeof source.spaceId !== "string" || !source.spaceId)
        throw coded("BACKUP_INVALID", "备份项目缺少空间标识");
      const p = Object.assign({}, source, { spaceId: state.meta.id });
      if (incomingProjectIds.has(p.id))
        throw coded("BACKUP_INVALID", "备份中存在重复项目 ID");
      incomingProjectIds.add(p.id);
      const err = validateProject(p);
      if (err) throw coded("BACKUP_INVALID", err);
      if (projects[p.id]) {
        const comparable = Object.assign({}, p, {
          creationOrder: projects[p.id].creationOrder,
        });
        if (JSON.stringify(projects[p.id]) !== JSON.stringify(comparable))
          throw coded("BACKUP_CONFLICT", "项目 ID 内容冲突：" + p.name);
        continue;
      }
      p.creationOrder = nextOrder++;
      newProjects[p.id] = p;
      projects[p.id] = p;
    }
    const registryError = validateRegistry(projects);
    if (registryError) throw coded("BACKUP_INVALID", registryError);
    const keys = Object.keys(projects),
      byName = new Map();
    for (let i = 0; i < keys.length; i++) {
      const p = projects[keys[i]];
      if (byName.has(p.name) && byName.get(p.name) !== p.id)
        throw coded("BACKUP_CONFLICT", "项目名称冲突：" + p.name);
      byName.set(p.name, p.id);
    }
    const allKeysPromise = adapter.keys();
    return allKeysPromise.then(async (allKeys) => {
      const existingSessions = {};
      const sessionKeys = allKeys.filter((k) => k.indexOf("yotick/s/") === 0);
      for (let i = 0; i < sessionKeys.length; i++) {
        const s = await adapter.get(sessionKeys[i]);
        if (s) existingSessions[s.id] = s;
      }
      const newSessions = {},
        incomingIds = new Set();
      let activeId = null;
      for (let i = 0; i < backup.sessions.length; i++) {
        const source = backup.sessions[i];
        if (!source || typeof source.spaceId !== "string" || !source.spaceId)
          throw coded("BACKUP_INVALID", "备份会话缺少空间标识");
        const s = Object.assign({}, source, { spaceId: state.meta.id });
        if (incomingIds.has(s.id))
          throw coded("BACKUP_INVALID", "备份中存在重复会话 ID");
        incomingIds.add(s.id);
        if (s.status === "ACTIVE") {
          if (activeId)
            throw coded("BACKUP_INVALID", "备份中包含多个进行中的专注");
          activeId = s.id;
        }
        const local = existingSessions[s.id];
        if (local) {
          if (JSON.stringify(local) !== JSON.stringify(s))
            throw coded("BACKUP_CONFLICT", "会话 ID 内容冲突：" + s.id);
          continue;
        }
        newSessions[s.id] = s;
      }
      const original = state.projects;
      state.projects = projects;
      try {
        for (const id of Object.keys(newSessions)) {
          const session = newSessions[id],
            err = validateSession(session);
          if (err) throw coded("BACKUP_INVALID", err);
          if (
            session.targetSeconds !== null &&
            (!Number.isInteger(session.targetSeconds) ||
              session.targetSeconds < 60)
          )
            throw coded("BACKUP_INVALID", "备份专注时长目标异常");
          if (
            session.status === "COMPLETED" &&
            (session.endedAtSec < session.startedAtSec ||
              session.durationSeconds < 0)
          )
            throw coded("BACKUP_INVALID", "备份会话时间区间异常");
          const pauseIds = new Set();
          let activePauses = 0;
          for (let i = 0; i < session.pauses.length; i++) {
            const pause = session.pauses[i];
            if (pauseIds.has(pause.id) || pause.sessionId !== session.id)
              throw coded("BACKUP_INVALID", "暂停记录 ID 或会话引用异常");
            pauseIds.add(pause.id);
            if (pause.status === "ACTIVE") {
              activePauses++;
              if (session.status !== "ACTIVE")
                throw coded("BACKUP_INVALID", "已结束会话中存在进行中的暂停");
            } else if (
              !Number.isInteger(pause.endedAtSec) ||
              pause.endedAtSec < pause.startedAtSec ||
              pause.durationSeconds < 0
            )
              throw coded("BACKUP_INVALID", "暂停区间异常");
          }
          if (activePauses > 1)
            throw coded("BACKUP_INVALID", "会话中存在多个进行中的暂停");
        }
      } finally {
        state.projects = original;
      }
      if (activeId && existingSessions[activeId])
        throw coded("BACKUP_CONFLICT", "进行中的会话与本机数据冲突");
      const mergedSessions = Object.assign({}, existingSessions, newSessions);
      const dayIndexes = {},
        projectIndexes = {};
      for (const id of Object.keys(mergedSessions)) {
        const s = mergedSessions[id],
          end = s.status === "COMPLETED" ? s.endedAtSec : nowSnapshot(),
          first = time.dayIndex(s.startedAtSec),
          last = time.dayIndex(Math.max(s.startedAtSec, end - 1));
        for (let d = first; d <= last; d++) {
          const key = time.dayKeyOfIndex(d);
          if (!dayIndexes[key]) dayIndexes[key] = [];
          dayIndexes[key].push(id);
        }
        if (!projectIndexes[s.projectId]) projectIndexes[s.projectId] = [];
        projectIndexes[s.projectId].push(id);
      }
      Object.keys(dayIndexes).forEach((k) => dayIndexes[k].sort());
      Object.keys(projectIndexes).forEach((k) => projectIndexes[k].sort());
      const prefs =
        backup.prefs && typeof backup.prefs === "object"
          ? deepClone(backup.prefs)
          : null;
      if (prefs && prefs.lastProjectId && !projects[prefs.lastProjectId])
        throw coded("BACKUP_INVALID", "备份偏好引用了不存在的项目");
      const completedRounds = Object.values(mergedSessions).filter(
        (s) => s.status === "COMPLETED" && s.durationSeconds > 0,
      ).length;
      return {
        projects,
        newProjects,
        newSessions,
        activeId,
        dayIndexes,
        projectIndexes,
        existingKeys: allKeys,
        nextOrder,
        completedRounds,
        importedProjects: Object.keys(newProjects).length,
        importedSessions: Object.keys(newSessions).length,
        skippedProjects:
          backup.projects.length - Object.keys(newProjects).length,
        skippedSessions:
          backup.sessions.length - Object.keys(newSessions).length,
        prefs,
      };
    });
  }

  async function previewBackup(backup) {
    return enqueue(async () => {
      try {
        const p = await planBackupMerge(backup);
        const bytes = unescape(
          encodeURIComponent(
            JSON.stringify({
              projects: p.newProjects,
              sessions: p.newSessions,
              days: p.dayIndexes,
              projectIndexes: p.projectIndexes,
              prefs: p.prefs,
            }),
          ),
        ).length;
        return okEnvelope({
          importedProjects: p.importedProjects,
          importedSessions: p.importedSessions,
          skippedProjects: p.skippedProjects,
          skippedSessions: p.skippedSessions,
          estimatedWriteBytes: bytes * 2,
          conflicts: 0,
        });
      } catch (e) {
        return failEnvelope(e.code || "BACKUP_INVALID", e.message);
      }
    });
  }

  async function importBackup(input) {
    return command("importBackup", input, async () => {
      await settleInternal();
      const p = await planBackupMerge(input.backup),
        now = nowSnapshot(),
        ops = [{ t: "set", k: repo.PROJECTS, v: p.projects }];
      if (input.backup.formatVersion === 2 && input.backup.syncRecovery) {
        for (const k of Object.keys(input.backup.syncRecovery))
          ops.push({
            t: "set",
            k:
              "yotick/recovery/import-" +
              input.operationId +
              "/" +
              encodeURIComponent(k),
            v: input.backup.syncRecovery[k],
          });
      }
      Object.keys(p.newSessions).forEach((id) =>
        ops.push({ t: "set", k: repo.sessionKey(id), v: p.newSessions[id] }),
      );
      const oldDayKeys = p.existingKeys.filter(
          (k) => k.indexOf("yotick/d/") === 0,
        ),
        oldProjectKeys = p.existingKeys.filter(
          (k) => k.indexOf("yotick/p/") === 0,
        );
      oldDayKeys.forEach((k) => {
        const day = k.slice("yotick/d/".length);
        if (p.dayIndexes[day]) ops.push({ t: "set", k, v: p.dayIndexes[day] });
        else ops.push({ t: "remove", k });
      });
      Object.keys(p.dayIndexes).forEach((day) => {
        const key = repo.dayIndexKey(day);
        if (oldDayKeys.indexOf(key) < 0)
          ops.push({ t: "set", k: key, v: p.dayIndexes[day] });
      });
      oldProjectKeys.forEach((k) => {
        const id = k.slice("yotick/p/".length);
        if (p.projectIndexes[id])
          ops.push({ t: "set", k, v: p.projectIndexes[id] });
        else ops.push({ t: "remove", k });
      });
      Object.keys(p.projectIndexes).forEach((id) => {
        const key = repo.projectSessionsKey(id);
        if (oldProjectKeys.indexOf(key) < 0)
          ops.push({ t: "set", k: key, v: p.projectIndexes[id] });
      });
      if (p.prefs) ops.push({ t: "set", k: repo.PREFS, v: p.prefs });
      ops.push({
        t: "set",
        k: "yotick/rest-round-count",
        v: p.completedRounds,
      });
      const meta = bumpedMeta(now);
      meta.nextCreationOrder = p.nextOrder;
      meta.activeSessionId = p.activeId || null;
      ops.push({ t: "set", k: repo.META, v: meta });
      if (unescape(encodeURIComponent(JSON.stringify(ops))).length > 650 * 1024)
        throw coded(
          "BACKUP_TOO_LARGE",
          "这份备份超出本机可安全合并的容量，原数据未修改",
        );
      await persist(input.operationId, ops);
      state.projects = p.projects;
      state.active = p.activeId ? p.newSessions[p.activeId] : null;
      state.prefs = p.prefs || state.prefs;
      state.dayCache = p.dayIndexes;
      state.projSessionCache = p.projectIndexes;
      applyMeta(meta);
      return {
        importedProjects: p.importedProjects,
        importedSessions: p.importedSessions,
        skippedProjects: p.skippedProjects,
        skippedSessions: p.skippedSessions,
      };
    });
  }

  async function clearAllData(input) {
    return command("clearAllData", input, async () => {
      await settleInternal();
      if (await adapter.get("yotick/sync/state"))
        throw coded(
          "ACCOUNT_CLEAR_REQUIRED",
          "账号空间请使用账号与同步中的数据操作，避免丢失未上传数据",
        );
      if (state.active)
        throw coded("ACTIVE_SESSION_EXISTS", "专注进行中，不能清空数据");
      const keys = await adapter.keys(),
        projectsCount = Object.keys(state.projects).length;
      let sessionsCount = 0;
      const sessionKeys = keys.filter((k) => k.indexOf("yotick/s/") === 0);
      for (let i = 0; i < sessionKeys.length; i++) {
        const s = await adapter.get(sessionKeys[i]);
        if (s) sessionsCount++;
      }
      const now = nowSnapshot(),
        newMeta = {
          id: genId(),
          schemaVersion: SCHEMA_VERSION,
          dataRevision: 0,
          utcOffsetMinutes: 480,
          activeSessionId: null,
          nextCreationOrder: 1,
          lastMonotonicSec: now,
          createdAtSec: now,
        };
      const ops = keys
        .filter(
          (k) =>
            k.indexOf("yotick/") === 0 &&
            k.indexOf(repo.COMMIT_PREFIX) !== 0 &&
            k !== repo.META &&
            k !== repo.PROJECTS,
        )
        .map((k) => ({ t: "remove", k }));
      ops.push(
        { t: "set", k: repo.PROJECTS, v: {} },
        { t: "set", k: repo.META, v: newMeta },
      );
      await persist(input.operationId, ops);
      state.meta = newMeta;
      state.projects = {};
      state.active = null;
      state.prefs = null;
      state.dayCache = {};
      state.projSessionCache = {};
      state.highWater = now;
      state.lastNow = now;
      return { deletedProjects: projectsCount, deletedSessions: sessionsCount };
    });
  }

  // 索引全量重建内部实现（L08）：从会话事实重算日索引与项目会话索引。
  // 注意：不得 enqueue——本函数可能在已排队任务中被调用，嵌套入队会死锁。
  async function repairLocalDataInternal() {
    try {
      const allKeys = await adapter.keys();
      const sessionKeys = allKeys.filter((k) => k.indexOf("yotick/s/") === 0);
      const sessions = [];
      for (let i = 0; i < sessionKeys.length; i++) {
        const s = await adapter.get(sessionKeys[i]);
        if (!s) continue;
        const ve = validateSession(s);
        if (ve) throw coded("DATA_CORRUPT", ve);
        sessions.push(s);
      }
      const now = nowSnapshot();
      const newDayIndexes = {};
      const newProjectIndexes = {};
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const endRef = s.status === "COMPLETED" ? s.endedAtSec : now;
        const first = time.dayIndex(s.startedAtSec);
        const last = time.dayIndex(Math.max(s.startedAtSec, endRef - 1));
        for (let d = first; d <= last; d++) {
          const dk = time.dayKeyOfIndex(d);
          if (!newDayIndexes[dk]) newDayIndexes[dk] = [];
          if (newDayIndexes[dk].indexOf(s.id) === -1)
            newDayIndexes[dk].push(s.id);
        }
        if (!newProjectIndexes[s.projectId])
          newProjectIndexes[s.projectId] = [];
        if (newProjectIndexes[s.projectId].indexOf(s.id) === -1)
          newProjectIndexes[s.projectId].push(s.id);
      }

      const ops = [];
      const oldDayKeys = allKeys.filter((k) => k.indexOf("yotick/d/") === 0);
      for (let i = 0; i < oldDayKeys.length; i++) {
        const dk = oldDayKeys[i].slice("yotick/d/".length);
        if (newDayIndexes[dk]) {
          newDayIndexes[dk].sort();
          ops.push({ t: "set", k: oldDayKeys[i], v: newDayIndexes[dk] });
        } else {
          ops.push({ t: "remove", k: oldDayKeys[i] });
        }
        state.dayCache[dk] = newDayIndexes[dk] ? newDayIndexes[dk].slice() : [];
      }
      Object.keys(newDayIndexes).forEach((dk) => {
        const key = repo.dayIndexKey(dk);
        if (oldDayKeys.indexOf(key) === -1) {
          newDayIndexes[dk].sort();
          ops.push({ t: "set", k: key, v: newDayIndexes[dk] });
          state.dayCache[dk] = newDayIndexes[dk].slice();
        }
      });

      const oldProjKeys = allKeys.filter((k) => k.indexOf("yotick/p/") === 0);
      for (let i = 0; i < oldProjKeys.length; i++) {
        const pid = oldProjKeys[i].slice("yotick/p/".length);
        if (newProjectIndexes[pid]) {
          ops.push({ t: "set", k: oldProjKeys[i], v: newProjectIndexes[pid] });
        } else {
          ops.push({ t: "remove", k: oldProjKeys[i] });
        }
        state.projSessionCache[pid] = newProjectIndexes[pid]
          ? newProjectIndexes[pid].slice()
          : [];
      }
      Object.keys(newProjectIndexes).forEach((pid) => {
        const key = repo.projectSessionsKey(pid);
        if (oldProjKeys.indexOf(key) === -1) {
          ops.push({ t: "set", k: key, v: newProjectIndexes[pid] });
          state.projSessionCache[pid] = newProjectIndexes[pid].slice();
        }
      });

      await persist("system:repair", ops);
      return okEnvelope({ repaired: true, sessions: sessions.length });
    } catch (e) {
      if (e.code) return failEnvelope(e.code, e.message, e.extra);
      return failEnvelope("DATA_CORRUPT", e.message);
    }
  }

  // 对外入口：串行队列中执行
  async function repairLocalData() {
    return enqueue(() => repairLocalDataInternal());
  }

  // ---------------- 偏好 / 提示 ----------------
  async function getPrefs() {
    return state.prefs || {};
  }

  async function savePrefs(patch) {
    return enqueue(async () => {
      const newPrefs = Object.assign({}, state.prefs || {}, patch || {});
      try {
        await persist("prefs:" + genId(), [
          { t: "set", k: repo.PREFS, v: newPrefs },
        ]);
      } catch (e) {
        return failEnvelope("STORAGE_WRITE_FAILED", "偏好保存失败");
      }
      state.prefs = newPrefs;
      return okEnvelope(newPrefs);
    });
  }

  function takeNotices() {
    const out = state.notices.slice();
    state.notices = [];
    return out;
  }

  function dismissClockAnomaly() {
    state.clockAnomaly = null;
  }

  async function syncTransaction(fn) {
    return enqueue(async () => {
      if (state.blocked) throw coded(state.blocked.code, state.blocked.message);
      // init and persist recover journals inside this same serialized queue.
      // Read-only sync state lookups must not rescan thousands of fact files.
      let factsChanged = false;
      const result = await fn({
        adapter,
        projects: deepClone(state.projects),
        active: deepClone(state.active),
        prefs: deepClone(state.prefs),
        meta: deepClone(state.meta),
        commit: async (id, ops) => {
          const result = await persist(id, ops, true);
          if (
            ops.some((op) =>
              /^yotick\/(meta$|projects$|prefs$|s\/|d\/|p\/|fact-view$)/.test(
                op.k,
              ),
            )
          )
            factsChanged = true;
          return result;
        },
      });
      if (factsChanged) {
        await reloadFromStorage();
        state.prefs = (await adapter.get(repo.PREFS)) || null;
        state.dayCache = {};
        state.projSessionCache = {};
      }
      return result;
    });
  }

  async function buildSyncView(build, guard = () => {}) {
    let capturedEpoch;
    const context = await syncTransaction((ctx) => {
      guard();
      capturedEpoch = syncEpoch;
      return {
        ...ctx,
        commit: (id, ops) =>
          syncTransaction((current) => {
            guard();
            if (syncEpoch !== capturedEpoch)
              throw coded(
                "LOCAL_CHANGED",
                "本机资料已变化，全量视图将重新构建",
              );
            return current.commit(id, ops);
          }),
      };
    });
    // File staging is outside the command queue. A local command can finish
    // while it is built; the final guarded pointer switch refuses stale facts.
    return build(context);
  }

  return {
    retire: () => {
      retired = true;
      state.blocked = {
        code: "SPACE_CHANGED",
        message: "账号已切换，请刷新后重试",
      };
    },
    init,
    createProject,
    renameProject,
    setProjectAppearance,
    updateProjectDetails,
    moveProjectOrder,
    createBackup,
    previewBackup,
    importBackup,
    clearAllData,
    start,
    pause,
    resume,
    stop,
    archiveProject,
    restoreProject,
    deleteProject,
    deleteSession,
    reduceSessionDuration,
    getCurrent,
    peekCurrent,
    getRecords,
    getStatistics,
    getHeatmap,
    getPickerData,
    getManageData,
    repairLocalData,
    getPrefs,
    savePrefs,
    takeNotices,
    dismissClockAnomaly,
    syncTransaction,
    buildSyncView,
  };
}

module.exports = { createService };
