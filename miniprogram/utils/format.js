// utils/format.js — 金额/日期格式化
const pad = n => (n < 10 ? '0' + n : '' + n);

function money(n) {
  return (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
}

function day(d) {
  const t = new Date(d);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

function time(d) {
  const t = new Date(d);
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

function dateTime(d) {
  return `${day(d)} ${time(d)}`;
}

/** 汇总用整数分累加，避免浮点误差 */
function sumAmounts(list) {
  const fen = list.reduce((s, r) => s + Math.round(r.amount * 100), 0);
  return fen / 100;
}

module.exports = { money, day, time, dateTime, sumAmounts };
