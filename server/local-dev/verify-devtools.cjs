// Manual acceptance helper. Uses the WeChat automation SDK installed separately
// under LocalAppData, never bundled into the mini-program or backend.
const path = require("node:path");
const fs = require("node:fs");
const automator = require(path.join(process.env.LOCALAPPDATA, "YoTick", "AcceptanceTools", "node_modules", "miniprogram-automator"));
const date = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("Supply acceptance date as YYYY-MM-DD");
const deadline = setTimeout(() => { console.error("DevTools acceptance timed out"); process.exit(1); }, 45000);
(async () => {
  const mp = await automator.connect({ wsEndpoint: "ws://127.0.0.1:9421" });
  try {
    const result = await mp.evaluate(async date => {
      const app = getApp();
      await app.globalData.readyPromise;
      await app.globalData.accounts.trigger();
      const status = app.globalData.accounts.getStatus();
      const records = await app.globalData.service.getRecords({ date, mode: "completed", pageSize: 100 });
      return {
        account: app.globalData.accounts.getCurrent()?.userId?.slice(-4),
        state: status.state, pending: status.pending, message: status.message,
        recordsOk: records.ok,
        rows: (records.data?.rows || []).map(r => ({ id: r.sessionId, name: r.name, seconds: r.seconds })),
      };
    }, date);
    if (!result.recordsOk || result.state !== "synced") throw new Error("DevTools account did not sync: " + JSON.stringify(result));
    const artifactRoot = path.join(process.env.LOCALAPPDATA, "YoTick", "LocalServer");
    const accountPage = await mp.navigateTo("/pages/account/account");
    await accountPage.waitFor(async () => (await accountPage.data("hasAccount")) === true);
    const accountUi = {
      label: await accountPage.data("accountLabel"),
      state: await accountPage.data("status"),
      message: await accountPage.data("statusMessage"),
      pending: await accountPage.data("pending"),
      syncedAt: await accountPage.data("syncedAt"),
    };
    if (accountUi.state !== "synced" || accountUi.message || accountUi.pending !== 0)
      throw new Error("Account page has unexpected state: " + JSON.stringify(accountUi));
    if (!/^上次同步：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(accountUi.syncedAt))
      throw new Error("Account page time is not formatted: " + accountUi.syncedAt);
    await mp.screenshot({ path: path.join(artifactRoot, "devtools-account-" + date + ".png") });
    await mp.navigateBack();
    const page = await mp.navigateTo("/pages/records/records?date=" + date);
    await page.waitFor(async () => (await page.data("loaded")) === true);
    const ui = { date: await page.data("date"), rows: await page.data("rows"), count: await page.data("totalCount") };
    await mp.screenshot({ path: path.join(artifactRoot, "devtools-records-" + date + ".png") });
    const evidence = { capturedAt: new Date().toISOString(), runtime: result, accountUi, ui };
    fs.writeFileSync(path.join(artifactRoot, "devtools-records-" + date + ".json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } finally {
    mp.disconnect();
    clearTimeout(deadline);
  }
})().catch(error => { clearTimeout(deadline); console.error(error.message); process.exitCode = 1; });
