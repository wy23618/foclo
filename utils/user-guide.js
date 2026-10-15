// Shared by the first-use cards and the guide page.
const QUICK_STEPS = [
  { number: '01', symbol: '✦', title: '给专注起个名字', text: '点项目标签，选好这次学什么。没有项目？新建一个，再点选它。', chapter: 'focus', preview: '英语 / 阅读' },
  { number: '02', symbol: '◷', title: '拨一小块时间给自己', text: '选个倒计时，或者用正向计时自由累计。然后点「开始专注」。', chapter: 'focus', preview: '30:00' },
  { number: '03', symbol: '✓', title: '每一分钟，都算数', text: '结束后自动记下这次专注。去统计看看，时间都开花在哪里。', chapter: 'stats', preview: '今天，又积累了一点' }
];
const CHAPTERS = [
  { id: 'runtime', symbol: 'Ⅱ', title: '中途想歇一下？', tip: '点暂停，准备好再继续。离开小程序不会自动暂停，后台也不保证响铃。' },
  { id: 'projects', symbol: '＋', title: '学习内容有点多？', tip: '项目可以分层整理，专注时选最具体的一项。暂时不用的内容，归档就好。' },
  { id: 'stats', symbol: '▦', title: '看看自己的小积累', tip: '在统计里切换日期或项目；点热力图的某一天，回看当天记录。' },
  { id: 'data', symbol: '↗', title: '记录交给谁保管？', tip: '登录后自动保存到微信账号。旧游客记录经你确认后导入；没登录的记录仅在本机。' }
];
module.exports = { QUICK_STEPS, CHAPTERS, FAQS: [] };
