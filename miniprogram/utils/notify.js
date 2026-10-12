// utils/notify.js — 新转账订阅消息（店主不在小程序前台时通过微信服务通知提醒）
// 一次性订阅：店主每同意一次，可收到一条提醒，因此在常用按钮上顺带续订
const { NOTIFY_TMPL_ID } = require('../config.js');

const enabled = () => !!NOTIFY_TMPL_ID;

/** 主动订阅（必须在点击事件中直接调用）；返回是否同意 */
function subscribe() {
  if (!enabled()) {
    wx.showToast({ title: '提醒模板未配置', icon: 'none' });
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    wx.requestSubscribeMessage({
      tmplIds: [NOTIFY_TMPL_ID],
      success: res => {
        const ok = res[NOTIFY_TMPL_ID] === 'accept';
        wx.showToast({ title: ok ? '已开启下一笔提醒' : '未开启提醒', icon: ok ? 'success' : 'none' });
        resolve(ok);
      },
      fail: () => resolve(false)
    });
  });
}

/**
 * 静默续订：仅当店主已勾选"总是保持以上选择"且同意时调用（此时不弹窗），
 * 在"确认收款"等点击中调用，每确认一笔补一次提醒额度。
 */
function renewSilently() {
  if (!enabled()) return;
  wx.getSetting({
    withSubscriptions: true,
    success: res => {
      const s = res.subscriptionsSetting || {};
      if (s.mainSwitch && s.itemSettings && s.itemSettings[NOTIFY_TMPL_ID] === 'accept') {
        wx.requestSubscribeMessage({ tmplIds: [NOTIFY_TMPL_ID], fail() {} });
      }
    }
  });
}

module.exports = { enabled, subscribe, renewSilently };
