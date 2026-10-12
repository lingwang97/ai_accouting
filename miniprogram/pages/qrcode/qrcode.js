// pages/qrcode/qrcode.js — 我的收款二维码（UC3）
const req = require('../../utils/request.js');

Page({
  data: {
    account: null,
    qrUrl: '',       // 系统收款小程序码
    payCodeUrl: '',  // 个人收款码兜底展示
    loading: true,
    errMsg: ''
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const { account } = await req.accountGet();
      if (!account) {
        wx.showToast({ title: '请先绑定收款账户', icon: 'none' });
        setTimeout(() => wx.redirectTo({ url: '/pages/account/account' }), 800);
        return;
      }
      this.setData({ account });
      const payCodeUrl = await this.getTempUrl(account.payCodeFileID);
      this.setData({ payCodeUrl });

      // 生成专属小程序码；测试号会失败并降级为收款码展示
      try {
        const { fileID } = await req.qrcodeGen(account._id);
        const qrUrl = await this.getTempUrl(fileID);
        this.setData({ qrUrl, errMsg: '' });
      } catch (e) {
        this.setData({ qrUrl: '', errMsg: '小程序码生成失败（测试号限制），已展示个人收款码兜底' });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  getTempUrl(fileID) {
    return new Promise(resolve => {
      wx.cloud.getTempFileURL({
        fileList: [fileID],
        success: res => resolve((res.fileList[0] && res.fileList[0].tempFileURL) || ''),
        fail: () => resolve('')
      });
    });
  },

  async onSave() {
    const url = this.data.qrUrl || this.data.payCodeUrl;
    if (!url) return;
    try {
      const dl = await new Promise((r, j) =>
        wx.downloadFile({ url, success: r, fail: j }));
      await new Promise((r, j) =>
        wx.saveImageToPhotosAlbum({ filePath: dl.tempFilePath, success: r, fail: j }));
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: '保存失败（需相册权限）', icon: 'none' });
    }
  },

  /** 转发给付款方，直达付款页 */
  onShareAppMessage() {
    const a = this.data.account;
    return {
      title: `向「${a ? a.accountName : ''}」付款`,
      path: a ? `/pages/pay/pay?aid=${a._id}` : '/pages/index/index'
    };
  }
});
