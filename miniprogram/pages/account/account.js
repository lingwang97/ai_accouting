// pages/account/account.js — 主家信息：称呼、微信收款码、主题色、快捷礼金
const req = require('../../utils/request.js');

const PRESET_COLORS = ['#C8161D', '#07C160', '#B8860B', '#2B7FFF', '#333333'];
const DEFAULT_QUICK = [200, 500, 600, 800, 1000, 1888];

Page({
  data: {
    accountName: '',
    payCodeUrl: '',      // 本地预览
    payCodeFileID: '',
    themeName: '',
    primary: '#C8161D',
    quickText: DEFAULT_QUICK.join(','),
    colors: PRESET_COLORS,
    saving: false,
    uploading: false
  },

  onLoad() {
    this.load();
  },

  async load() {
    try {
      const { account } = await req.accountGet();
      if (!account) return;
      this.setData({
        accountName: account.accountName,
        payCodeFileID: account.payCodeFileID,
        themeName: account.theme.name,
        primary: account.theme.primary,
        quickText: ((account.quickAmounts && account.quickAmounts.length) ? account.quickAmounts : DEFAULT_QUICK).join(',')
      });
      const url = await this.getTempUrl(account.payCodeFileID);
      this.setData({ payCodeUrl: url });
    } catch (e) { /* toast 已提示 */ }
  },

  getTempUrl(fileID) {
    return new Promise((resolve) => {
      wx.cloud.getTempFileURL({
        fileList: [fileID],
        success: res => resolve((res.fileList[0] && res.fileList[0].tempFileURL) || ''),
        fail: () => resolve('')
      });
    });
  },

  onNameInput(e) { this.setData({ accountName: e.detail.value }); },
  onQuickInput(e) { this.setData({ quickText: e.detail.value }); },
  onPickColor(e) { this.setData({ primary: e.currentTarget.dataset.c }); },

  /** 上传微信个人收款码图片（文档 §6.2） */
  onChoosePayCode() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: res => {
        const tempPath = res.tempFiles[0].tempFilePath;
        this.setData({ payCodeUrl: tempPath, uploading: true });
        wx.cloud.uploadFile({
          cloudPath: `paycodes/${getApp().globalData.openid}-${Date.now()}.png`,
          filePath: tempPath,
          success: up => this.setData({ payCodeFileID: up.fileID }),
          fail: () => {
            wx.showToast({ title: '上传失败', icon: 'none' });
            this.setData({ payCodeUrl: '', payCodeFileID: '' });
          },
          complete: () => this.setData({ uploading: false })
        });
      }
    });
  },

  async onSave() {
    if (this.data.saving) return;
    const name = (this.data.accountName || '').trim();
    if (!name) return wx.showToast({ title: '请填写主家称呼', icon: 'none' });
    if (this.data.uploading) return wx.showToast({ title: '收款码上传中，请稍候', icon: 'none' });
    if (!this.data.payCodeFileID) return wx.showToast({ title: '请上传微信收款码', icon: 'none' });
    const quickAmounts = String(this.data.quickText || '').split(/[,，\s]+/).map(Number).filter(n => n > 0);

    this.setData({ saving: true });
    try {
      const { account } = await req.accountSave({
        accountName: name,
        payCodeFileID: this.data.payCodeFileID,
        theme: { name: this.data.themeName || '我的礼簿', primary: this.data.primary },
        quickAmounts
      });
      getApp().globalData.account = account;
      wx.showToast({ title: '保存成功', icon: 'success' });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});
