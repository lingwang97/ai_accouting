// pages/account/account.js — 绑定收款账户 + 主题（UC2/UC4）
const req = require('../../utils/request.js');

const PRESET_COLORS = ['#07C160', '#2B7FFF', '#FA5151', '#FF9F1C', '#8A2BE2'];

Page({
  data: {
    accountName: '',
    payCodeUrl: '',      // 本地预览
    payCodeFileID: '',
    themeName: '默认主题',
    primary: '#07C160',
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
        primary: account.theme.primary
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
  onThemeInput(e) { this.setData({ themeName: e.detail.value }); },
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
    if (!name) return wx.showToast({ title: '请填写账户名称', icon: 'none' });
    if (!this.data.payCodeFileID) return wx.showToast({ title: '请上传收款码图片', icon: 'none' });

    this.setData({ saving: true });
    try {
      const { account } = await req.accountSave({
        accountName: name,
        payCodeFileID: this.data.payCodeFileID,
        theme: { name: this.data.themeName, primary: this.data.primary }
      });
      getApp().globalData.account = account;
      wx.showToast({ title: '保存成功', icon: 'success' });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});
