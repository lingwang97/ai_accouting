// utils/confirm.js — 收款方确认/拒绝转账（账目页与"我的"页共用）
const req = require('./request.js');
const printer = require('./printer.js');
const fmt = require('./format.js');
const notify = require('./notify.js');

/** 确认收款 → 自动打印；返回是否已确认 */
function confirmTransfer(record) {
  notify.renewSilently(); // 在点击中顺带续订下一笔提醒
  const amount = fmt.money(record.amount);
  return new Promise(resolve => {
    wx.showModal({
      title: '确认收款',
      content: `请核对微信已收到 ${record.payerName} 转账 ￥${amount}`,
      confirmText: '已收到',
      success: async res => {
        if (!res.confirm) return resolve(false);
        try {
          await req.payConfirm(record._id);
          wx.showToast({ title: '已确认收款', icon: 'success' });
          await autoPrint(record);
          getApp().refreshBadge();
          resolve(true);
        } catch (e) {
          resolve(false); // request.js 已 toast
        }
      },
      fail: () => resolve(false)
    });
  });
}

/** 未收到款；返回是否已标记 */
function rejectTransfer(record) {
  const amount = fmt.money(record.amount);
  return new Promise(resolve => {
    wx.showModal({
      title: '未收到转账',
      content: `确定未收到 ${record.payerName} 的 ￥${amount} ？付款方将看到"未确认到账"`,
      confirmColor: '#FA5151',
      success: async res => {
        if (!res.confirm) return resolve(false);
        try {
          await req.payReject(record._id);
          wx.showToast({ title: '已标记', icon: 'success' });
          getApp().refreshBadge();
          resolve(true);
        } catch (e) {
          resolve(false);
        }
      },
      fail: () => resolve(false)
    });
  });
}

/** 确认后自动打印；打印机未连接时仅提示，不阻断确认流程 */
async function autoPrint(record) {
  if (!(await printer.ensureConnected())) {
    wx.showToast({ title: '打印机未连接，可在账目页补打', icon: 'none' });
    return false;
  }
  try {
    await printer.printRecord({ ...record, status: 'paid' });
    return true;
  } catch (e) {
    wx.showToast({ title: '自动打印失败，可在账目页补打', icon: 'none' });
    return false;
  }
}

module.exports = { confirmTransfer, rejectTransfer };
