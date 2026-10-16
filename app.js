// app.js
const { createDefaultAdapter } = require("./storage/adapter.js");
const { createAccounts } = require("./sync/accounts");

App({
  globalData: {
    service: null,
    ready: false,
    readyPromise: null,
    fullChartPayload: null,
    guestSession: false,
  },

  onLaunch() {
    // Clear a debug switch left on by an earlier preview on this device.
    if (typeof wx !== "undefined" && typeof wx.setEnableDebug === "function") {
      try { wx.setEnableDebug({ enableDebug: false, fail() {} }); } catch (e) {}
    }
    const adapter = createDefaultAdapter();
    this.globalData.readyPromise = (async () => {
      this.globalData.accounts = createAccounts(adapter, this);
      await this.globalData.accounts.init();
      this.globalData.ready = true;
      if (typeof wx !== "undefined" && wx.onNetworkStatusChange)
        wx.onNetworkStatusChange((r) => {
          if (r.isConnected) this.globalData.accounts.trigger();
        });
      return { ok: true };
    })();
  },

  onShow() {
    // 回前台统一走服务：恢复待提交、结算到期（不依赖专注页轮询，L11）
    const service = this.globalData.service;
    if (service) service.getCurrent();
    if (this.globalData.accounts) this.globalData.accounts.trigger();
  },
});
