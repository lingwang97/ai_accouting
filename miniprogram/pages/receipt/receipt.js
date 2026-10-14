// pages/receipt/receipt.js — 电子回执（宾客与主家均可查看、保存图片）
const req = require('../../utils/request.js');
const receipt = require('../../utils/receipt.js');

Page({
  data: {
    model: null,
    errMsg: '',
    saving: false
  },

  async onLoad(options) {
    if (!options.rid) return this.setData({ errMsg: '回执不存在' });
    try {
      const { record, accountName, tpl } = await req.receiptGet(options.rid);
      this.setData({ model: receipt.buildModel(record, tpl, accountName) });
    } catch (e) {
      this.setData({ errMsg: e.message || '回执加载失败' });
    }
  },

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
