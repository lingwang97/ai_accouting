// pages/myreceipts/myreceipts.js — 宾客：我的随礼记录（主家已确认的随礼，可查看电子回执）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const receipt = require('../../utils/receipt.js');

Page({
  data: { list: [], loading: true },

  async onShow() {
    try {
      const { list } = await req.myReceipts();
      this.setData({
        list: list.map(r => ({ ...r, amountStr: fmt.money(r.amount), proxyStr: receipt.proxyText(r), timeStr: fmt.dateTime(r.paidAt || r.createdAt) }))
      });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  onOpen(e) {
    wx.navigateTo({ url: `/pages/receipt/receipt?rid=${e.currentTarget.dataset.id}` });
  }
});
