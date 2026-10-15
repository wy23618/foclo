function dateText(seconds) {
  const date = new Date(Number(seconds) * 1000);
  if (!Number.isFinite(Number(seconds)) || Number.isNaN(date.getTime())) return '时间未知';
  const pad = n => String(n).padStart(2, '0');
  return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}
module.exports = { dateText };
