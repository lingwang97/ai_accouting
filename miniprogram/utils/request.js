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
  receiptGet: rid => call('payment', { action: 'receipt', rid }),
  myReceipts: () => call('payment', { action: 'myReceipts' }),
  bookList: () => call('books', { action: 'list' }),
  bookSave: book => call('books', { action: 'save', book }),
  bookSetActive: bookId => call('books', { action: 'setActive', bookId }),
  bookArchive: (bookId, archived) => call('books', { action: 'archive', bookId, archived }),
  bookStats: bookId => call('books', { action: 'stats', bookId }),
  bookGetTpl: bookId => call('books', { action: 'getTpl', bookId }),
  bookSaveTpl: (bookId, tpls) => call('books', { action: 'saveTpl', bookId, ...tpls }),
  purgeAccount: () => call('account', { action: 'purge', confirm: 'DELETE' }),
  exportCleanup: fileID => call('export', { action: 'cleanup', fileID }),
  exportPurge: () => call('export', { action: 'purge' }),
  outList: d => call('renqing', { action: 'outList', ...d }),
  outSave: gift => call('renqing', { action: 'outSave', gift }),
  outDelete: id => call('renqing', { action: 'outDelete', id }),
  rqQuery: key => call('renqing', { action: 'query', key }),
  rqPeople: () => call('renqing', { action: 'people' }),
  payCreate: d => call('payment', { action: 'create', ...d }),
  payTransferred: rid => call('payment', { action: 'transferred', rid, envVersion: envVersion() }),
  payCancel: rid => call('payment', { action: 'cancel', rid }),
  payStatus: rid => call('payment', { action: 'status', rid }),
  payConfirm: (rid, amount) => call('payment', { action: 'confirm', rid, amount }),
  payConfirmBatch: rids => call('payment', { action: 'confirmBatch', rids }),
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
