// storage/adapter.js
// 仓储适配层。页面/业务层只依赖这里的统一异步接口：
//   get(key) -> value | undefined
//   set(key, value)
//   remove(key)
//   keys() -> string[]
// 小程序运行时使用 wx 本地存储；Node 测试使用内存适配（支持故障注入与重启模拟）。

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

// 明确的“键不存在”错误（不同平台/基础库文案不同）：
// - 开发者工具 / iOS：getStorage:fail data not found
// - 部分安卓版本：getStorage:fail data not exist
// - 中文文案：不存在
// 其他读取错误（权限、序列化失败、底层异常等）不在此列，必须继续抛出。
function isMissingKeyError(err) {
  if (!err) return false;
  const msg = String(err.errMsg || err.message || "");
  return /data not found|data not exist|不存在/i.test(msg);
}

// ---- 微信小程序适配（异步，Promise 化）----
function createWxAdapter() {
  function get(key) {
    return new Promise((resolve, reject) => {
      wx.getStorage({
        key,
        success: (res) => resolve(res.data),
        fail: (err) => {
          // 键不存在属于正常情况，按“空值（undefined）”处理
          if (isMissingKeyError(err)) {
            resolve(undefined);
          } else {
            reject(err);
          }
        },
      });
    });
  }

  function set(key, data) {
    return new Promise((resolve, reject) => {
      wx.setStorage({
        key,
        data,
        success: () => resolve(),
        fail: (err) => reject(err),
      });
    });
  }

  function remove(key) {
    return new Promise((resolve, reject) => {
      wx.removeStorage({
        key,
        success: () => resolve(),
        fail: (err) => {
          if (isMissingKeyError(err)) {
            resolve();
          } else {
            reject(err);
          }
        },
      });
    });
  }

  function keys() {
    return new Promise((resolve, reject) => {
      wx.getStorageInfo({
        success: (res) => resolve(res.keys || []),
        fail: (err) => reject(err),
      });
    });
  }

  return {
    get,
    set,
    remove,
    keys,
    type: "wx",
    getStorageSync: (key) => wx.getStorageSync(key),
    setStorageSync: (key, value) => wx.setStorageSync(key, value),
    removeStorageSync: (key) => wx.removeStorageSync(key),
    capacity: () =>
      new Promise((resolve, reject) =>
        wx.getStorageInfo({
          success: (r) =>
            resolve({
              usedBytes: r.currentSize * 1024,
              limitBytes: r.limitSize * 1024,
            }),
          fail: reject,
        }),
      ),
  };
}

// ---- Node 内存适配（测试用；existingMap 可模拟进程重启后同一存储）----
function createMemoryAdapter(existingMap) {
  const map = existingMap || new Map();
  const rules = []; // 故障注入规则：{ match(key), error, times }

  function checkFault(op, key) {
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i];
      if (r.op !== op && r.op !== "*") continue;
      if (r.match(key)) {
        r.times--;
        if (r.times <= 0) rules.splice(i, 1);
        throw r.error || new Error("injected storage failure");
      }
    }
  }

  return {
    type: "memory",
    _map: map,
    async get(key) {
      return map.has(key) ? clone(map.get(key)) : undefined;
    },
    async set(key, data) {
      checkFault("set", key);
      map.set(key, clone(data));
    },
    async remove(key) {
      checkFault("remove", key);
      map.delete(key);
    },
    async keys() {
      return Array.from(map.keys());
    },
    // 故障注入：接下来 times 次匹配的操作抛出错误（不产生写入）
    inject(match, times, error, op) {
      rules.push({ match, times, error, op: op || "*" });
    },
    clearFaults() {
      rules.length = 0;
    },
  };
}

function createDefaultAdapter() {
  if (typeof wx !== "undefined" && wx && wx.getStorage) {
    const raw = createWxAdapter();
    if (wx.getFileSystemManager && wx.env && wx.env.USER_DATA_PATH) {
      return require("./file-adapter").createFileTierAdapter(raw, wx);
    }
    return raw;
  }
  return createMemoryAdapter();
}

module.exports = {
  createWxAdapter,
  createMemoryAdapter,
  createDefaultAdapter,
  isMissingKeyError,
  clone,
};
