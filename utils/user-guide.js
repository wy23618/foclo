const WELCOME_FEATURES = [
  { label: '层级', title: '把目标拆成项目', hint: '分层整理任务，逐级查看时间去向。' },
  { label: '联动', title: '点开图表看明细', hint: '项目分布、热力图和每日记录相互衔接。' },
  { label: '辅助', title: '找到自己的节奏', hint: '极简显示、防误触与长短休息安排。' }
];
const GUIDE_CARDS = [
  { id: 'projects', icon: 'tree', label: '分层项目', caption: '把计划拆小', title: '大计划，分层做', text: '点父项展开，选具体任务计时。在选择卡片里点“整理”，即可添加下级或删除项目；上层项目汇总下级投入。', path: '选择项目 → 整理', action: '管理项目', target: 'projects' },
  { id: 'runtime', icon: 'focus', label: '专注辅助', caption: '减少干扰', title: '专心看时间', text: '计时中可切换极简显示，或开启防误触；长按屏幕即可解除防误触。', path: '专注页 → 计时过程中', action: '回到专注', target: 'focus' },
  { id: 'rest', icon: 'rest', label: '长短休息', caption: '找到节奏', title: '专注与休息交替', text: '设置短休息和长休息，每完成指定轮次安排一次长休息。休息时间不计入专注。', path: '设置 → 专注与休息', action: '设置休息', target: 'rest' },
  { id: 'stats', icon: 'chart', label: '图表联动', caption: '点开看明细', title: '从图形看到具体项目', text: '点分布图定位项目列表，继续进入项目统计；日期范围会一起保留。', path: '统计 → 项目分布', action: '查看统计', target: 'stats' },
  { id: 'timeline', icon: 'calendar', label: '热力图', caption: '回看每一天', title: '把坚持放进日历', text: '左右滑动切换月份，点日期查看当天记录。从详情返回，仍是刚才的热力图。', path: '统计 → 热力图', action: '查看热力图', target: 'heatmap' },
  { id: 'slots', icon: 'bars', label: '专注时段', caption: '发现高效时间', title: '看看何时更容易专注', text: '每根柱代表一小时的日均投入。点柱子看具体数值，调整“满格”只改变显示比例。', path: '统计 → 多日范围 → 专注时段分布', action: '查看统计', target: 'stats' },
  { id: 'data', icon: 'file', label: '备份同步', caption: '重要记录留一份', title: '给记录多一份留存', text: '登录后自动同步，游客记录导入前会询问。另存的备份文件可恢复，统计表格用于分析。', path: '设置 → 数据与备份', action: '管理备份', target: 'data' },
  { id: 'appearance', icon: 'palette', label: '外观配色', caption: '选舒服的样子', title: '按自己的喜好显示', text: '外观可跟随系统，或固定浅色、深色。浅色还可选配色，各设备分别保存。', path: '设置 → 外观与屏幕', action: '调整外观', target: 'appearance' },
  { id: 'goals', icon: 'goal', label: '每日目标', caption: '看见一点点积累', title: '给每天一个小目标', text: '设置每天想投入的分钟数，专注页和统计页会显示进度；也可调整每周起始日。', path: '设置 → 目标与统计', action: '设置目标', target: 'goals' }
];
module.exports = { WELCOME_FEATURES, GUIDE_CARDS };
