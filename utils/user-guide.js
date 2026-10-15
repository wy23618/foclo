// Shared by the first-use cards and the guide page.
const QUICK_STEPS = [
  { number: '01', symbol: '✦', title: '先选这次要做的事', text: '点计时盘上方的项目标签，选一个项目。没有合适的？先新建项目，之后还能继续细分。', chapter: 'focus', preview: '英语 › 阅读' },
  { number: '02', symbol: '◷', title: '选计时方式，再开始', text: '倒计时可选常用时长，也能自定义；正向计时会从零开始累计。选好后点「开始专注」。', chapter: 'focus', preview: '倒计时 · 30:00' },
  { number: '03', symbol: '✓', title: '结束后，到统计里复盘', text: '完成的专注会记入所选项目。统计页可以按日期、项目查看；点热力图日期能回看当天记录。', chapter: 'stats', preview: '记录归入所选项目' }
];
const CHAPTERS = [
  { id: 'runtime', symbol: 'Ⅱ', title: '临时离开，怎么保留进度？', tip: '点「暂停」后再离开，回来点「继续」。小程序进入后台时，计时和提醒可能受微信或手机系统限制；结束一轮后记录会自动写入本机。' },
  { id: 'projects', symbol: '＋', title: '项目怎样整理更好找？', tip: '把长期目标建成上层项目，再把具体科目或任务放在子项目里。开始计时时选最具体的一项，统计会按这个选择归类；暂时不用的项目可以归档。' },
  { id: 'stats', symbol: '▦', title: '统计数字从哪里来？', tip: '已完成的专注按开始时间、时长和所选项目汇总。切换日期范围或项目可看不同维度；点热力图某天可查看当天明细。删除记录后，相关统计也会更新。' },
  { id: 'data', symbol: '↗', title: '登录后为什么会同步？', tip: '这是为了让你在换手机或重装后继续使用自己的项目和记录。游客数据不会悄悄导入：首次登录会先显示待保存数量，由你选择；登录后新记录会自动同步。头像和昵称可选，只用于本机展示。' }
];
module.exports = { QUICK_STEPS, CHAPTERS, FAQS: [] };
