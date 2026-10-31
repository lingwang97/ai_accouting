// utils/viewerbook.js — 家人共享（只读）在本机记住「正在看的那本礼簿」（v3.78.0）
// 只存在本机，不写库；服务端 records.dashboard 只在该礼簿属于共享范围（canBook）时才采用，否则回退默认。
const KEY = 'viewer_book';

function get() {
  try { const v = wx.getStorageSync(KEY); return typeof v === 'string' ? v : ''; } catch (e) { return ''; }
}

function set(id) {
  try { wx.setStorageSync(KEY, String(id || '')); } catch (e) { /* 存储失败忽略，下次回到默认 */ }
}

module.exports = { get, set, KEY };
