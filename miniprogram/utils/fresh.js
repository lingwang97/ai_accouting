// utils/fresh.js — 页面切回时的刷新节流：超过 ttl 或期间有写操作才需要刷新
// 用法：onShow 里 if (fresh.needs(this)) { 刷新; fresh.mark(this) }；下拉刷新等强制刷新时 fresh.reset(this)
const TTL = 45 * 1000;

function dirtyAt() {
  try { return getApp().globalData.dataDirtyAt || 0; } catch (e) { return 0; }
}
function needs(page, ttl) {
  const at = page._freshAt || 0;
  return !at || Date.now() - at > (ttl || TTL) || dirtyAt() > at;
}
// at：请求发出前的时间（请求期间发生的写操作晚于它，下次切回仍会刷新）
function mark(page, at) { page._freshAt = at || Date.now(); }
function reset(page) { page._freshAt = 0; }

module.exports = { needs, mark, reset };
