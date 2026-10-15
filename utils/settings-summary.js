const GROUPS = [
  { title: '专注设置', items: [
    { key: 'projects', title: '管理项目', hint: '名称、分类、颜色与简称' },
    { key: 'focus', title: '专注与休息', hint: '计时时长、休息安排' },
    { key: 'stats', title: '目标与统计', hint: '每日目标、统计范围' }
  ] },
  { title: '界面偏好', items: [
    { key: 'display', title: '外观与屏幕', hint: '主题、屏幕常亮' }
  ] },
  { title: '账号与数据', items: [
    { key: 'account', title: '账号与同步', hint: '可选登录，跨设备保存记录' },
    { key: 'data', title: '数据与备份', hint: '备份、恢复与数据管理' },
    { key: 'privacy', title: '隐私政策', hint: '数据用途、同步范围和管理方式' }
  ] },
  { title: '帮助', items: [
    { key: 'guide', title: '使用指南', hint: '项目、计时与统计，按步骤说明' },
    { key: 'feedback', title: '反馈与建议', hint: '哪里不好用，或希望增加什么功能' },
    { key: 'help', title: '帮助与关于', hint: '使用说明、版本信息' }
  ] }
];
const { lightThemeName } = require('./light-theme-options');

function buildSettingsGroups(prefs) {
  const current = prefs || {};
  const theme = current.theme === 'dark' ? 'dark' : (current.theme === 'light' ? 'light' : 'system');
  const values = {
    focus: `${Number.isInteger(current.defaultMinutes) ? current.defaultMinutes : 30} 分钟${current.restEnabled ? ' · 休息开启' : ''}`,
    display: theme === 'dark' ? '深色' : (theme === 'system' ? '跟随系统' : lightThemeName(current.lightTheme)),
    stats: current.dailyGoalEnabled ? `${Number.isInteger(current.dailyGoalMinutes) ? current.dailyGoalMinutes : 120} 分钟目标` : '目标关闭',
    data: ''
  };
  return GROUPS.map(group => ({
    title: group.title,
    items: group.items.map(item => Object.assign({}, item, { value: values[item.key] || '' }))
  }));
}

module.exports = { buildSettingsGroups };
