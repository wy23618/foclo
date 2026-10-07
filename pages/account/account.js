const {
  resolveTheme,
  pageThemeData,
  navigationBarOptions,
} = require("../../utils/theme");

const STATUS_LABELS = {
  guest: "游客空间",
  syncing: "正在同步",
  synced: "已同步",
  pending: "等待同步",
  offline: "离线，资料已保存在本机",
  "upgrade-required": "空间升级待处理",
  failed: "同步失败",
  "auth-required": "需要重新登录",
  conflict: "有冲突待处理",
  quarantined: "空间已隔离",
};

function unwrap(result) {
  if (result && result.ok === false)
    throw new Error((result.error && result.error.message) || "操作失败");
  return result &&
    result.ok === true &&
    Object.prototype.hasOwnProperty.call(result, "data")
    ? result.data
    : result;
}

function formatTime(value) {
  if (!value) return "暂无同步记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "暂无同步记录"
    : "上次同步：" + date.toLocaleString();
}

function conflictText(value) {
  if (value == null) return "（无内容）";
  const data = value.data || value.payload || value;
  if (data.status === "COMPLETED")
    return (
      "开始：" +
      new Date(data.startedAtSec * 1000).toLocaleString() +
      "\n专注：" +
      data.durationSeconds +
      " 秒\n暂停：" +
      (data.pauses || []).length +
      " 次"
    );
  const labels = {
    name: "名称",
    color: "颜色",
    shortName: "简称",
    archived: "已归档",
    startupMode: "启动习惯",
    defaultMinutes: "默认分钟",
    commonMinutes: "常用时长",
    confirmEnd: "结束确认",
    dailyGoalEnabled: "每日目标开启",
    dailyGoalMinutes: "每日目标分钟",
    weekStartsSunday: "周日为每周起点",
    restEnabled: "休息开启",
    shortBreakMinutes: "短休息分钟",
    longBreakMinutes: "长休息分钟",
    longBreakEvery: "长休息轮次",
  };
  const rows = Object.keys(labels)
    .filter((k) => data[k] !== undefined)
    .map(
      (k) =>
        labels[k] +
        "：" +
        (typeof data[k] === "boolean"
          ? data[k]
            ? "是"
            : "否"
          : Array.isArray(data[k])
            ? data[k].join("、")
            : data[k]),
    );
  return rows.join("\n") || "该版本包含项目排序或层级修改";
}

Page({
  data: {
    themeClass: "light",
    status: "guest",
    statusLabel: STATUS_LABELS.guest,
    statusMessage: "",
    accountLabel: "游客空间",
    pending: 0,
    syncedAt: "暂无同步记录",
    conflicts: [],
    busy: false,
    hasAccount: false,
    canClearCache: false,
    exportedRecovery: false,
    migrationPreview: null,
    migrationSummary: "",
    mappingRows: [],
    mapping: {},
    projectChoices: [{ id: "", name: "保留为独立项目" }],
    recoveryChoices: [{ id: "", name: "另建项目保存" }],
    recoveryChoiceName: "另建项目保存",
    sessionRows: [],
    sessionMapping: {},
    recoveryPanel: false,
    recoveryConflictId: "",
    recoveryProjectId: "",
    recoveryName: "",
  },

  async onShow() {
    const app = getApp();
    if (!app.globalData.ready && app.globalData.readyPromise)
      await app.globalData.readyPromise;
    this.accounts = app.globalData.accounts;
    if (!this.accounts)
      return this.setData({ statusMessage: "账号服务暂不可用" });
    if (!this.unsubscribe)
      this.unsubscribe = this.accounts.subscribe((status) =>
        this.applyStatus(status),
      );
    await this.refresh();
    const service = app.globalData.service;
    try {
      const prefs = service && (await service.getPrefs());
      const themeClass = resolveTheme(
        (prefs && prefs.theme) || "system",
        prefs && prefs.lightTheme,
      );
      this.setData(
        Object.assign({}, pageThemeData(themeClass), { themeClass }),
      );
      try {
        wx.setNavigationBarColor(navigationBarOptions(themeClass));
      } catch (e) {}
    } catch (e) {}
  },

  onUnload() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  },

  applyStatus(status) {
    status = status || {};
    const account = this.accounts && this.accounts.getCurrent();
    const pending = Number.isFinite(status.pending) ? status.pending : 0;
    const conflicts = Array.isArray(status.conflicts)
      ? status.conflicts
      : this.data.conflicts;
    this.setData({
      status: status.state || "guest",
      statusLabel: STATUS_LABELS[status.state] || "状态未知",
      statusMessage: status.message || "",
      accountLabel: account
        ? "微信账号 · " + account.userId.slice(-4)
        : "游客空间",
      hasAccount: !!account,
      pending,
      syncedAt: formatTime(status.lastSyncedAt),
      conflicts,
      canClearCache: pending === 0 && Number.isFinite(status.pending),
    });
  },

  async refresh() {
    try {
      const status = this.accounts.getStatus();
      this.applyStatus(status);
      const list = await this.accounts.conflicts();
      const conflicts = (list || []).map((item) =>
        Object.assign({}, item, {
          cloudText: conflictText(item.cloud),
          localText: conflictText(item.local),
          codeLabel:
            {
              VERSION_CONFLICT: "另一设备已修改",
              NAME_CONFLICT: "项目名称重复",
              ENTITY_DELETED: "云端内容已删除",
              ACTIVE_PROJECT_DELETED: "正在计时的项目已被删除",
              ORPHAN_SESSION: "记录需要重新归属",
            }[item.code] || "资料需要确认",
          createdLabel: formatTime(item.createdAt),
          isDeleted:
            !!(item.cloud && item.cloud.deleted) ||
            /DELETED|ORPHAN/i.test(item.code || ""),
        }),
      );
      this.setData({ conflicts });
      const env = await getApp().globalData.service.getManageData();
      if (env.ok) {
        const choices = env.data.active
          .concat(env.data.archived)
          .map((p) => ({ id: p.projectId, name: p.pathText }));
        this.setData({
          projectChoices: [
            { id: "", name: "保留为独立项目" },
            { id: "__new__", name: "另建项目保存" },
          ].concat(choices),
          recoveryChoices: [{ id: "", name: "另建项目保存" }].concat(choices),
        });
      }
    } catch (error) {
      this.setData({ statusMessage: error.message || "读取账号状态失败" });
    }
  },

  async runAction(action, method, args) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const fn = this.accounts && this.accounts[method];
      if (typeof fn !== "function")
        throw new Error("此功能正在准备中，请稍后再试");
      const result = await fn.apply(this.accounts, args || []);
      if (result !== undefined) unwrap(result);
      if (action) wx.showToast({ title: action, icon: "success" });
      await this.refresh();
    } catch (error) {
      wx.showModal({
        title: "操作未完成",
        content: error.message || "请稍后重试",
        showCancel: false,
      });
    } finally {
      this.setData({ busy: false });
    }
  },

  onLogin() {
    wx.showModal({
      title: "登录账号",
      content:
        "登录只会建立账号空间。游客数据是否合并，会在登录后单独预览并由你确认。",
      confirmText: "继续登录",
      success: (r) => {
        if (r.confirm) this.runAction("登录成功", "login");
      },
    });
  },

  onLogout() {
    wx.showModal({
      title: "退出登录？",
      content: "退出后会回到游客空间；当前账号的待同步内容仍保留在该账号空间。",
      confirmText: "退出登录",
      success: (r) => {
        if (r.confirm) this.runAction("已退出登录", "logout");
      },
    });
  },

  onSync() {
    this.runAction("已开始同步", "trigger");
  },

  async onPreviewMigration() {
    if (this.data.busy) return;
    wx.showModal({
      title: "准备游客数据预览？",
      content:
        "预览会把游客历史上传到账号的临时迁移区；确认合并前不会发布，游客原副本会保留。",
      confirmText: "上传并预览",
      success: (r) => {
        if (r.confirm) this.loadMigrationPreview();
      },
    });
  },

  async loadMigrationPreview() {
    if (this.data.busy) return;
    this.setData({ busy: true, mapping: {}, migrationPreview: null });
    try {
      const preview = unwrap(await this.accounts.migrateGuest());
      const conflicts = Array.isArray(preview.conflicts)
        ? preview.conflicts
        : [];
      const rows = conflicts
        .filter(
          (c) =>
            !/^SESSION_/.test(c.type || "") && !/DELETED/.test(c.type || ""),
        )
        .map((c) => ({
          id: c.sourceId,
          name:
            (c.cloud &&
              (c.cloud.name || (c.cloud.data && c.cloud.data.name))) ||
            c.type ||
            "项目名称冲突",
          targetId:
            (c.cloud && (c.cloud.id || (c.cloud.data && c.cloud.data.id))) ||
            "",
          value: "",
        }));
      const sessions = preview.sessions || preview.sessionCount || 0;
      const projectCount =
        preview.projectCount == null ? rows.length : preview.projectCount;
      this.setData({
        migrationPreview: preview,
        mappingRows: rows,
        migrationSummary:
          "预览：" +
          projectCount +
          " 个项目 · " +
          (Array.isArray(sessions) ? sessions.length : sessions) +
          " 条专注记录 · " +
          conflicts.length +
          " 项冲突",
        sessionRows: conflicts
          .filter(
            (c) =>
              /^SESSION_|ENTITY_DELETED$/.test(c.type) &&
              c.cloud &&
              c.cloud.status === "COMPLETED",
          )
          .map((c) => ({
            id: c.sourceId,
            label:
              "记录 " + new Date(c.cloud.startedAtSec * 1000).toLocaleString(),
            decision: "待选择",
          })),
        sessionMapping: {},
      });
    } catch (error) {
      wx.showModal({
        title: "无法预览游客数据",
        content: error.message || "请稍后重试",
        showCancel: false,
      });
    } finally {
      this.setData({ busy: false });
    }
  },

  onMappingInput(e) {
    const id = e.currentTarget.dataset.id;
    const value = String(e.detail.value || "").trim();
    const mapping = Object.assign({}, this.data.mapping, { [id]: value });
    const mappingRows = this.data.mappingRows.map((row) =>
      row.id === id ? Object.assign({}, row, { value }) : row,
    );
    this.setData({ mapping, mappingRows });
  },

  onMappingPick(e) {
    const choice = this.data.projectChoices[Number(e.detail.value)],
      id = e.currentTarget.dataset.id;
    if (choice.id === "__new__") {
      wx.showModal({
        title: "另建项目保存",
        editable: true,
        placeholderText: "输入新项目名称",
        success: async (r) => {
          if (!r.confirm || !String(r.content || "").trim()) return;
          this.setData({ busy: true });
          try {
            const project = await this.accounts.createMigrationTarget(
              String(r.content).trim(),
            );
            this.setData({
              mapping: { ...this.data.mapping, [id]: project.id },
              mappingRows: this.data.mappingRows.map((row) =>
                row.id === id ? { ...row, choiceName: project.name } : row,
              ),
            });
          } catch (error) {
            wx.showModal({
              title: "创建未完成",
              content: error.message,
              showCancel: false,
            });
          } finally {
            this.setData({ busy: false });
          }
        },
      });
      return;
    }
    this.setData({
      mapping: { ...this.data.mapping, [id]: choice.id },
      mappingRows: this.data.mappingRows.map((r) =>
        r.id === id ? { ...r, choiceName: choice.name } : r,
      ),
    });
  },
  onSessionChoice(e) {
    const id = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ["保留云端已有记录", "将游客版本另存为新记录"],
      success: (r) => {
        const value =
          r.tapIndex === 0 ? "skip" : require("../../core/ids").uuid();
        this.setData({
          sessionMapping: { ...this.data.sessionMapping, [id]: value },
          sessionRows: this.data.sessionRows.map((row) =>
            row.id === id
              ? {
                  ...row,
                  decision:
                    r.tapIndex === 0 ? "保留云端记录" : "游客版本另存为新记录",
                }
              : row,
          ),
        });
      },
    });
  },
  onRecoveryPick(e) {
    const choice = this.data.recoveryChoices[Number(e.detail.value)];
    this.setData({
      recoveryProjectId: choice.id,
      recoveryChoiceName: choice.name,
    });
  },

  onCommitMigration() {
    if (!this.data.migrationPreview) return;
    const mapping = {};
    Object.keys(this.data.mapping).forEach((id) => {
      const targetId = this.data.mapping[id];
      if (targetId) mapping[id] = targetId;
    });
    wx.showModal({
      title: "合并游客数据？",
      content:
        this.data.migrationSummary +
        "\n未填写映射的项目将按原名作为独立项目导入，不会按同名自动合并。",
      confirmText: "确认合并",
      success: async (r) => {
        if (!r.confirm) return;
        this.setData({ busy: true });
        try {
          unwrap(
            await this.accounts.commitGuestMigration(
              mapping,
              this.data.sessionMapping,
            ),
          );
          this.setData({
            migrationPreview: null,
            mappingRows: [],
            mapping: {},
          });
          wx.showToast({ title: "游客数据已合并", icon: "success" });
          await this.refresh();
        } catch (error) {
          wx.showModal({
            title: "合并未完成",
            content: error.message || "请稍后重试",
            showCancel: false,
          });
        } finally {
          this.setData({ busy: false });
        }
      },
    });
  },

  async deliverExport(method, fileLabel, args) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const value = unwrap(await this.accounts[method](...(args || [])));
      const content =
        typeof value === "string" ? value : JSON.stringify(value, null, 2);
      if (!content) throw new Error("没有可导出的内容");
      const fileName = "yotick-" + fileLabel + "-" + Date.now() + ".json";
      let delivered = false;
      if (wx.getFileSystemManager && wx.env && wx.env.USER_DATA_PATH) {
        const filePath = wx.env.USER_DATA_PATH + "/" + fileName;
        await new Promise((resolve, reject) =>
          wx.getFileSystemManager().writeFile({
            filePath,
            data: content,
            encoding: "utf8",
            success: resolve,
            fail: reject,
          }),
        );
        if (typeof wx.shareFileMessage === "function") {
          try {
            await new Promise((resolve, reject) =>
              wx.shareFileMessage({
                filePath,
                fileName,
                success: resolve,
                fail: reject,
              }),
            );
            delivered = true;
          } catch (e) {}
        }
      }
      if (!delivered) {
        await new Promise((resolve, reject) =>
          wx.setClipboardData({
            data: content,
            success: resolve,
            fail: reject,
          }),
        );
        delivered = true;
      }
      if (method === "exportRecovery" && delivered)
        this.setData({ exportedRecovery: true });
      wx.showModal({
        title: fileLabel === "recovery" ? "恢复副本已准备好" : "账号数据已导出",
        content: delivered
          ? "请将文件或已复制的内容保存到安全位置。"
          : "导出未完成。",
        showCancel: false,
      });
    } catch (error) {
      wx.showModal({
        title: "导出未完成",
        content: error.message || "请稍后重试",
        showCancel: false,
      });
    } finally {
      this.setData({ busy: false });
    }
  },

  onExportRecovery() {
    this.deliverExport("exportRecovery", "recovery");
  },
  async onExportArchived() {
    const spaces = await this.accounts.listRecoverySpaces();
    if (!spaces.length)
      return wx.showToast({ title: "暂无历史副本", icon: "none" });
    wx.showActionSheet({
      itemList: spaces.map((s) => s.label),
      success: (r) =>
        this.deliverExport("exportRecovery", "recovery", [
          spaces[r.tapIndex].namespace,
        ]),
    });
  },
  onExportAccount() {
    this.deliverExport("exportAccount", "account");
  },

  onClearAccount() {
    if (!this.data.exportedRecovery) {
      wx.showModal({
        title: "先保存恢复副本",
        content:
          "请先导出并保存包含待同步任务与冲突的恢复副本，再继续清空账号云端数据。",
        showCancel: false,
      });
      return;
    }
    wx.showModal({
      title: "清空账号云端数据？",
      content:
        "云端数据将被清空并推进空间代次。本机旧数据会隔离保留，之后可导出恢复。",
      confirmText: "继续",
      confirmColor: "#A84A32",
      success: (first) => {
        if (!first.confirm) return;
        wx.showModal({
          title: "最后确认",
          content: "再次确认清空此账号的全部云端项目与专注记录？",
          confirmText: "清空云端数据",
          confirmColor: "#A84A32",
          success: (second) => {
            if (second.confirm)
              this.runAction("云端数据已清空并隔离", "clearAccount");
          },
        });
      },
    });
  },

  onClearCache() {
    const status = this.accounts && this.accounts.getStatus();
    if (!status || !Number.isFinite(status.pending) || status.pending > 0) {
      wx.showModal({
        title: "暂不能重建本机资料",
        content: "待同步数量尚未确认为零。请先同步或导出恢复副本。",
        showCancel: false,
      });
      return;
    }
    wx.showModal({
      title: "重新下载账号资料？",
      content:
        "联网后重新下载账号资料，旧本机副本保留用于恢复。此操作不释放旧副本占用的空间，也不删除云端或游客资料。",
      confirmText: "重建资料",
      success: (r) => {
        if (r.confirm)
          this.runAction("已准备重新下载，旧副本已保留", "clearCache");
      },
    });
  },

  onRequestDeletion() {
    wx.showModal({
      title: "提交账号注销申请？",
      content:
        "这会向服务端提交注销申请，不会立即删除账号。服务端处理仍需遵循正式数据保留政策；该政策尚待确认。",
      confirmText: "提交申请",
      success: async (r) => {
        if (!r.confirm || this.data.busy) return;
        this.setData({ busy: true });
        try {
          const fn = this.accounts && this.accounts.deleteAccount;
          if (typeof fn !== "function") throw new Error("账号注销申请暂不可用");
          const result = unwrap(await fn.call(this.accounts));
          wx.showModal({
            title: "申请已提交",
            content:
              result &&
              (result.status === "pending_policy_review" ||
                result.state === "pending_policy_review")
                ? "服务端已收到申请，正在等待正式数据保留政策确认。账号当前尚未删除。"
                : "服务端已收到申请，账号当前尚未删除。",
            showCancel: false,
          });
        } catch (error) {
          wx.showModal({
            title: "申请未提交",
            content: error.message || "请稍后重试",
            showCancel: false,
          });
        } finally {
          this.setData({ busy: false });
        }
      },
    });
  },

  onResolve(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.conflicts.find((c) => c.id === id);
    if (!item) return;
    if (item.isDeleted) {
      this.setData({
        recoveryPanel: true,
        recoveryConflictId: id,
        recoveryProjectId: "",
        recoveryName: "",
      });
      return;
    }
    wx.showActionSheet({
      itemList: ["采用云端版本", "保留本地修改并重命名"],
      success: (r) => {
        if (r.tapIndex === 0)
          this.runAction("已采用云端版本", "resolveConflict", [id, "cloud"]);
        else if (r.tapIndex === 1)
          wx.showModal({
            title: "本地项目新名称",
            editable: true,
            placeholderText: "输入新名称",
            content: (item.local && item.local.name) || "",
            success: (edit) => {
              if (edit.confirm && String(edit.content || "").trim())
                this.runAction("本地修改已重新提交", "resolveConflict", [
                  id,
                  "local",
                  { name: String(edit.content).trim() },
                ]);
            },
          });
      },
    });
  },

  onRecoveryProjectInput(e) {
    this.setData({ recoveryProjectId: String(e.detail.value || "").trim() });
  },
  onRecoveryNameInput(e) {
    this.setData({ recoveryName: String(e.detail.value || "").trim() });
  },

  async onRecoverDeleted() {
    const name = this.data.recoveryName;
    if (!name && !this.data.recoveryProjectId)
      return wx.showToast({
        title: "请填写新项目名称或选择有效项目",
        icon: "none",
      });
    const id = this.data.recoveryConflictId;
    const projectId = this.data.recoveryProjectId || null;
    this.setData({ busy: true });
    try {
      const recover = this.accounts && this.accounts.recoverConflict;
      if (typeof recover !== "function")
        throw new Error("删除冲突恢复功能正在准备中");
      unwrap(await recover.call(this.accounts, id, projectId, name));
      this.setData({
        recoveryPanel: false,
        recoveryConflictId: "",
        recoveryProjectId: "",
        recoveryName: "",
      });
      wx.showToast({ title: "恢复任务已创建", icon: "success" });
      await this.refresh();
    } catch (error) {
      wx.showModal({
        title: "恢复未完成",
        content: error.message || "请稍后重试",
        showCancel: false,
      });
    } finally {
      this.setData({ busy: false });
    }
  },

  cancelRecovery() {
    this.setData({ recoveryPanel: false });
  },
});
