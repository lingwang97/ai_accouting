// utils/request.js — 云函数调用统一封装（出入参协议见文档 §5）
/** 当前小程序版本：develop | trial | release */
const envVersion = () => {
  try { return wx.getAccountInfoSync().miniProgram.envVersion; } catch (e) { return 'release'; }
};

const call = (name, data = {}) =>
  new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data,
      success: res => {
        const r = res.result || {};
        if (r.code === 0) resolve(r.data);
        else {
          wx.showToast({ title: r.msg || '请求失败', icon: 'none' });
          reject(new Error(r.msg || 'biz error'));
        }
      },
      fail: err => {
        wx.showToast({ title: '网络异常', icon: 'none' });
        reject(err);
      }
    });
  });

module.exports = {
  login: userInfo => call('login', { action: 'login', userInfo }),
  loginCheck: () => call('login', { action: 'check' }),
  accountGet: () => call('account', { action: 'get' }),
  accountSave: d => call('account', { action: 'save', ...d }),
  accountGetByAid: aid => call('account', { action: 'getByAid', aid }),
  payCreate: d => call('payment', { action: 'create', ...d }),
  payTransferred: rid => call('payment', { action: 'transferred', rid, envVersion: envVersion() }),
  payCancel: rid => call('payment', { action: 'cancel', rid }),
  payStatus: rid => call('payment', { action: 'status', rid }),
  payConfirm: rid => call('payment', { action: 'confirm', rid }),
  payReject: rid => call('payment', { action: 'reject', rid }),
  payVoid: rid => call('payment', { action: 'void', rid }),
  recordList: d => call('records', { action: 'list', ...d }),
  markPrinted: rids => call('records', { action: 'markPrinted', rids }),
  recordPending: () => call('records', { action: 'pending' }),
  recordThemes: () => call('records', { action: 'themes' }),
  exportFile: d => call('export', d),
  tplGet: () => call('printtpl', { action: 'get' }),
  tplSave: tpl => call('printtpl', { action: 'save', tpl }),
  qrcodeGen: aid => call('qrcode', { action: 'gen', aid, envVersion: envVersion() })
};
