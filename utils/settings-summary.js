const GROUPS = [
  { title: '使用习惯', items: [
    { key: 'focus', title: '专注与休息', hint: '计时时长、休息安排' },
    { key: 'display', title: '外观与屏幕', hint: '主题、屏幕常亮' },
    { key: 'stats', title: '目标与统计', hint: '每日目标、统计范围' }
  ] },
  { title: '更多', items: [
    { key: 'account', title: '账号与同步', hint: '跨设备同步、迁移与冲突处理' },
    { key: 'data', title: '项目与数据', hint: '项目管理、备份与恢复' },
    { key: 'guide', title: '使用指南', hint: '3 步上手，按需了解每个功能' },
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
    data: '本机优先'
  };
  return GROUPS.map(group => ({
    title: group.title,
    items: group.items.map(item => Object.assign({}, item, { value: values[item.key] || '' }))
  }));
}

module.exports = { buildSettingsGroups };
