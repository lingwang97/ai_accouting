// utils/guestsub.js — 宾客「入簿 / 处理结果通知」订阅（v3.66.1 起在随礼页；v3.74.0 提出为公共方法，申诉时也用）
// wx.requestSubscribeMessage 必须在点击的同步调用链里调用（前面不能有 await）；返回是否同意（拒绝 / 失败都按不同意，照常继续）
const { GUEST_NOTIFY_TMPL_ID } = require('../config.js');

function ask() {
  if (!GUEST_NOTIFY_TMPL_ID || typeof wx.requestSubscribeMessage !== 'function') return Promise.resolve(false);
  return new Promise(resolve => {
    try {
      wx.requestSubscribeMessage({
        tmplIds: [GUEST_NOTIFY_TMPL_ID],
        success: r => resolve(r[GUEST_NOTIFY_TMPL_ID] === 'accept'),
        fail: () => resolve(false)
      });
    } catch (e) { resolve(false); }
  });
}

module.exports = { ask };
