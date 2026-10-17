// pages/receipt/receipt.js — 电子回执（宾客与主家均可查看、保存图片）
const req = require('../../utils/request.js');
const receipt = require('../../utils/receipt.js');

Page({
  data: {
    model: null,
    bookType: '', // 白事不展示广告、不展示推广
    isHost: false, // 主家 / 记账人自己查看时不展示"我家也要办事"
    errMsg: '',
    saving: false
  },

  async onLoad(options) {
    this.setData({ isHost: !!getApp().globalData.account });
    if (!options.rid) return this.setData({ errMsg: '回执不存在' });
    try {
      const { record, accountName, tpl } = await req.receiptGet(options.rid);
      const model = receipt.buildModel(record, tpl, accountName);
      this.setData({ model, bookType: record.bookType || 'other' });
      this.setData({ model: await receipt.withAppCode(model) }); // 小程序码后补，不拖慢回执显示
    } catch (e) {
      this.setData({ errMsg: e.message || '回执加载失败' });
    }
  },

  /** 宾客转化：我家也要办事收礼 → 首页（登录后创建礼簿） */
  goHostEntry() { wx.switchTab({ url: '/pages/index/index' }); },

  async onSave() {
    if (this.data.saving || !this.data.model) return;
    this.setData({ saving: true });
    try {
      const path = await receipt.toImage('#receiptCanvas', this.data.model);
      await receipt.saveImage(path);
    } catch (e) {
      wx.showToast({ title: '生成图片失败，可截屏留存', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  }
});
