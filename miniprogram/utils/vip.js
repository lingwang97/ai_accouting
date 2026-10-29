// utils/vip.js — 会员功能被点时的统一弹窗（与高级功能页同风格）：说明原因，带「联系我们」
// 套餐里没有定义的功能视为开放（plan.has），只有管理员明确关闭才会走到这里
function explain(title, reason, contact) {
  if (contact === false) {
    return wx.showModal({ title, content: reason, showCancel: false, confirmText: '知道了' });
  }
  wx.showModal({
    title, content: reason, confirmText: '联系我们', cancelText: '知道了',
    success: r => { if (r.confirm) wx.navigateTo({ url: '/pages/contact/contact' }); }
  });
}
module.exports = { explain };
