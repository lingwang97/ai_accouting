// pages/index/index.js — 首页：面向宾客，只做"扫码随礼"
const req = require('../../utils/request.js');

Page({
  onShow() {
    getApp().refreshTabBar();
    this.syncBadge();
  },

  /** 收款方打开首页时也同步"我的"角标（付款方无账户，静默跳过） */
  async syncBadge() {
    const app = getApp();
    try {
      if (app.globalData.account === null && !app._accountChecked) {
        const { account } = await req.accountGet();
        app.globalData.account = account;
        app._accountChecked = true;
      }
      app.refreshBadge();
    } catch (e) { /* 静默 */ }
  },

  goMyReceipts() { wx.navigateTo({ url: '/pages/myreceipts/myreceipts' }); },

  /** 扫描收款方的收款小程序码 → 进入付款页 */
  onScan() {
    wx.scanCode({
      onlyFromCamera: false,
      success: res => {
        // 小程序码扫描结果 path 形如 pages/pay/pay?scene=<aid>；分享链接/旧码为 aid=<aid>
        const raw = decodeURIComponent(res.path || res.result || '');
        const m = raw.match(/pages\/pay\/pay\?(?:scene=)?(?:aid=)?([a-zA-Z0-9_-]+)/) || raw.match(/aid=([a-zA-Z0-9_-]+)/);
        if (m) {
          wx.navigateTo({ url: `/pages/pay/pay?aid=${m[1]}` });
        } else {
          wx.showToast({ title: '不是有效的礼簿码', icon: 'none' });
        }
      }
    });
  }
});
