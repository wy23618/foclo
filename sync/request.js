function createRequest({ baseUrl, credentials, saveCredentials, transport }) {
  const environment = require("./environment"),
    localDevelopment =
      typeof wx === "undefined" || environment.isDevToolsDevelopment(),
    phoneDevelopment = environment.isPhoneDevelopment(),
    phoneCloudTesting = environment.isPhoneCloudTesting();
  const loopbackUrl = /^http:\/\/127\.0\.0\.1(?::[0-9]{1,5})?(?:\/|$)/.test(baseUrl);
  const lanDebugUrl = new RegExp(
    "^http:\\/\\/" + environment.LAN_DEBUG_API_HOST.replace(/\./g, "\\.") + ":3000(?:\\/|$)",
  ).test(baseUrl);
  const cloudDebugUrl = baseUrl === "https://" + environment.TEMP_CLOUD_DEBUG_API_HOST + "/api/v1";
  if (cloudDebugUrl && !phoneCloudTesting && !environment.isDevToolsDevelopment())
    throw new Error("临时测试服务器仅用于开发版和手机体验版，请配置正式 HTTPS 服务地址");
  if (
    !/^https:\/\//.test(baseUrl) &&
    !(localDevelopment && loopbackUrl) &&
    !(phoneDevelopment && lanDebugUrl)
  )
    throw new Error("请配置 HTTPS 服务地址");
  let tokens = credentials,
    refreshing = null,
    cancelled = false;
  const active = new Set();
  let debugReady = null;
  function preparePhoneDebug() {
    const needsDebug = (phoneDevelopment && lanDebugUrl) || (phoneCloudTesting && cloudDebugUrl);
    if (!needsDebug || typeof wx.setEnableDebug !== "function")
      return Promise.resolve();
    if (!debugReady) {
      debugReady = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(
          new Error("开发调试开启超时，请在右上角菜单打开调试后重新进入"),
          { code: "NETWORK_ERROR" },
        )), 3000);
        wx.setEnableDebug({
          enableDebug: true,
          success: () => { clearTimeout(timer); resolve(); },
          fail: () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("请在右上角菜单打开调试后重新进入"), { code: "NETWORK_ERROR" }));
          },
        });
      }).catch(error => { debugReady = null; throw error; });
    }
    return debugReady;
  }
  const send =
    transport ||
    (async (method, url, data, token) => {
      await preparePhoneDebug();
      if (cancelled) throw Object.assign(new Error("请求取消"), { code: "CANCELLED" });
      return new Promise((resolve, reject) => {
        let task = wx.request({
          method,
          url,
          data,
          timeout: 15000,
          header: {
            "content-type": "application/json",
            ...(token ? { Authorization: "Bearer " + token } : {}),
          },
          success: (r) => {
            active.delete(task);
            if (r.statusCode >= 200 && r.statusCode < 300) resolve(r.data);
            else
              reject(
                Object.assign(
                  new Error(r.data?.error?.message || "服务请求失败"),
                  {
                    code: r.data?.error?.code || "RETRYABLE_ERROR",
                    status: r.statusCode,
                  },
                ),
              );
          },
          fail: (e) => {
            active.delete(task);
            const detail = String(e?.errMsg || "未知网络错误")
              .replace(/https?:\/\/\S+/gi, "[请求地址]")
              .replace(/[\r\n]+/g, " ")
              .slice(0, 180);
            const message = ((phoneDevelopment && lanDebugUrl) || (phoneCloudTesting && cloudDebugUrl))
              ? "测试请求失败：" + detail + (cloudDebugUrl ? "（临时云端测试地址；可在右上角打开调试后重进）" : "（电脑地址 " + environment.LAN_DEBUG_API_HOST + "）")
              : "网络未连接或请求超时";
            reject(
              Object.assign(new Error(message), {
                code: "NETWORK_ERROR",
              }),
            );
          },
        });
        active.add(task);
      });
    });
  async function refresh() {
    if (!refreshing)
      refreshing = (async () => {
        if (!tokens?.refreshToken)
          throw Object.assign(new Error("请重新登录"), {
            code: "AUTH_REQUIRED",
          });
        const next = await send(
          "POST",
          baseUrl + "/auth/refresh",
          { refreshToken: tokens.refreshToken },
          null,
        );
        if (cancelled)
          throw Object.assign(new Error("请求取消"), { code: "CANCELLED" });
        await saveCredentials(next);
        tokens = next;
      })().finally(() => {
        refreshing = null;
      });
    return refreshing;
  }
  async function request(method, path, data) {
    if (cancelled)
      throw Object.assign(new Error("请求取消"), { code: "CANCELLED" });
    let url = baseUrl + path,
      payload = data;
    if (method === "GET") {
      const q = Object.entries(data || {})
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
        .join("&");
      url += q ? "?" + q : "";
      payload = undefined;
    }
    try {
      return await send(method, url, payload, tokens?.accessToken);
    } catch (e) {
      if (e.status === 401 || e.code === "AUTH_REQUIRED") {
        await refresh();
        if (cancelled)
          throw Object.assign(new Error("请求取消"), { code: "CANCELLED" });
        return send(method, url, payload, tokens.accessToken);
      }
      throw e;
    }
  }
  request.cancel = () => {
    cancelled = true;
    for (const task of active) task.abort();
    active.clear();
  };
  return request;
}
module.exports = { createRequest };
