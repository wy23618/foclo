const {
  resolveTheme,
  pageThemeData,
  navigationBarOptions,
} = require("../../utils/theme");

const STATUS_LABELS = {
  guest: "仅保存在本机",
  syncing: "正在保存",
  synced: "已保存",
  pending: "等待保存",
  offline: "离线，资料已保存在本机",
  "upgrade-required": "空间升级待处理",
  failed: "保存未完成",
  "auth-required": "需要重新登录",
  conflict: "需要确认更改",
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
  const pad = (n) => String(n).padStart(2, "0");
  return Number.isNaN(date.getTime())
    ? "暂无同步记录"
    : "最近保存：" + date.getFullYear() + "/" + pad(date.getMonth() + 1) + "/" +
      pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

function conflictText(value) {
  if (value == null) return "（无内容）";
  const data = value.data || value.payload || value;
  if (data.status === "COMPLETED")
    return (
      "开始：" +
      require('../../utils/record-date').dateText(data.startedAtSec) +
      "\n专注：" +
      require('../../utils/format').durationText(data.durationSeconds) +
      "\n暂停：" +
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
    accountLabel: "游客体验",
    avatarUrl: '',
    accountSuffix: '',
    profileUserId: '',
    pending: 0,
    syncedAt: "暂无同步记录",
    conflicts: [],
    busy: false,
    loginMethods: require('../../sync/login-methods').LOGIN_METHODS,
    advancedOpen: false,
    toolsOnly:false,
    hasGuestData: false,
    guestSummaryText: "",
    hasAccount: false,
    canClearCache: false,
    exportedRecovery: false,
    recoveryChoices: [{ id: "", name: "另建项目保存" }],
    recoveryChoiceName: "另建项目保存",
    recoveryPanel: false,
    recoveryConflictId: "",
    recoveryProjectId: "",
    recoveryName: "",
  },

  onLoad(options) {
    this.loginOnOpen = options && options.login === "1";
    const toolsOnly = !!(options && options.tools === '1');
    this.setData({ toolsOnly });
    if (toolsOnly) wx.setNavigationBarTitle({ title:'账号数据与注销' });
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
    if (this.loginOnOpen) {
      this.loginOnOpen = false;
      await this.onLogin();
    }
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
        ? (this.data.profileUserId === account.userId ? this.data.accountLabel : '微信账号')
        : "游客体验",
      hasAccount: !!account,
      accountSuffix:account ? account.userId.slice(-4) : '',
      avatarUrl:account && this.data.profileUserId === account.userId ? this.data.avatarUrl : '',
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
      const displayedAccount = this.accounts.getCurrent();
      const profile = await this.accounts.getDisplayProfile();
      if (displayedAccount === this.accounts.getCurrent()) this.setData({
        profileUserId:displayedAccount ? displayedAccount.userId : '',
        avatarUrl:profile && profile.avatarUrl || '',
        accountLabel:profile && profile.nickname || (displayedAccount ? '微信账号' : '游客体验'),
      });
      const guest = await this.accounts.getGuestSummary();
      this.setData({ hasGuestData: guest.checked && guest.hasData && !guest.imported,
        guestSummaryText: [guest.projectCount ? guest.projectCount + " 个项目" : '', guest.sessionCount ? guest.sessionCount + " 条记录" : ''].filter(Boolean).join(' · ') + '尚未保存到账号' });
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
      if (method === "logout") {
        getApp().globalData.guestSession = true;
          wx.reLaunch({ url: '/pages/focus/focus' });
        return;
      }
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

  async onLogin(event) {
    if (this.data.busy) return;
    const id = event && event.currentTarget && event.currentTarget.dataset.method || 'wechat';
    const method = this.data.loginMethods.find(item => item.id === id);
    if (!method || method.id !== 'wechat') return;
    this.setData({ busy:true });
    wx.showLoading({ title:'正在连接微信', mask:true });
    try {
      const { loginAndImport, confirmGuestImport } = require('../../sync/login-flow');
      const result = await loginAndImport(this.accounts, async summary => {
        wx.hideLoading();
        const agreed = await confirmGuestImport(summary);
        if (agreed) wx.showLoading({ title:'正在迁移记录', mask:true });
        return agreed;
        });
      if (result.cancelled) return;
      getApp().globalData.guestSession = false;
      await this.refresh();
    } catch (error) {
      wx.hideLoading();
        wx.showModal({ title:error.loggedIn ? '游客记录尚未迁移' : '微信登录未完成',
        content:(error.message || '请稍后重试') + '。本机原记录仍保留。', showCancel:false });
      await this.refresh();
    } finally { wx.hideLoading(); this.setData({ busy:false }); }
  },
  async onEditProfile() {
    if (this.data.busy || !this.accounts.getCurrent()) return;
    this.setData({ busy:true });
    try {
      const identity = this.selectComponent('#accountIdentity');
      const value = await identity.request(await this.accounts.getDisplayProfile(), { editing:true });
      if (value) await this.accounts.saveDisplayProfile(value);
      await this.refresh();
    } catch (error) { wx.showToast({ title:error.message || '资料暂未保存', icon:'none' }); }
    finally { this.setData({ busy:false }); }
  },
  onLogout() {
    wx.showModal({
      title: "退出登录？",
      content: "退出后使用游客模式，不会自动重新登录。账号记录和待同步内容都会保留。",
      confirmText: "退出登录",
      success: (r) => {
        if (r.confirm) this.runAction("已退出登录", "logout");
      },
    });
  },

  onSync() {
    this.runAction("已开始同步", "trigger");
  },

  toggleAdvanced() { this.setData({ advancedOpen: !this.data.advancedOpen }); },

  async onSaveGuestRecords() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const { importGuestWithConfirmation, confirmGuestImport } = require("../../sync/login-flow");
      const result = await importGuestWithConfirmation(this.accounts, confirmGuestImport, true);
      if (result.imported) {
        wx.showToast({ title:result.result && result.result.addedSessionCount === 0 && result.result.addedProjectCount === 0 ? '记录已整理，无需重复保存' : '之前的记录已保存', icon:'success' });
      }
      await this.refresh();
    } catch (error) {
      wx.showModal({ title: "之前的记录尚未保存", content: (error.message || "请稍后重试") + "。游客原记录仍在本机。", showCancel: false });
    } finally { this.setData({ busy: false }); }
  },

  openDataBackup() { wx.navigateTo({ url:'/pages/settings-detail/settings-detail?section=data' }); },

  onRecoveryPick(e) {
    const choice = this.data.recoveryChoices[Number(e.detail.value)];
    this.setData({
      recoveryProjectId: choice.id,
      recoveryChoiceName: choice.name,
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
      if (fileLabel === "data" && delivered) {
        wx.showToast({ title: "数据已导出", icon: "success" });
        return;
      }
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
  onExportData() {
    this.deliverExport("exportLocalBackup", "data");
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
        title: "删除前先备份",
        content:
          "先保存一份备份，避免误删后无法找回。保存后再确认是否删除。",
        confirmText: '保存备份',
        cancelText: '取消',
        success: result => { if (result.confirm) this.onExportRecovery(); },
      });
      return;
    }
    wx.showModal({
      title: "删除全部记录？",
      content:
        "将删除这个账号的全部项目和专注记录，其他设备也会同步删除。账号仍可继续使用，登录前的游客记录不受影响。",
      confirmText: "继续",
      confirmColor: "#A84A32",
      success: (first) => {
        if (!first.confirm) return;
        wx.showModal({
          title: "最后确认",
          content: "确定删除全部项目和专注记录吗？需要找回时，请使用删除前保存的备份。",
          confirmText: "确认删除",
          confirmColor: "#A84A32",
          success: (second) => {
            if (second.confirm)
              this.runAction("账号记录已删除", "clearAccount");
          },
        });
      },
    });
  },

  onClearCache() {
    const status = this.accounts && this.accounts.getStatus();
    if (!status || !Number.isFinite(status.pending) || status.pending > 0) {
      wx.showModal({
        title: "请先完成保存",
        content: "这台设备可能还有未保存的更改。请先联网保存，再重新下载记录。",
        showCancel: false,
      });
      return;
    }
    wx.showModal({
      title: "重新下载记录？",
      content:
        "从账号重新下载已保存的记录，用于解决这台设备显示不完整的问题。不会删除账号记录。",
      confirmText: "重新下载",
      success: (r) => {
        if (r.confirm)
          this.runAction("已开始重新下载", "clearCache");
      },
    });
  },

  async onRequestDeletion() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const status = await this.accounts.getDeletionRequest();
      if (status.request) {
        wx.showModal({ title: "注销申请处理中", content: "已收到你的注销申请，处理完成前账号仍可使用。", showCancel: false });
        return;
      }
    } catch (error) {
      wx.showModal({ title: "无法查询注销申请", content: error.message || "请稍后重试", showCancel: false });
      return;
    } finally { this.setData({ busy: false }); }
    wx.showModal({
      title: "提交账号注销申请？",
      content:
        "注销会申请删除账号及其数据，需要审核处理，不会立即生效。只想清空记录，请选择“删除全部记录”。",
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
                ? "已收到注销申请，等待审核处理。账号尚未删除。"
                : "已收到注销申请，账号尚未删除。",
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
      itemList: ["使用账号已保存的内容", "保留这台设备的修改并改名"],
      success: (r) => {
        if (r.tapIndex === 0)
          this.runAction("已使用账号内容", "resolveConflict", [id, "cloud"]);
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
