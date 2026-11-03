// utils/giftdot.js — 「我的随礼记录」红点（v3.85.0）：有待我确认的更正申请，或主家修改 / 作废了我的记录且我还没看过
const KEY = 'gift_seen';

/** 上次看过的变更时间（毫秒） */
function seen() {
  try { return Number(wx.getStorageSync(KEY)) || 0; } catch (e) { return 0; }
}

/** myReceipts 的结果是否该亮红点 */
function of(res) {
  return !!res && ((res.correctionN || 0) > 0 || (Number(res.lastChangeAt) || 0) > seen());
}

/** 进入「我的随礼记录」后记下已看到的时间 */
function markSeen(ts) {
  try { if ((Number(ts) || 0) > seen()) wx.setStorageSync(KEY, Number(ts)); } catch (e) { /* 忽略 */ }
}

module.exports = { seen, of, markSeen };
