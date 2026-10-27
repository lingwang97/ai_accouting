// utils/notify.js — 新礼金订阅消息（主家不在小程序前台时通过微信服务通知提醒）
// 一次性订阅：每同意一次可收到一条提醒。勾选「总是保持以上选择」后再次申请不弹窗，
// 因此在「确认收到」等点击中顺带续订，保证下一笔还能收到
const { NOTIFY_TMPL_ID } = require('../config.js');

const enabled = () => !!NOTIFY_TMPL_ID;
let always = false; // 已勾选"总是保持"并同意：可在点击中静默续订
const ON_KEY = 'notify_on_at'; // 本机最近一次同意订阅的时间
// 新礼金提醒默认关闭（v3.66.3）：是否开启存在服务端 users.giftNotify（按人），这里缓存一份给 renewSilently 同步判断
const GIFT_KEY = 'gift_notify';
let gift = false;
try { gift = wx.getStorageSync(GIFT_KEY) === true; } catch (e) { /* 忽略 */ }
/** 同步服务端的开关值（account.get / dashboard 返回的 giftNotify）；undefined（旧云函数）时不改 */
function setGift(v) {
  if (v === undefined) return;
  gift = v === true;
  try { wx.setStorageSync(GIFT_KEY, gift); } catch (e) { /* 忽略 */ }
}
const giftOn = () => gift;

/** 读取订阅设置（异步，结果缓存给 renewSilently 用） */
function refresh() {
  if (!enabled()) return;
  wx.getSetting({
    withSubscriptions: true,
    success: res => {
      const s = res.subscriptionsSetting || {};
      always = !!(s.mainSwitch && s.itemSettings && s.itemSettings[NOTIFY_TMPL_ID] === 'accept');
    }
  });
}
refresh();

let failShown = false; // 最近一次 subscribe 失败时已弹过原因（调用方不再重复弹）
const subscribeFailShown = () => failShown;

/** 主动订阅（必须在点击事件中直接调用）；返回是否同意 */
function subscribe() {
  if (!enabled()) {
    wx.showModal({ title: '提醒暂未开通', content: '新礼金微信提醒尚未配置消息模板，暂时无法开启。', showCancel: false });
    return Promise.resolve(false);
  }
  failShown = false;
  return new Promise(resolve => {
    wx.requestSubscribeMessage({
      tmplIds: [NOTIFY_TMPL_ID],
      success: res => {
        const ok = res[NOTIFY_TMPL_ID] === 'accept';
        if (ok) { try { wx.setStorageSync(ON_KEY, Date.now()); } catch (e) { /* 忽略 */ } }
        refresh();
        resolve(ok);
      },
      fail: e => {
        failShown = true;
        wx.showModal({ title: '没能开启提醒', content: subscribeFailText(e), showCancel: false, confirmText: '知道了' });
        resolve(false);
      }
    });
  });
}

/** 订阅失败的中文说明（v3.65.2，不再直接显示微信的英文错误） */
function subscribeFailText(e) {
  const code = Number(e && e.errCode);
  if (code === 20004) return '你关闭了本小程序的通知总开关。请点右上角「···」→ 设置 → 通知管理，打开「接收通知」后再试。';
  if (code === 10005) return '当前页面暂时无法弹出授权窗口，请稍后在工作台再点一次「开启提醒」。';
  if (code === 20001 || code === 20002 || code === 20003) return '提醒模板暂时不可用，请稍后再试；如一直失败请联系客服。';
  return '请稍后再试；如果没有弹出授权窗口，请点右上角「···」→ 设置 → 通知管理，打开通知。';
}

/**
 * 静默续订：必须在用户点击的同步调用链中执行（不能放在异步回调里，否则微信会拒绝），
 * 仅当已勾选"总是保持以上选择"时调用，此时不弹窗，每确认一笔补一次提醒额度
 */
function renewSilently() {
  if (!enabled() || !gift || !always) return; // 没开启新礼金提醒的人不续订、不弹授权
  wx.requestSubscribeMessage({ tmplIds: [NOTIFY_TMPL_ID], fail() {} });
}

/**
 * 工作台 / 待确认页的提示文字；不需要提示时返回 ''
 * lastNotify 为云函数记录的最近一次发送结果（account.get 返回）；giftOn 为服务端的开关，没开启的人不提示（v3.66.3）
 */
function tipText(lastNotify, giftOn) {
  if (!enabled() || giftOn !== true) return '';
  let onAt = 0;
  try { onAt = Number(wx.getStorageSync(ON_KEY)) || 0; } catch (e) { /* 忽略 */ }
  const at = lastNotify && lastNotify.at ? new Date(lastNotify.at).getTime() : 0;
  if (onAt > at) return ''; // 刚开启过，还没有新的发送结果
  if (!lastNotify) return '开启新礼金微信提醒，宾客转账后第一时间知道';
  if (lastNotify.ok) return '';
  if (lastNotify.code === 43101) return '新礼金提醒次数已用完，点此重新开启';
  if (String(lastNotify.code) === '-604101') return '新礼金提醒发送失败：云函数无发送权限，请联系开发者';
  return `新礼金提醒上次发送失败（${lastNotify.code}），点此重新开启`;
}

module.exports = { enabled, subscribe, renewSilently, refresh, tipText, subscribeFailText, setGift, giftOn, subscribeFailShown };
