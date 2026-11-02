// utils/privacy.js — 微信隐私授权（v3.84.0）
// 1) app.js 启动时 init()：用 wx.onNeedPrivacyAuthorization 接管「需要隐私授权」事件（基础库 2.32.3+；更低版本没有该接口，静默跳过）
// 2) 每个会触发隐私接口的页面挂 <privacy-popup />，页面显示时登记为当前弹窗；事件来时由当前弹窗展示「同意 / 拒绝」
// 3) 登录页的「我已阅读并同意《隐私说明》」勾选状态记在本地 LOCAL_KEY（同意过一次就记住）
const LOCAL_KEY = 'privacyAgreed';
const WAIT_MS = 2000; // 当前页没挂弹窗时最多等这么久，仍无人接手就按「拒绝」处理（接口报错，不影响其他功能）

let cur = null;         // 当前页面的弹窗实例
let timer = null;
const pending = [];     // 弹窗还没登记时先排队的 { resolve, info }

function supported() {
  return typeof wx !== 'undefined' && typeof wx.onNeedPrivacyAuthorization === 'function';
}

function init() {
  if (!supported()) return false;
  try {
    wx.onNeedPrivacyAuthorization((resolve, info) => request(resolve, info));
    return true;
  } catch (e) { return false; }
}

function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }

function request(resolve, info) {
  if (typeof resolve !== 'function') return;
  if (cur) { cur.open(resolve, info); return; }
  pending.push({ resolve, info });
  if (!timer) timer = setTimeout(flushDisagree, WAIT_MS);
}

function flushDisagree() {
  timer = null;
  if (cur) return;
  pending.splice(0).forEach(p => { try { p.resolve({ event: 'disagree' }); } catch (e) { /* 忽略 */ } });
}

/** 页面显示时登记；有排队的事件立即交给它 */
function setCurrent(inst) {
  cur = inst;
  if (cur && pending.length) {
    clearTimer();
    pending.splice(0).forEach(p => cur.open(p.resolve, p.info));
  }
}
function clearCurrent(inst) { if (cur === inst) cur = null; }

function localAgreed() {
  try { return wx.getStorageSync(LOCAL_KEY) === true; } catch (e) { return false; }
}
function setLocalAgreed(v) {
  try { if (v) wx.setStorageSync(LOCAL_KEY, true); else wx.removeStorageSync(LOCAL_KEY); } catch (e) { /* 忽略 */ }
}

module.exports = { LOCAL_KEY, supported, init, request, setCurrent, clearCurrent, localAgreed, setLocalAgreed };
