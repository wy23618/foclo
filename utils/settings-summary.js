const GROUPS = [
  { title: '使用习惯', items: [
    { key: 'projects', title: '管理项目', hint: '名称、分类、颜色与简称' },
    { key: 'focus', title: '专注与休息', hint: '计时时长、休息安排' },
    { key: 'display', title: '外观与屏幕', hint: '主题、屏幕常亮' },
    { key: 'stats', title: '目标与统计', hint: '每日目标、统计范围' }
  ] },
  { title: '更多', items: [
    { key: 'account', title: '账号与登录', hint: '登录方式、退出与自动保存' },
    { key: 'privacy', title: '隐私与数据', hint: '记录去向、导出和注销说明' },
    { key: 'data', title: '数据与备份', hint: '保存备份、找回记录' },
    { key: 'guide', title: '入门小卡', hint: '三张卡片，轻松上手' },
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
