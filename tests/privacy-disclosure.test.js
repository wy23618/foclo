const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PREF_KEYS } = require("../sync/local");

const markup = fs.readFileSync(
  path.join(__dirname, "../pages/privacy/privacy.wxml"),
  "utf8",
);

test("privacy disclosure matches every account preference allowed to sync", () => {
  const prefsCopy = markup.match(
    /<view class="row-title">会同步的账号设置<\/view><view class="row-copy">([^<]*)<\/view>/,
  )?.[1];
  const localCopy = markup.match(
    /<view class="row-title">仅保存在本机的设置<\/view><view class="row-copy">([^<]*)<\/view>/,
  )?.[1];
  const disclosedGroup = {
    startupMode: "启动方式",
    defaultMinutes: "默认和常用专注时长",
    commonMinutes: "默认和常用专注时长",
    confirmEnd: "结束确认",
    dailyGoalEnabled: "每日目标",
    dailyGoalMinutes: "每日目标",
    weekStartsSunday: "每周起始日",
    restEnabled: "休息设置",
    shortBreakMinutes: "休息设置",
    longBreakMinutes: "休息设置",
    longBreakEvery: "休息设置",
  };

  assert.ok(prefsCopy, "privacy page must describe synced account preferences");
  assert.deepEqual(
    Object.keys(disclosedGroup).sort(),
    PREF_KEYS.slice().sort(),
    "new sync fields must be classified in the privacy disclosure",
  );
  for (const group of new Set(Object.values(disclosedGroup)))
    assert.ok(prefsCopy.includes(group), `privacy page must disclose ${group}`);

  assert.ok(localCopy, "privacy page must describe device-only settings");
  for (const label of ["主题", "浅色主题", "屏幕显示", "仅保存在当前设备"])
    assert.ok(localCopy.includes(label), `privacy page must disclose local-only ${label}`);
  assert.ok(
    !PREF_KEYS.includes("theme") && !PREF_KEYS.includes("lightTheme"),
    "visual theme preferences must stay device-local",
  );
});
