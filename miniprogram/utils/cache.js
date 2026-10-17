// utils/cache.js — 页面数据本地缓存（先显示上次的数据，后台刷新后再更新，进入页面不白屏）
// 只缓存展示用数据；退出登录、切换身份、清除数据时整体清空
const PREFIX = 'pc_';

function get(key) {
  try {
    const v = wx.getStorageSync(PREFIX + key);
    return v && v.data !== undefined ? v.data : null;
  } catch (e) {
    return null;
  }
}

function set(key, data) {
  try { wx.setStorageSync(PREFIX + key, { data, at: Date.now() }); } catch (e) { /* 存储满等，忽略 */ }
  if (key.indexOf(REC_PREFIX) === 0) trackRec(key);
}

// 礼簿列表按 礼簿×关系×日期 等筛选组合各存一份，只保留最近使用的 REC_MAX 份，淘汰最早的
const REC_PREFIX = 'rec_';
const REC_MAX = 10;
const REC_IDX = PREFIX + 'recidx'; // 以 pc_ 开头，clear() 时一并清掉

function trackRec(key) {
  try {
    let idx = wx.getStorageSync(REC_IDX);
    // 首次：把旧版本已存下、未入索引的缓存也纳入，便于一起淘汰
    if (!Array.isArray(idx)) {
      idx = (wx.getStorageInfoSync().keys || []).filter(k => k.indexOf(PREFIX + REC_PREFIX) === 0).map(k => k.slice(PREFIX.length));
    }
    idx = idx.filter(k => k !== key);
    idx.push(key);
    idx.splice(0, Math.max(0, idx.length - REC_MAX)).forEach(k => wx.removeStorageSync(PREFIX + k));
    wx.setStorageSync(REC_IDX, idx);
  } catch (e) { /* 忽略 */ }
}

function clear() {
  try {
    (wx.getStorageInfoSync().keys || []).filter(k => k.indexOf(PREFIX) === 0).forEach(k => wx.removeStorageSync(k));
  } catch (e) { /* 忽略 */ }
}

module.exports = { get, set, clear };
