// utils/editlock.js — 已入簿礼金的 72 小时修改期（v3.85.0）：截止时间由云端返回（editUntil，毫秒），这里只负责显示
/** 'open' 还能直接修改 / 作废；'locked' 已超期；editUntil 缺失（旧缓存）按 open，云端会再校验 */
function stateOf(r) {
  if (!r || r.editUntil === undefined || r.editUntil === null) return 'open';
  return Number(r.editUntil) > Date.now() ? 'open' : 'locked';
}

/** 「还可修改 N 小时」；超期返回「已超 72 小时」；没有截止时间返回空 */
function hint(r) {
  if (!r || r.editUntil === undefined || r.editUntil === null) return '';
  const left = Number(r.editUntil) - Date.now();
  if (left <= 0) return '已超 72 小时';
  const h = Math.ceil(left / 3600000);
  return h <= 1 ? '还可修改不足 1 小时' : `还可修改 ${h} 小时`;
}

module.exports = { stateOf, hint };
