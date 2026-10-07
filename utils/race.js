// utils/race.js
// 页面异步查询“后发为准”守卫：
// 每次发起查询前取一个递增令牌，结果返回时只有令牌仍为最新才允许渲染，
// 从而保证快速切换日期/月份/统计范围时，旧请求晚返回不会覆盖新结果。
function createRace() {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(token) {
      return token === current;
    },
    current() {
      return current;
    }
  };
}

module.exports = { createRace };
