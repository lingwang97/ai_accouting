// utils/request.js — 云函数调用统一封装（出入参协议见文档 §5）
/** 当前小程序版本：develop | trial | release */
const envVersion = () => {
  try { return wx.getAccountInfoSync().miniProgram.envVersion; } catch (e) { return 'release'; }
};

// opts.silent：失败不弹提示（非关键的附加内容，如回执上的小程序码）
const call = (name, data = {}, opts = {}) =>
  new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data,
      success: res => {
        const r = res.result || {};
        if (r.code === 0) resolve(r.data);
        else {
          if (!opts.silent) wx.showToast({ title: r.msg || '请求失败', icon: 'none' });
          reject(new Error(r.msg || 'biz error'));
        }
      },
      fail: err => {
        if (!opts.silent) wx.showToast({ title: '网络异常', icon: 'none' });
        reject(err);
      }
    });
  });

function activeBookChanged() {
  try {
    getApp().globalData.activeBookChanged = true;
    require('./cache.js').set('books', null); // 礼簿下拉缓存里的当前礼簿已过期
  } catch (e) { /* 忽略 */ }
}

module.exports = {
  login: userInfo => call('login', { action: 'login', userInfo }),
  loginCheck: () => call('login', { action: 'check' }),
  // withPayCode：需要预览收款码时才让云函数生成临时链接（主家信息页、礼簿码页）
  accountGet: withPayCode => call('account', { action: 'get', withPayCode: !!withPayCode }),
  // 主家称呼等改动：工作台、我的、礼簿下拉的缓存都已过期
  accountSave: d => call('account', { action: 'save', ...d }).then(r => { ['books', 'dashboard', 'mine'].forEach(k => require('./cache.js').set(k, null)); return r; }),
  accountGetByAid: aid => call('account', { action: 'getByAid', aid }),
  receiptGet: (rid, batch) => call('payment', { action: 'receipt', rid, batch: !!batch }),
  myReceipts: () => call('payment', { action: 'myReceipts' }),
  bookList: () => call('books', { action: 'list' }),
  // 当前礼簿变化（切换 / 新建即设为当前）：通知礼簿页下次显示时切到新的当前礼簿
  // 修改已有礼簿：礼簿下拉、工作台缓存里的名称等已过期
  bookSave: book => call('books', { action: 'save', book }).then(r => {
    if (!book._id) activeBookChanged();
    else require('./cache.js').set('books', null);
    require('./cache.js').set('dashboard', null);
    return r;
  }),
  bookSetActive: bookId => call('books', { action: 'setActive', bookId }).then(r => { activeBookChanged(); return r; }),
  // 机构模式记账人：切换自己正在记的一场（不影响主家和其他记账人）
  bookSetMine: bookId => call('books', { action: 'setMine', bookId }).then(r => { activeBookChanged(); return r; }),
  bookArchive: (bookId, archived) => call('books', { action: 'archive', bookId, archived }),
  // 删除礼簿（主家本人，只能删已归档的）：先预览份数与合计，确认后移入回收站（done=false 时再调用接着移）
  bookRemovePreview: bookId => call('books', { action: 'removePreview', bookId }),
  bookRemove: bookId => call('books', { action: 'remove', bookId }).then(r => { require('./cache.js').set('books', null); require('./cache.js').set('dashboard', null); return r; }),
  // 回收站：列表、恢复（done=false 时再调用）、彻底删除（输入礼簿名称）
  trashList: () => call('books', { action: 'trashList' }),
  trashRestore: bookId => call('books', { action: 'trashRestore', bookId }).then(r => { require('./cache.js').set('books', null); return r; }),
  trashPurge: (bookId, confirmName) => call('books', { action: 'trashPurge', bookId, confirmName })
    .then(r => { ['books', 'dashboard'].forEach(k => require('./cache.js').set(k, null)); return r; }),
  bookStats: bookId => call('books', { action: 'stats', bookId }),
  bookGetTpl: bookId => call('books', { action: 'getTpl', bookId }),
  bookSaveTpl: (bookId, tpls) => call('books', { action: 'saveTpl', bookId, ...tpls }),
  purgeAccount: () => call('account', { action: 'purge', confirm: 'DELETE' }),
  inviteCreate: (type, opts) => call('account', { action: 'createInvite', type, ...(opts || {}) }),
  inviteInfo: token => call('account', { action: 'inviteInfo', token }),
  inviteAccept: (token, displayName) => call('account', { action: 'acceptInvite', token, displayName }),
  setHandlerName: (name, memberId) => call('account', { action: 'setHandlerName', name, memberId }),
  memberList: () => call('account', { action: 'members' }),
  memberRemove: memberId => call('account', { action: 'removeMember', memberId }),
  viewerList: () => call('account', { action: 'viewers' }),
  memberUpdate: (memberId, d) => call('account', { action: 'memberUpdate', memberId, ...d }),
  setOrgMode: (orgMode, orgName) => call('account', { action: 'setOrgMode', orgMode, orgName }),
  // 外观设置：主题色（仅主家本人）
  setTheme: primary => call('account', { action: 'setTheme', primary }).then(r => { ['dashboard', 'mine'].forEach(k => require('./cache.js').set(k, null)); return r; }),
  orgSummary: month => call('records', { action: 'orgSummary', month }),
  reconcile: (bookId, day) => call('records', { action: 'reconcile', bookId, day }),
  // 记账人提交的收款码：主家确认后才生效（target 为 'account' 或礼簿 id）
  payCodeReviews: () => call('account', { action: 'payCodeReviews' }),
  payCodeDecide: (target, approve, ver) => call('account', { action: 'payCodeDecide', target, approve: !!approve, ver }),
  // 通过邀请卡申请加入的记账人 / 家人：主家同意后才生效
  memberPending: () => call('account', { action: 'pendingMembers' }),
  memberApprove: (memberId, approve) => call('account', { action: 'approveMember', memberId, approve: !!approve }),
  memberLeave: aid => call('account', { action: 'leave', aid }),
  identitySwitch: aid => call('account', { action: 'switch', aid }),
  exportCleanup: fileID => call('export', { action: 'cleanup', fileID }),
  exportPurge: () => call('export', { action: 'purge' }),
  // 同名区分：人情往来里同名的人、合并 / 取消合并、把某条记录移到别的人
  rqNameCheck: name => call('renqing', { action: 'nameCheck', name }, { silent: true }),
  rqMerge: (from, to) => call('renqing', { action: 'merge', from, to }),
  rqUnmerge: from => call('renqing', { action: 'unmerge', from }),
  rqMoveEntry: d => call('renqing', { action: 'moveEntry', ...d }),
  // 礼簿里同名的宾客（礼台记账前选择是哪一位）、给宾客设区分备注
  bookNameCheck: names => call('records', { action: 'nameCheck', names }, { silent: true }),
  setNameTag: (rid, tag) => call('records', { action: 'setNameTag', rid, tag }),
  // 亲友办事提醒
  remindList: () => call('renqing', { action: 'remindList' }),
  remindSave: (remind, subscribed) => call('renqing', { action: 'remindSave', remind, subscribed: !!subscribed, envVersion: envVersion() }),
  remindDone: (id, done) => call('renqing', { action: 'remindDone', id, done: done !== false }),
  remindDelete: id => call('renqing', { action: 'remindDelete', id }),
  outList: d => call('renqing', { action: 'outList', ...d }),
  outSave: gift => call('renqing', { action: 'outSave', gift }),
  outDelete: id => call('renqing', { action: 'outDelete', id }),
  rqQuery: key => call('renqing', { action: 'query', key }),
  rqPeople: () => call('renqing', { action: 'people' }),
  payCreate: d => call('payment', { action: 'create', envVersion: envVersion(), ...d }),
  payTransferred: rid => call('payment', { action: 'transferred', rid, envVersion: envVersion() }),
  payCancel: rid => call('payment', { action: 'cancel', rid }),
  payStatus: rid => call('payment', { action: 'status', rid }),
  payConfirm: (rid, amount, amounts) => call('payment', { action: 'confirm', rid, amount, amounts }),
  payConfirmBatch: rids => call('payment', { action: 'confirmBatch', rids }),
  cashEntry: d => call('payment', { action: 'cashEntry', ...d }),
  payReject: rid => call('payment', { action: 'reject', rid }),
  payDismissStall: rid => call('payment', { action: 'dismissStall', rid }),
  payVoid: rid => call('payment', { action: 'void', rid }),
  recordList: d => call('records', { action: 'list', ...d }),
  markPrinted: rids => call('records', { action: 'markPrinted', rids }),
  recordPending: () => call('records', { action: 'pending' }),
  dashboard: () => call('records', { action: 'dashboard' }),
  pendingStat: () => call('records', { action: 'pendingStat' }, { silent: true }),
  recordThemes: () => call('records', { action: 'themes' }),
  exportFile: d => call('export', d),
  tplGet: () => call('printtpl', { action: 'get' }),
  tplSave: tpl => call('printtpl', { action: 'save', tpl }),
  qrcodeGen: (aid, bookId) => call('qrcode', { action: 'gen', aid, bookId, envVersion: envVersion() }),
  appCode: () => call('qrcode', { action: 'app', envVersion: envVersion() }, { silent: true }),
  // 套餐与系统设置（付费订阅预留）
  planGet: () => call('system', { action: 'plan' }, { silent: true }),
  adminGet: () => call('system', { action: 'adminGet' }),
  adminSetWarmup: warmup => call('system', { action: 'adminSetWarmup', warmup }),
  adminSetPlan: (ownerOpenid, plan, days) => call('system', { action: 'adminSetPlan', ownerOpenid, plan, days }),
  adminFindHosts: keyword => call('system', { action: 'adminFindHosts', keyword }),
  adminIndexes: () => call('system', { action: 'adminIndexes' }),
  // 数据清除（管理员）
  adminPurgePreview: (ownerOpenid, guestRecords) => call('system', { action: 'adminPurgePreview', ownerOpenid, guestRecords: !!guestRecords }),
  adminBackup: ownerOpenid => call('system', { action: 'adminBackup', ownerOpenid }),
  adminPurge: d => call('system', { action: 'adminPurge', ...d }),
  adminBookPreview: keyword => call('system', { action: 'adminBookPreview', keyword }),
  adminPurgeBook: (bookId, confirmName) => call('system', { action: 'adminPurgeBook', bookId, confirmName }),
  adminOrphanPreview: () => call('system', { action: 'adminOrphanPreview' }),
  adminOrphanPurge: () => call('system', { action: 'adminOrphanPurge' }),
  adminLogs: () => call('system', { action: 'adminLogs' }),
  // 清除全部测试数据（上线前一次性）、标记正式上线
  adminWipePreview: keepAdmins => call('system', { action: 'adminWipePreview', keepAdmins: keepAdmins !== false }),
  adminWipeAll: (confirmText, keepAdmins) => call('system', { action: 'adminWipeAll', confirmText, keepAdmins: keepAdmins !== false }),
  adminMarkLaunched: () => call('system', { action: 'adminMarkLaunched', confirm: true }),
  adsConfig: () => call('system', { action: 'ads' }, { silent: true }),
  adminSetAds: ads => call('system', { action: 'adminSetAds', ads })
};
