// utils/privacy.js — 登录页「我已阅读并同意《隐私说明》」的本地记录（v3.84.0；v3.84.1 去掉自定义隐私弹窗接管，交回微信官方处理）
// 注意：不要在这里（或任何地方）注册 wx.onNeedPrivacyAuthorization——自定义弹窗没显示出来时 resolve 不被调用，会让微信一直等待，头像昵称等都无反应。
const LOCAL_KEY = 'privacyAgreed';

function localAgreed() {
  try { return wx.getStorageSync(LOCAL_KEY) === true; } catch (e) { return false; }
}
function setLocalAgreed(v) {
  try { if (v) wx.setStorageSync(LOCAL_KEY, true); else wx.removeStorageSync(LOCAL_KEY); } catch (e) { /* 忽略 */ }
}

module.exports = { LOCAL_KEY, localAgreed, setLocalAgreed };
