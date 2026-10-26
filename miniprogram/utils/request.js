// utils/request.js — 云函数调用统一封装（出入参协议见文档 §5）
/** 当前小程序版本：develop | trial | release */
const envVersion = () => {
  try { return wx.getAccountInfoSync().miniProgram.envVersion; } catch (e) { return 'release'; }
};

// 只读 action：其余一律视为写操作，成功后记下时间（页面切回时据此判断是否必须刷新，见 utils/fresh.js）
const READ_ACTIONS = ['get', 'list', 'query', 'people', 'outList', 'remindList', 'pending', 'pendingStat', 'dashboard',
  'status', 'receipt', 'myReceipts', 'receiptByToken', 'issueQr', 'qrCheck', 'themes', 'check', 'getByAid', 'gen', 'app', 'plan', 'adminGet', 'detail',
  'nameCheck', 'reconcile', 'orgSummary', 'removePreview', 'members', 'pendingMembers', 'getTpl', 'stats', 'trashList',
  'viewers', 'payCodeReviews', 'inviteInfo', 'advGet',
  // export 预览：只生成临时文件，不改礼簿 / 礼金数据（与导出不同，不触发页面强制刷新）
  'bookPreview', 'bookPreviewData',
  // system 只读：ads 读设置；admin*Preview / adminFindHosts / adminLogs / adminPreflight(不带 Fix) 只查不写（adminIndexes 会建索引，不列入）
  'ads', 'adminFindHosts', 'adminLogs', 'adminPreflight', 'adminPurgePreview', 'adminBookPreview', 'adminOrphanPreview', 'adminWipePreview'];
function markWrite(data) {
  try {
    if (data && READ_ACTIONS.indexOf(data.action) < 0) getApp().globalData.dataDirtyAt = Date.now();
  } catch (e) { /* 忽略 */ }
}

// opts.silent：失败不弹提示（非关键的附加内容，如回执上的小程序码）
const call = (name, data = {}, opts = {}) =>
  new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data,
      success: res => {
        const r = res.result || {};
        if (r.code === 0) { markWrite(data); resolve(r.data); }
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

// 入簿 / 确认 / 作废等写操作成功后：工作台缓存里的今日合计、待确认数已过期，清掉避免下次进入先显示旧数
function dropDash(r) {
  try { require('./cache.js').set('dashboard', null); } catch (e) { /* 忽略 */ }
  return r;
}

module.exports = {
  login: userInfo => call('login', { action: 'login', userInfo }),
  loginCheck: () => call('login', { action: 'check' }),
  // withPayCode：需要预览收款码时才让云函数生成临时链接（主家信息页、礼簿码页）
  accountGet: withPayCode => call('account', { action: 'get', withPayCode: !!withPayCode }),
  // 主家称呼等改动：工作台、我的、礼簿下拉的缓存都已过期
  accountSave: d => call('account', { action: 'save', ...d }).then(r => { ['books', 'dashboard', 'mine'].forEach(k => require('./cache.js').set(k, null)); return r; }),
  pollLevelGet: () => call('account', { action: 'get' }, { silent: true }),
  advGet: () => call('account', { action: 'advGet' }, { silent: true }),
  setTrashDays: days => call('account', { action: 'setTrashDays', days }),
  setPollLevel: level => call('account', { action: 'setPollLevel', level }),
  accountGetByAid: aid => call('account', { action: 'getByAid', aid }),
  receiptGet: (rid, batch) => call('payment', { action: 'receipt', rid, batch: !!batch }),
  myReceipts: () => call('payment', { action: 'myReceipts' }),
  // 小票二维码（v3.57.0）：issueQr 静默（失败不弹提示，小票照常打印）
  issueQr: rid => call('payment', { action: 'issueQr', rid, envVersion: envVersion() }, { silent: true }),
  receiptByToken: token => call('payment', { action: 'receiptByToken', token }),
  qrCheck: withRaster => call('payment', { action: 'qrCheck', envVersion: envVersion(), withRaster: !!withRaster }),
  claimReceipt: token => call('payment', { action: 'claimReceipt', token }),
  resetQr: rid => call('payment', { action: 'resetToken', rid }),
  unclaim: rid => call('payment', { action: 'unclaim', rid }),
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
  bookRecalc: bookId => call('books', { action: 'recalc', bookId }).then(r => { ['books', 'dashboard'].forEach(k => require('./cache.js').set(k, null)); return r; }),
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
  bookNameCheck: (names, bookId) => call('records', { action: 'nameCheck', names, bookId: bookId || '' }, { silent: true }),
  setNameTag: (rid, tag) => call('records', { action: 'setNameTag', rid, tag }),
  // 亲友办事提醒
  remindList: () => call('renqing', { action: 'remindList' }),
  remindSave: (remind, subscribed) => call('renqing', { action: 'remindSave', remind, subscribed: !!subscribed, envVersion: envVersion() }),
  remindDone: (id, done) => call('renqing', { action: 'remindDone', id, done: done !== false }),
  remindDelete: id => call('renqing', { action: 'remindDelete', id }),
  remindClearDone: () => call('renqing', { action: 'remindClearDone' }),
  outList: d => call('renqing', { action: 'outList', ...d }),
  outSave: gift => call('renqing', { action: 'outSave', gift }),
  outDelete: id => call('renqing', { action: 'outDelete', id }),
  rqQuery: key => call('renqing', { action: 'query', key }),
  rqPeople: () => call('renqing', { action: 'people' }),
  payCreate: d => call('payment', { action: 'create', envVersion: envVersion(), ...d }),
  payTransferred: rid => call('payment', { action: 'transferred', rid, envVersion: envVersion() }),
  payCancel: rid => call('payment', { action: 'cancel', rid }),
  payStatus: rid => call('payment', { action: 'status', rid }),
  payConfirm: (rid, amount, amounts) => call('payment', { action: 'confirm', rid, amount, amounts }).then(dropDash),
  payConfirmBatch: rids => call('payment', { action: 'confirmBatch', rids }).then(dropDash),
  cashEntry: d => call('payment', { action: 'cashEntry', ...d }).then(dropDash),
  payReject: rid => call('payment', { action: 'reject', rid }).then(dropDash),
  payDismissStall: rid => call('payment', { action: 'dismissStall', rid }).then(dropDash),
  payVoid: rid => call('payment', { action: 'void', rid }).then(dropDash),
  payUnreject: rid => call('payment', { action: 'unreject', rid }).then(dropDash),
  payAmend: (rid, fields) => call('payment', { action: 'amend', rid, ...fields }).then(dropDash),
  recordList: d => call('records', { action: 'list', ...d }),
  markPrinted: rids => call('records', { action: 'markPrinted', rids }),
  recordPending: withRejected => call('records', withRejected ? { action: 'pending', withRejected: true } : { action: 'pending' }),
  dashboard: () => call('records', { action: 'dashboard' }),
  pendingStat: () => call('records', { action: 'pendingStat' }, { silent: true }),
  // 待确认页轮询：带 withExtra 另返回 stall / rej 两个分组的条数
  recordStat: d => call('records', { action: 'pendingStat', ...d }, { silent: true }),
  recordThemes: () => call('records', { action: 'themes' }),
  exportFile: d => call('export', d),
  // 传统礼簿 PDF 预览（3 页小 PDF）与示意图用的前几笔宾客数据
  exportPreview: d => call('export', Object.assign({}, d, { action: 'bookPreview' })),
  exportPreviewData: bookId => call('export', { action: 'bookPreviewData', bookId }, { silent: true }),
  qrcodeGen: (aid, bookId) => call('qrcode', { action: 'gen', aid, bookId, envVersion: envVersion() }),
  appCode: () => call('qrcode', { action: 'app', envVersion: envVersion() }, { silent: true }),
  // 套餐与系统设置（付费订阅预留）
  planGet: () => call('system', { action: 'plan' }, { silent: true }),
  adminGet: () => call('system', { action: 'adminGet' }),
  adminSetWarmup: warmup => call('system', { action: 'adminSetWarmup', warmup }),
  adminSetPlan: (ownerOpenid, plan, days) => call('system', { action: 'adminSetPlan', ownerOpenid, plan, days }),
  adminFindHosts: keyword => call('system', { action: 'adminFindHosts', keyword }),
  adminIndexes: () => call('system', { action: 'adminIndexes' }),
  adminPreflight: fix => call('system', { action: fix ? 'adminPreflightFix' : 'adminPreflight' }),
  // 一次性：把导出字体上传到云存储（fontsetup 云函数，用完可删；未部署时 silent 由页面提示）
  adminFontsUpload: () => call('fontsetup', { action: 'upload' }, { silent: true }),
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
