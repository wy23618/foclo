// Generated native/Canvas values come from handoff/theme-config.json.
// Run handoff/sync-theme.py after editing; packaging also synchronizes them.
const THEME_COLORS = require('./theme-colors.js');
function themeColors(theme) {
  if (theme === 'dark') return THEME_COLORS.dark;
  const key = theme === 'light' || theme === 'forest'
    ? 'light'
    : String(theme || '').replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
  return THEME_COLORS[key] || THEME_COLORS.light;
}
function resolveTheme(preference, lightTheme) {
  if (preference === 'dark') return 'dark';
  let dark = false;
  if (preference !== 'light') {
    try {
      const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync();
      dark = info.theme === 'dark';
    } catch (e) {}
  }
  if (dark) return 'dark';
  if (lightTheme === 'forest') return 'light';
  const key = String(lightTheme || '').replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
  if (THEME_COLORS[key]) return lightTheme;
  return 'light';
}
function navigationColors(theme) {
  const colors = themeColors(theme);
  return { background: colors.pageBackground, inkColor: colors.textPrimary, frontColor: colors.navigationFront.toLowerCase() };
}
function navigationBarOptions(theme) {
  const colors = navigationColors(theme);
  return { frontColor: colors.frontColor, backgroundColor: colors.background };
}
// Page variables are declared on inner theme roots. The native page underneath
// those roots needs its own background/text via page-meta (no layout changes).
function pageThemeData(theme, backgroundRole) {
  const colors = themeColors(theme);
  return { themeClass: theme, themePageStyle: 'background-color:' + colors[backgroundRole || 'pageBackground'] + ';color:' + colors.textPrimary + ';' };
}
async function applyPageTheme(page) {
  const app = page.runtimeApp || getApp();
  if (!app.globalData.ready && app.globalData.readyPromise) await app.globalData.readyPromise;
  const service = app.globalData.service;
  if (!service) return;
  const prefs = await service.getPrefs();
  const theme = resolveTheme(prefs && prefs.theme || 'system', prefs && prefs.lightTheme);
  const patch = pageThemeData(theme);
  Object.keys(patch).forEach(key => { if (page.data[key] === patch[key]) delete patch[key]; });
  if (Object.keys(patch).length) page.setData(patch);
  const tab = page.getTabBar && page.getTabBar();
  if (tab && (!tab.data || tab.data.themeClass !== theme)) tab.setData({ themeClass: theme });
  try { wx.setNavigationBarColor(navigationBarOptions(theme)); } catch (e) {}
}
module.exports = { THEME_COLORS, themeColors, resolveTheme, navigationColors, navigationBarOptions, pageThemeData, applyPageTheme };
