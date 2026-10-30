// utils/guestsub.js — 宾客「入簿 / 未收到」通知订阅（v3.66.1 起在随礼页；v3.74.0 提出为公共方法，申诉时也用；v3.77.0 一次订阅两个模板）
// wx.requestSubscribeMessage 必须在点击的同步调用链里调用（前面不能有 await）；
// 返回 { guestNotify 入簿模板是否同意, guestRejectNotify 未收到模板是否同意 }（拒绝 / 失败都按不同意，照常继续）
const { GUEST_NOTIFY_TMPL_ID, GUEST_REJECT_TMPL_ID } = require('../config.js');

const NONE = { guestNotify: false, guestRejectNotify: false };

function ask() {
  const ids = [GUEST_NOTIFY_TMPL_ID, GUEST_REJECT_TMPL_ID].filter(Boolean);
  if (!ids.length || typeof wx.requestSubscribeMessage !== 'function') return Promise.resolve({ ...NONE });
  return new Promise(resolve => {
    try {
      wx.requestSubscribeMessage({
        tmplIds: ids,
        success: r => resolve({
          guestNotify: !!GUEST_NOTIFY_TMPL_ID && r[GUEST_NOTIFY_TMPL_ID] === 'accept',
          guestRejectNotify: !!GUEST_REJECT_TMPL_ID && r[GUEST_REJECT_TMPL_ID] === 'accept'
        }),
        fail: () => resolve({ ...NONE })
      });
    } catch (e) { resolve({ ...NONE }); }
  });
}

/** 转成接口参数：只带同意的那几个标记 */
function flags(sub) {
  const s = sub || {};
  return { ...(s.guestNotify ? { guestNotify: true } : {}), ...(s.guestRejectNotify ? { guestRejectNotify: true } : {}) };
}

module.exports = { ask, flags };
