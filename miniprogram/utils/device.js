// utils/device.js — 设备类型判断（PC / 平板不支持扫码、蓝牙打印等）
let _info = null;

function info() {
  if (_info) return _info;
  try {
    _info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
  } catch (e) {
    try { _info = wx.getSystemInfoSync(); } catch (err) { _info = {}; }
  }
  return _info;
}

/** 电脑端（Windows / Mac / 鸿蒙电脑） */
function isPC() {
  const p = String(info().platform || '').toLowerCase();
  return p === 'windows' || p === 'mac' || p === 'ohos_pc' || p === 'linux';
}

/** 非手机：电脑或 iPad */
function notPhone() {
  return isPC() || /ipad/i.test(String(info().model || ''));
}

module.exports = { isPC, notPhone };
