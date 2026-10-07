// core/ids.js
// 离线可生成的全局唯一 ID（UUIDv4 形态）。
// 不使用项目名、数组下标、单机自增值或仅当前毫秒数。
// 同时兼容：Node（global crypto）、微信小程序（无 crypto 时 Math.random + 时间 + 计数器混合）。

let counter = 0;

function secureRandomBytes(len) {
  const out = new Array(len);
  const g = typeof globalThis !== 'undefined' ? globalThis : this;
  if (g && g.crypto && typeof g.crypto.getRandomValues === 'function') {
    const buf = new Uint8Array(len);
    g.crypto.getRandomValues(buf);
    for (let i = 0; i < len; i++) out[i] = buf[i];
    return out;
  }
  // 回退路径：Math.random 与时间戳、进程内计数器混合
  let timeSeed = Date.now();
  for (let i = 0; i < len; i++) {
    counter = (counter + 1) % 0x100000;
    timeSeed = (timeSeed * 1103515245 + 12345) & 0x7fffffff;
    const r = Math.floor(Math.random() * 256);
    const t = (timeSeed ^ counter ^ (timeSeed >>> (i % 24))) & 0xff;
    out[i] = r ^ t;
  }
  return out;
}

function uuid() {
  const b = secureRandomBytes(16);
  // RFC4122 v4
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.map((x) => x.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}

module.exports = {
  uuid,
  secureRandomBytes
};
