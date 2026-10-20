// pages/myreceipts/myreceipts.js — 宾客：我的随礼记录（主家已确认的随礼，可查看电子回执）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');

Page({
  data: { list: [], loading: true },

  async onShow() {
    try {
      const { list } = await req.myReceipts();
      this.setData({
        list: list.map(r => ({ ...r, amountStr: fmt.money(r.amount), timeStr: fmt.dateTime(r.paidAt || r.createdAt) }))
      });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  /** 宾客转化：我家也要办事收礼 → 首页（登录后创建礼簿） */
  goHostEntry() { wx.switchTab({ url: '/pages/index/index' }); },
  /** 转发给好友 / 分享到朋友圈：落地首页（宾客扫码随礼，主家创建礼簿） */
  onShareAppMessage() {
    return { title: '慧礼记｜扫码随礼、自动记账、人情往来一本清', path: '/pages/index/index' };
  },
  onShareTimeline() {
    return { title: '慧礼记｜办事收礼，扫码随礼自动记账' };
  },

  onOpen(e) {
    wx.navigateTo({ url: `/pages/receipt/receipt?rid=${e.currentTarget.dataset.id}` });
  }
});
