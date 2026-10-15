const {
  createAccountAdapter,
  migrateLegacy,
} = require("../storage/account-adapter");
const { createService } = require("../core/service");
const local = require("./local");
const { createRequest } = require("./request");
const { createWorker } = require("./worker");
const { uuid } = require("../core/ids");
const repo = require("../core/repository");
const GLOBAL = "yotick-global/";
async function loginStep(label, work) {
  try {
    return await work();
  } catch (error) {
    const platform = String((error && error.errMsg) || "");
    const match = platform.match(/^[A-Za-z]+:fail[^,\r\n]*/);
    const reason = (error && error.message) || (match && match[0]) || "平台调用失败";
    const safeReason = String(reason)
      .replace(/(?:wxfile|https?):\/\/\S+|[A-Za-z]:[\\/]\S+|\/\S+/g, "[path]")
      .slice(0, 200);
    const failure = new Error(label + "：" + safeReason);
    if (error && error.code) failure.code = error.code;
    throw failure;
  }
}
function createAccounts(
  raw,
  app,
  { baseUrl = require("./config").apiBaseUrl, transport } = {},
) {
  let activationQueue = Promise.resolve();
  let epoch = 0,
    worker = null,
    current = null,
    request = null,
    status = { state: "guest" },
    listeners = new Set();
  let legacyFallback = false;
  const update = (s) => {
    // A new worker state replaces the previous failure, while pending-only
    // local updates keep the current connection status and its explanation.
    status = { ...status, ...(s.state ? { message: "", code: undefined } : {}), ...s };
    listeners.forEach((fn) => fn(status));
  };
  async function canSwitch() {
    const service = app.globalData.service;
    if (service) {
      const env = await service.getCurrent();
      if (!env.ok) throw new Error(env.error.message);
      if (env.data.sessionId || env.data.activeSession)
        throw new Error("专注进行中，请先结束专注");
      const snapshot = service.peekCurrent();
      if (snapshot.ok && snapshot.data.status === "ACTIVE")
        throw new Error("专注进行中，请先结束专注");
    }
    const adapter = app.globalData.adapter;
    if (adapter && (await adapter.get("yotick/rest-break/v1")))
      throw new Error("休息计时进行中，请先结束休息");
  }
  async function activate(ref, initial = false) {
    const pending = activationQueue.then(() => activateScope(ref, initial));
    activationQueue = pending.catch(() => {});
    return pending;
  }
  async function activateScope(ref, initial = false) {
    if (legacyFallback)
      throw new Error("本机空间升级未完成，请先保全备份并处理升级问题后重启");
    if (!initial) await canSwitch();
    const previousService = app.globalData.service;
    const previousAdapter = app.globalData.adapter;
    const adapter = createAccountAdapter(
      raw,
      ref
        ? ref.spaceId +
            "@" +
            ref.generation +
            (ref.localEpoch ? "@" + ref.localEpoch : "")
        : "guest",
    );
    if (ref) {
      const state = await adapter.get(local.STATE);
      if (!state)
        await adapter.set(local.STATE, {
          userId: ref.userId,
          spaceId: ref.spaceId,
          generation: ref.generation,
          nextOrder: 0,
        });
    }
    const service = createService(adapter, {
      onLocalCommit: () => {
        if (app.globalData.adapter !== adapter) return;
        local
          .pending(adapter)
          .then((p) => {
            if (app.globalData.adapter !== adapter) return;
            update({ pending: p.length });
            if (worker) worker.trigger();
          })
          .catch(() => {});
      },
    });
    const env = await service.init();
    if (!env.ok) throw new Error(env.error.message);
    const install = async (ctx) => {
      if (
        !initial &&
        (ctx?.active ||
          (previousAdapter &&
            (await previousAdapter.get("yotick/rest-break/v1"))))
      )
        throw new Error("计时进行中，请先结束后切换账号");
      await raw.set(GLOBAL + "current", ref || null);
      epoch++;
      if (worker) worker.stop();
      worker = null;
      if (request) request.cancel();
      request = null;
      if (previousService) previousService.retire();
      current = ref || null;
      app.globalData.adapter = adapter;
      app.globalData.service = service;
    };
    if (previousService) await previousService.syncTransaction(install);
    else await install();
    await require("../utils/color").initProjectColors(adapter);
    if (!ref) {
      update({ state: "guest", pending: 0 });
      return;
    }
    const captured = epoch,
      tokenKey = GLOBAL + "credentials/" + ref.userId,
      credentials = await raw.get(tokenKey);
    if (!credentials || !baseUrl) {
      update({
        state: "auth-required",
        pending: (await local.pending(adapter)).length,
      });
      return;
    }
    request = createRequest({
      baseUrl,
      credentials,
      transport,
      saveCredentials: async (value) => {
        if (epoch !== captured)
          throw Object.assign(new Error("账号已切换"), { code: "CANCELLED" });
        await raw.set(tokenKey, value);
      },
    });
    worker = createWorker({
      service,
      request,
      deviceId: await raw.get(GLOBAL + "deviceId"),
      isCurrent: () => captured === epoch,
      onStatus: update,
      onChanged: () => {
        require("../utils/color")
          .initProjectColors(adapter)
          .catch(() => {});
        listeners.forEach((fn) => fn(status));
        if (typeof getCurrentPages === "function") {
          const pages = getCurrentPages(),
            top = pages[pages.length - 1];
          const refresh = top && (top.refresh || top.load);
          if (typeof refresh === "function")
            Promise.resolve(refresh.call(top)).catch(() => {});
        }
      },
    });
    worker.trigger();
  }
  async function init() {
    try {
      await migrateLegacy(raw);
    } catch (error) {
      legacyFallback = true;
      const adapter = {
        ...raw,
        namespace: "legacy",
        getSync: raw.getStorageSync?.bind(raw),
        setSync: raw.setStorageSync?.bind(raw),
        removeSync: raw.removeStorageSync?.bind(raw),
      };
      const service = createService(adapter, { syncEnabled: false });
      app.globalData.adapter = adapter;
      app.globalData.service = service;
      const env = await service.init();
      if (env.ok)
        try {
          await require("../utils/color").initProjectColors(adapter);
        } catch (e) {}
      update({
        state: "upgrade-required",
        pending: 0,
        message: "空间升级未完成，已保留原本机资料。" + error.message,
      });
      return env;
    }
    if (!(await raw.get(GLOBAL + "deviceId")))
      await raw.set(GLOBAL + "deviceId", uuid());
    app.globalData.guestSession = (await raw.get(GLOBAL + "auto-login")) === false;
    let savedRef = await raw.get(GLOBAL + "current");
    if (savedRef && require('./environment').isDevToolsDevelopment() &&
        baseUrl === 'https://' + require('./environment').TEMP_CLOUD_DEBUG_API_HOST + '/api/v1' &&
        savedRef.apiBaseUrl !== baseUrl) {
      // Preserve the old test cache, but never send its queued edits to cloud.
      await raw.set(GLOBAL + 'previous-local-account', savedRef);
      savedRef = null;
    }
    await activate(savedRef, true);
  }
  async function login() {
    await loginStep("检查当前计时状态失败", () => canSwitch());
    if (!baseUrl) throw new Error("云端服务尚未配置，数据仍保存在本机");
    const code = await loginStep("获取微信登录凭证失败", () => new Promise((resolve, reject) =>
      wx.login({
        success: (r) =>
          r.code ? resolve(r.code) : reject(new Error("微信登录未返回凭证")),
        fail: reject,
      }),
    ));
    const req = createRequest({
      baseUrl,
      transport,
      credentials: null,
      saveCredentials: async () => {},
    });
    const credentials = await loginStep("验证微信身份失败", async () => req("POST", "/auth/wechat-mini", {
      code,
      deviceId: await raw.get(GLOBAL + "deviceId"),
    }));
    const who = await loginStep("读取账号信息失败", () => createRequest({
      baseUrl,
      transport,
      credentials,
      saveCredentials: async () => {},
    })("GET", "/me"));
    const ref = {
      apiBaseUrl: baseUrl,
      ...(require('./environment').isDevToolsDevelopment() &&
          baseUrl === 'https://' + require('./environment').TEMP_CLOUD_DEBUG_API_HOST + '/api/v1'
        ? { localEpoch:'cloud-devtools-v1' } : {}),
      userId: who.userId || who.user?.id,
      spaceId: who.spaceId || who.space?.id,
      generation: who.generation || who.space?.generation,
    };
    if (!ref.userId || !ref.spaceId) throw new Error("账号服务返回信息不完整");
    await loginStep("保存登录信息失败", () => raw.set(GLOBAL + "credentials/" + ref.userId, credentials));
    await raw.set(GLOBAL + "auto-login", true);
    await loginStep("打开账号空间失败", () => activate(ref));
    app.globalData.guestSession = false;
    return ref;
  }
  async function logout() {
    await canSwitch();
    if (request) {
      try {
        await request("POST", "/auth/logout", {});
      } catch (e) {
        if (e.code !== "AUTH_REQUIRED" && e.code !== "NETWORK_ERROR") throw e;
      }
    }
    const ref = current;
    await raw.set(GLOBAL + "auto-login", false);
    await activate(null);
    app.globalData.guestSession = true;
    if (ref) await raw.remove(GLOBAL + "credentials/" + ref.userId);
  }
  async function getDisplayProfile() {
    return current ? (await raw.get(GLOBAL + 'profile/' + current.userId)) || null : null;
  }
  async function saveDisplayProfile(value, avatarStore = require('./display-profile')) {
    if (!current) throw new Error('请先登录账号');
    const captured = epoch, userId = current.userId;
    const profile = require('./display-profile').normalizeProfile(value);
    const key = GLOBAL + 'profile/' + userId;
    const previous = await raw.get(key);
    const savedPath = await avatarStore.keepAvatar(profile.avatarUrl);
    try {
      if (captured !== epoch) throw new Error('账号已切换，请重新确认资料');
      await raw.set(key, { ...profile, avatarUrl:savedPath, userId });
    } catch (error) {
      await avatarStore.discardAvatar(savedPath);
      throw error;
    }
    if (previous && previous.avatarUrl !== savedPath) await avatarStore.discardAvatar(previous.avatarUrl);
    update({});
    return { ...profile, avatarUrl:savedPath, userId };
  }
  async function stayGuest() {
    await raw.set(GLOBAL + 'auto-login', false);
    app.globalData.guestSession = true;
  }
  async function conflicts() {
    const adapter = app.globalData.adapter,
      keys = (await adapter.keys()).filter(
        (k) => k.indexOf("yotick/conflicts/") === 0,
      ),
      result = [];
    for (const k of keys) result.push(await adapter.get(k));
    return result;
  }
  async function resolveConflict(id, choice, options = {}) {
    await canSwitch();
    const service = app.globalData.service;
    const resolutionEpoch = epoch;
    let cloudChanges = [];
    await service.syncTransaction(async (ctx) => {
      const c = await ctx.adapter.get(local.conflictKey(id));
      if (!c) throw new Error("冲突不存在");
      const cloud = c.cloud,
        ops = [{ t: "set", k: "yotick/recovery/" + id, v: c }];
      const tasks = await local.pending(ctx.adapter);
      const affected = new Set(c.operationIds || []);
      if (cloud)
        for (const t of tasks)
          if (
            t.kind.split(".")[0] === cloud.entityType &&
            (t.entityId === cloud.entityId ||
              t.related.includes(cloud.entityId))
          )
            affected.add(t.operationId);
      // A sibling/subtree operation is one decision. Expand overlapping groups
      // before discarding tasks, rather than retaining half of a local group.
      const entityIds = new Set(cloud ? [cloud.entityId] : []);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const task of tasks) {
          if (
            !affected.has(task.operationId) &&
            (!cloud ||
              task.kind.split(".")[0] !== cloud.entityType ||
              ![task.entityId]
                .concat(task.related || [])
                .some((key) => entityIds.has(key)))
          )
            continue;
          if (!affected.has(task.operationId)) {
            affected.add(task.operationId);
            expanded = true;
          }
          for (const key of [task.entityId].concat(task.related || []))
            if (!entityIds.has(key)) {
              entityIds.add(key);
              expanded = true;
            }
        }
      }
      ops[0].v = {
        ...c,
        preservedTasks: tasks.filter((t) => affected.has(t.operationId)),
      };
      if (c.resolving === "cloud") {
        const saved = await ctx.adapter.get("yotick/recovery/" + id);
        if (saved) ops[0].v = saved;
      }
      if (choice === "cloud") {
        if (!cloud?.entityType) throw new Error("先同步获取云端版本");
        cloudChanges = c.resolutionChanges || [];
        if (!cloudChanges.length) {
          for (const entityId of entityIds) {
            const shadow =
              entityId === cloud.entityId
                ? cloud
                : await ctx.adapter.get(
                    local.shadowKey(cloud.entityType, entityId),
                  );
            if (!shadow)
              throw new Error("相关资料的云端版本尚未拉取，请先同步");
            cloudChanges.push(shadow);
          }
        }
        ops.push({
          t: "set",
          k: local.conflictKey(id),
          v: { ...c, resolutionChanges: cloudChanges, resolving: "cloud" },
        });
        for (const task of tasks)
          if (affected.has(task.operationId))
            ops.push(
              { t: "remove", k: local.itemKey(task.operationId) },
              { t: "remove", k: "yotick/outbox-state/" + task.operationId },
            );
          else if (affected.has(task.dependsOn))
            ops.push({
              t: "set",
              k: local.itemKey(task.operationId),
              v: { ...task, dependsOn: null },
            });
        await ctx.commit("resolve-preserve:" + uuid(), ops);
      } else if (choice === "local") {
        if (cloud?.deleted)
          throw new Error("已删除内容须另建项目或重新归属后保存");
        for (const task of tasks)
          if (affected.has(task.operationId)) {
            if (task.kind === "session.createCompleted")
              throw new Error("同 ID 记录冲突请导出恢复副本后新建记录");
            ops.push(
              { t: "remove", k: local.itemKey(task.operationId) },
              { t: "remove", k: "yotick/outbox-state/" + task.operationId },
            );
          }
        if (!cloud) throw new Error("请先获取云端版本");
        const payload =
          cloud.entityType === "prefs"
            ? local.pickPrefs(ctx.prefs)
            : local.projectPayload(
                ctx.projects[cloud.entityId] || c.local?.payload || c.local,
              );
        const s = await ctx.adapter.get(local.STATE);
        let kind =
            cloud.entityType === "prefs" ? "prefs.patch" : "project.patch",
          related = [],
          newPayload =
            cloud.entityType === "prefs"
              ? payload
              : {
                  name: options.name || payload.name,
                  color: payload.color,
                  shortName: payload.shortName || "",
                };
        const groupKinds = [
          "project.archive",
          "project.restore",
          "project.reorder",
          "project.deleteSubtree",
        ];
        const groupTask = groupKinds.includes(c.local?.kind)
          ? c.local
          : tasks.find(
              (t) => affected.has(t.operationId) && groupKinds.includes(t.kind),
            );
        if (groupTask) {
          kind = groupTask.kind;
          newPayload = local.clone(groupTask.payload);
          related = groupTask.related || [];
        }
        const task = {
          operationId: uuid(),
          kind,
          entityId: groupTask?.entityId || cloud.entityId,
          payload: newPayload,
          related,
          order: (s.nextOrder || 0) + 1,
          status: "queued",
          generation: s.generation,
          bases: {
            [cloud.entityType + "/" + cloud.entityId]: cloud.serverVersion,
          },
          dependencies: {},
        };
        for (const entityId of related) {
          const shadow =
            entityId === cloud.entityId
              ? cloud
              : await ctx.adapter.get(local.shadowKey("project", entityId));
          if (!shadow || shadow.deleted)
            throw new Error("相关项目的云端版本不可用，请先同步");
          task.bases["project/" + entityId] = shadow.serverVersion;
        }
        for (const remaining of tasks.filter(
          (t) => !affected.has(t.operationId),
        ))
          if (affected.has(remaining.dependsOn))
            ops.push({
              t: "set",
              k: local.itemKey(remaining.operationId),
              v: { ...remaining, dependsOn: null },
            });
        let nextOrder = task.order;
        const additional = [];
        if (groupTask && kind !== "project.deleteSubtree") {
          // Keep current scalar edits too; selecting a group conflict must not
          // quietly discard a later local rename/color change.
          for (const entityId of related) {
            const shadow =
              entityId === cloud.entityId
                ? cloud
                : await ctx.adapter.get(local.shadowKey("project", entityId));
            const fact = ctx.projects[entityId],
              patch = {};
            if (!fact) continue;
            for (const field of ["name", "color", "shortName"])
              if ((fact[field] || "") !== (shadow.data[field] || ""))
                patch[field] = fact[field] || "";
            if (!Object.keys(patch).length) continue;
            const key = "project/" + entityId;
            additional.push({
              operationId: uuid(),
              kind: "project.patch",
              entityId,
              payload: patch,
              related: [],
              order: ++nextOrder,
              status: "queued",
              generation: s.generation,
              dependsOn: task.operationId,
              bases: { [key]: shadow.serverVersion },
              dependencies: { [key]: task.operationId },
            });
          }
        }
        ops.push(
          ...additional.map((t) => ({
            t: "set",
            k: local.itemKey(t.operationId),
            v: t,
          })),
        );
        ops.push(
          { t: "set", k: local.itemKey(task.operationId), v: task },
          { t: "set", k: local.STATE, v: { ...s, nextOrder } },
          {
            t: "set",
            k: local.shadowKey(cloud.entityType, cloud.entityId),
            v: cloud,
          },
        );
        await ctx.commit("resolve-local:" + uuid(), ops);
      } else throw new Error("请选择保留方式");
      if (choice !== "cloud")
        await ctx.commit("resolve-remove:" + uuid(), [
          { t: "remove", k: local.conflictKey(id) },
        ]);
    });
    if (choice === "cloud") {
      // Applying cached facts requires no network or credentials. Keep the
      // conflict until facts are durable, so interruption remains retryable.
      const applier = createWorker({
        service,
        isCurrent: () => epoch === resolutionEpoch,
      });
      await applier.apply(cloudChanges);
      await service.syncTransaction((ctx) =>
        ctx.commit("resolve-complete:" + uuid(), [
          { t: "remove", k: local.conflictKey(id) },
        ]),
      );
    }
    if (worker) worker.trigger();
  }
  async function clearAccount() {
    await canSwitch();
    if (!request || !current) throw new Error("请先登录");
    const adapter = app.globalData.adapter,
      s = await adapter.get(local.STATE),
      key = "yotick/sync/clear-request";
    let b = await adapter.get(key);
    if (!b) {
      b = {
        generation: s.generation,
        operationId: uuid(),
        confirmation: "DELETE_ALL_ACCOUNT_DATA",
      };
      await adapter.set(key, b);
    }
    const result = await request("POST", "/data/clear", b);
    await app.globalData.service.syncTransaction(async (ctx) => {
      const ops = [
        {
          t: "set",
          k: "yotick/recovery/clear-" + s.generation,
          v: {
            generation: s.generation,
            backup: (await adapter.keys()).filter((k) =>
              k.startsWith("yotick/outbox/"),
            ),
          },
        },
        {
          t: "set",
          k: local.STATE,
          v: { ...s, quarantined: true, clearedGeneration: result.generation },
        },
      ];
      await ctx.commit("clear-quarantine:" + b.operationId, ops);
    });
    await activate({ ...current, generation: result.generation });
  }
  async function listRecoverySpaces() {
    const spaces = [];
    for (const key of await raw.keys()) {
      const match =
        /^yotick-space\/([^/]+)\/(?:@views\/([^/]+)\/)?yotick\/meta$/.exec(key);
      if (!match) continue;
      const sourceNamespace = decodeURIComponent(match[1]),
        viewId = match[2] ? decodeURIComponent(match[2]) : null;
      if (
        sourceNamespace !== "guest" &&
        !(current && sourceNamespace.startsWith(current.spaceId + "@"))
      )
        continue;
      const activeView =
        (await raw.get("yotick-space/" + match[1] + "/yotick/fact-view")) ||
        null;
      if (
        sourceNamespace === app.globalData.adapter.namespace &&
        viewId === activeView
      )
        continue;
      const namespace = sourceNamespace + "|view:" + (viewId || "base");
      spaces.push({
        namespace,
        sourceNamespace,
        viewId,
        label:
          sourceNamespace === "guest"
            ? "游客原副本"
            : "账号恢复副本 · 代次 " +
              sourceNamespace.split("@")[1] +
              (viewId ? " · 历史视图" : ""),
      });
    }
    return spaces;
  }
  async function exportRecovery(namespace) {
    let adapter = app.globalData.adapter,
      backup;
    if (namespace) {
      const selected = (await listRecoverySpaces()).find(
        (s) => s.namespace === namespace,
      );
      if (!selected) throw new Error("无法访问该空间");
      adapter = createAccountAdapter(raw, selected.sourceNamespace, {
        viewId: selected.viewId,
      });
      const meta = await adapter.get(repo.META),
        projects = (await adapter.get(repo.PROJECTS)) || {},
        sessions = [];
      for (const key of await adapter.keys())
        if (key.startsWith("yotick/s/")) {
          const session = await adapter.get(key);
          if (session) sessions.push(session);
        }
      backup = {
        ok: true,
        data: {
          formatVersion: 1,
          exportedAtSec: Math.floor(Date.now() / 1000),
          spaceId: meta.id,
          meta: {
            schemaVersion: meta.schemaVersion,
            utcOffsetMinutes: meta.utcOffsetMinutes,
          },
          projects: Object.values(projects),
          sessions,
          prefs: (await adapter.get(repo.PREFS)) || {},
        },
      };
    } else backup = await app.globalData.service.createBackup();
    if (!backup.ok) throw new Error(backup.error.message);
    const extra = {};
    for (const key of await adapter.keys())
      if (
        /^yotick\/(outbox|outbox-state|shadow|conflicts|recovery|recovery-jobs|sync|import|import-history|receipts|c)\//.test(
          key,
        )
      )
        extra[key] = await adapter.get(key);
    return {
      formatVersion: 2,
      localBackup: backup.data,
      syncRecovery: extra,
      exportedAt: Date.now(),
    };
  }
  async function migrateGuest() {
    await canSwitch();
    if (!current || !request) throw new Error("请先登录账号");
    // Finish account edits (especially deletions) before comparing the guest copy.
    await worker.trigger();
    if ((await local.pending(app.globalData.adapter)).length || (await conflicts()).length)
      throw new Error('账号还有更改未保存，请联网完成保存后再试。登录前的记录会保留');
    return require("./migration").upload(
      raw,
      app.globalData.adapter,
      request,
      current.generation,
      (progress) => update({ migration: progress }),
    );
  }
  async function getGuestSummary() {
    const summary = await require("./migration").guestSummary(raw);
    summary.checked = !current || !summary.hasData;
    if (current && worker && summary.hasData) {
      if (status.state !== 'synced') await worker.trigger();
      // Only suppress a prompt after successfully checking the account.
      if (status.state === 'synced') {
        const pending = await require('./guest-pending').pendingGuest(raw, app.globalData.adapter);
        if (pending) Object.assign(summary, pending, { checked:true });
      }
    }
    const decision = current && await raw.get(GLOBAL + "guest-import/" + current.userId);
    const imported = await app.globalData.adapter.get("yotick/import/current");
    const alreadyImported = !!(imported && imported.status === "committed" && imported.guestSignature === summary.signature);
    return {
      ...summary,
      imported: alreadyImported,
      shouldAsk: summary.checked && summary.hasData && !(decision && decision.signature === summary.signature) &&
        !alreadyImported,
    };
  }
  async function deferGuestImport(signature) {
    if (!current) throw new Error("请先登录账号");
    await raw.set(GLOBAL + "guest-import/" + current.userId, { signature, choice: "deferred" });
  }
  async function commitGuestMigration(mapping, sessionMapping, options) {
    await canSwitch();
    if (!request) throw new Error("请先登录");
    const result = await require("./migration").commit(
      app.globalData.adapter,
      request,
      await raw.get(GLOBAL + "deviceId"),
      mapping,
      sessionMapping,
      options,
    );
    await worker.trigger();
    return result;
  }
  async function exportAccount() {
    if (!request || !current) throw new Error("请先登录");
    const job = await request("POST", "/exports", {
      generation: current.generation,
    });
    const items = [];
    let offset = 0;
    while (true) {
      const page = await request("GET", "/exports/" + job.id, { offset });
      items.push(...page.changes);
      if (!page.hasMore) break;
      offset = page.nextOffset;
    }
    return {
      formatVersion: 2,
      spaceId: current.spaceId,
      generation: current.generation,
      upperSeq: job.upperSeq,
      items,
    };
  }
  async function recoverConflict(id, projectId, newName) {
    await canSwitch();
    const adapter = app.globalData.adapter,
      jobKey = "yotick/recovery-jobs/" + id;
    let job = await adapter.get(jobKey);
    if (job?.phase === "complete") return job.result;
    const c = await adapter.get(local.conflictKey(id));
    if (!c) throw new Error("冲突不存在");
    const source = c.local?.payload || c.local || c.cloud?.data;
    if (!source) throw new Error("没有可恢复的本机资料");
    if (!job) {
      job = {
        phase: "planned",
        targetProjectId: projectId || uuid(),
        newProject: !projectId,
        projectName: newName,
        projectOperationId: uuid(),
        importOperationId: uuid(),
        appearanceOperationId: uuid(),
        newSessionId: uuid(),
        pauseIds: (source.pauses || []).map(() => uuid()),
      };
      await adapter.set(jobKey, job);
    }
    if (job.newProject) {
      const result = await app.globalData.service.createProject({
        operationId: job.projectOperationId,
        newProjectId: job.targetProjectId,
        name: job.projectName,
      });
      if (!result.ok) throw new Error(result.error.message);
    }
    const target = job.targetProjectId;
    if (source.status === "COMPLETED") {
      const session = {
        ...source,
        id: job.newSessionId,
        projectId: target,
        spaceId: (await adapter.get(repo.META)).id,
        revision: 1,
      };
      session.pauses = session.pauses.map((p, i) => ({
        ...p,
        id: job.pauseIds[i],
        sessionId: session.id,
      }));
      const backup = await app.globalData.service.createBackup();
      if (!backup.ok) throw new Error(backup.error.message);
      const result = await app.globalData.service.importBackup({
        operationId: job.importOperationId,
        backup: { ...backup.data, sessions: [session], prefs: {} },
      });
      if (!result.ok) throw new Error(result.error.message);
    } else if (source.name) {
      const project = (await adapter.get(repo.PROJECTS))[target];
      if (!project) throw new Error("请选择有效项目");
      const result = await app.globalData.service.setProjectAppearance({
        operationId: job.appearanceOperationId,
        projectId: target,
        color: source.color || project.color,
        shortName: source.shortName || "",
      });
      if (!result.ok) throw new Error(result.error.message);
    }
    const result = {
      projectId: target,
      sessionId: source.status === "COMPLETED" ? job.newSessionId : null,
    };
    await app.globalData.service.syncTransaction(async (ctx) => {
      const tasks = await local.pending(ctx.adapter),
        ops = [
          {
            t: "set",
            k: "yotick/recovery/" + id,
            v: {
              ...c,
              preservedTasks: tasks.filter((t) =>
                (c.operationIds || []).includes(t.operationId),
              ),
              sourceId: source.id,
              destination: result,
            },
          },
          { t: "remove", k: local.conflictKey(id) },
          { t: "set", k: jobKey, v: { ...job, phase: "complete", result } },
        ];
      for (const operationId of c.operationIds || [])
        ops.push(
          { t: "remove", k: local.itemKey(operationId) },
          { t: "remove", k: "yotick/outbox-state/" + operationId },
        );
      if (source.status === "COMPLETED") {
        const original = await ctx.adapter.get(repo.sessionKey(source.id));
        if (original?.status === "COMPLETED") {
          ops.push({ t: "remove", k: repo.sessionKey(source.id) });
          for (const key of await ctx.adapter.keys())
            if (key.startsWith("yotick/d/") || key.startsWith("yotick/p/")) {
              const ids = await ctx.adapter.get(key);
              if (Array.isArray(ids) && ids.includes(source.id))
                ops.push({
                  t: "set",
                  k: key,
                  v: ids.filter((sid) => sid !== source.id),
                });
            }
        }
      }
      await ctx.commit("recover-conflict:" + id, ops);
    });
    if (worker) {
      if (c.cloud?.entityType === "session" && !c.cloud.deleted)
        await worker.apply([c.cloud]);
      worker.trigger();
    }
    return result;
  }
  async function clearCache() {
    await canSwitch();
    if (!current) throw new Error("游客资料是唯一原副本，不能清缓存");
    if (!worker) throw new Error("请登录并同步后清除缓存");
    await worker.trigger();
    if (
      (await local.pending(app.globalData.adapter)).length ||
      (await conflicts()).length
    )
      throw new Error("有未上传资料或冲突，请先同步或导出保全");
    await activate({ ...current, localEpoch: uuid() });
  }
  async function deleteAccount() {
    await canSwitch();
    if (!request) throw new Error("请先登录");
    return request("POST", "/account/deletion-requests", {
      confirmation: "REQUEST_ACCOUNT_DELETION",
    });
  }
  async function getDeletionRequest() {
    if (!request) throw new Error("请先登录");
    return request("GET", "/account/deletion-requests", {});
  }
  async function createMigrationTarget(name) {
    await canSwitch();
    if (!worker) throw new Error("请先登录");
    const env = await app.globalData.service.createProject({
      operationId: uuid(),
      name,
    });
    if (!env.ok) throw new Error(env.error.message);
    await worker.trigger();
    const shadow = await app.globalData.adapter.get(
      local.shadowKey("project", env.data.project.id),
    );
    if (!shadow || shadow.deleted)
      throw new Error("新项目已保存在本机，待同步完成后选择它再合并");
    return { id: env.data.project.id, name: env.data.project.name };
  }
  return {
    init,
    login,
    getDisplayProfile,
    saveDisplayProfile,
    stayGuest,
    logout,
    activate,
    conflicts,
    resolveConflict,
    recoverConflict,
    clearAccount,
    exportRecovery,
    exportLocalBackup: () => app.globalData.service.createBackup(),
    listRecoverySpaces,
    migrateGuest,
    getGuestSummary,
    deferGuestImport,
    commitGuestMigration,
    exportAccount,
    clearCache,
    deleteAccount,
    getDeletionRequest,
    createMigrationTarget,
    trigger: () => (worker ? worker.trigger() : Promise.resolve()),
    getStatus: () => status,
    getCurrent: () => current,
    getRequest: () => request,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
module.exports = { createAccounts };
