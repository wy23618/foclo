// 独立于专注会话的本机休息计时状态。
const KEY = "yotick/rest-break/v1";
function store() {
  return getApp().globalData.adapter;
}
function read() {
  const adapter = store();
  return adapter && adapter.getSync ? adapter.getSync(KEY) || null : null;
}
function write(value) {
  const adapter = store();
  if (!adapter || !adapter.setSync) throw new Error("本地空间未就绪");
  adapter.setSync(KEY, value);
}
function clear() {
  const adapter = store();
  if (adapter && adapter.removeSync) adapter.removeSync(KEY);
}
function remaining(value, now) {
  if (!value) return 0;
  if (value.status === "PAUSED")
    return Math.max(0, value.remainingSeconds || 0);
  return Math.max(0, Math.ceil((value.endsAtMs - (now || Date.now())) / 1000));
}
module.exports = { read, write, clear, remaining };
