// pages/account/account.js — 主家信息：称呼、微信收款码、快捷礼金（主题色在「我的 → 外观设置」）
// 没有「修改主家信息」权限的记账人：只能申请更换收款码（codeOnly），主家确认后生效
const req = require('../../utils/request.js');
const theme = require('../../utils/theme.js');

const PRESET_COLORS = ['#C8161D', '#07C160', '#B8860B', '#2B7FFF', '#333333'];
const DEFAULT_QUICK = [100, 200, 300, 500, 600, 800, 1000, 1500, 2000];

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
    uploading: false,
    codeOnly: false,     // 没有「修改主家信息」权限：只能申请更换收款码
    reviews: [],         // 主家：记账人提交、待确认的收款码
    pendingNote: false   // 记账人：已提交的新收款码待主家确认
  },

  onShow() {
    theme.apply(this); // 主题色跟当前礼簿事由走
  },

  onLoad(options) {
    // own=1：记账人新建自己的主家信息（不修改正在记账的主家）
    this._own = options.own === '1';
    if (this._own) wx.setNavigationBarTitle({ title: '新建我自己的礼簿' });
    this.load();
  },

  async load() {
    try {
      if (this._own) return; // 新建：空白表单
      const { account, role, perms } = await req.accountGet(true);
      if (!account) return;
      this._role = role;
      // 没有「修改主家信息」权限（只有申请更换收款码）：只能提交新收款码
      const codeOnly = role !== 'owner' && !(perms || []).includes('info');
      this.setData({ codeOnly });
      if (codeOnly) wx.setNavigationBarTitle({ title: '申请更换收款码' });
      this.setData({ pendingNote: role !== 'owner' && !!account.hasPendingPayCode });
      if (role === 'owner' && account.payCodeCheck) this.loadReviews();
      this._saved = account; // 已保存的主家信息（开关即时保存时使用）
      this.setData({
        accountName: account.accountName,
        payCodeFileID: account.payCodeFileID,
        themeName: account.theme.name,
        primary: account.theme.chosen ? account.theme.primary : '#C8161D',
        quickText: (Array.isArray(account.quickAmounts) ? account.quickAmounts : DEFAULT_QUICK).join(',')
      });
      // 记账人读不到主家上传的图片，优先用云函数生成的链接
      const url = account.payCodeUrl || await this.getTempUrl(account.payCodeFileID);
      this.setData({ payCodeUrl: url });
    } catch (e) { /* toast 已提示 */ }
  },

  /** 主家：记账人提交的收款码（主家信息 / 本场收款码），核对后采用或驳回 */
  async loadReviews() {
    try {
      const { list } = await req.payCodeReviews();
      this.setData({ reviews: list || [] });
    } catch (e) { /* toast 已提示 */ }
  },

  onDecide(e) {
    const { idx, ok } = e.currentTarget.dataset;
    const r = this.data.reviews[idx];
    if (!r) return;
    wx.showModal({
      title: ok ? '采用新收款码' : '驳回',
      content: ok ? `确认这是你本人的微信收款码？采用后宾客随礼将转到这个收款码（${r.name}）。` : '驳回后继续使用原收款码。',
      confirmText: ok ? '采用' : '驳回',
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.payCodeDecide(r.target, ok, r.ver); // 带上版本：核对期间被换成另一张时服务端拒绝
          wx.showToast({ title: ok ? '已采用' : '已驳回', icon: 'success' });
          require('../../utils/cache.js').set('dashboard', null);
          this.load();
          this.setData({ reviews: this.data.reviews.filter((x, i) => i !== idx) });
        } catch (err) { this.loadReviews(); /* 已更换等：刷新列表重新核对 */ }
      }
    });
  },

  onPreview(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.previewImage({ urls: [url] });
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
  /** 清空重填：清掉页面上的内容，填好后点「保存」生效（未保存前不影响已有信息） */
  onClearForm() {
    wx.showModal({
      title: '清空重填',
      content: '清空主家称呼、收款码和快捷礼金后重新填写，点「保存」后才生效。',
      confirmText: '清空',
      success: res => {
        if (!res.confirm) return;
        this.setData({ accountName: '', payCodeUrl: '', payCodeFileID: '', quickText: '', primary: PRESET_COLORS[0] });
      }
    });
  },
  onClearQuick() { this.setData({ quickText: '' }); },
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
      },
      fail: err => {
        if (String((err && err.errMsg) || '').includes('cancel')) return; // 用户取消
        wx.showToast({ title: '无法选择图片', icon: 'none' });
      }
    });
  },

  async onSave() {
    if (this.data.saving) return;
    const name = (this.data.accountName || '').trim();
    if (!name) return wx.showToast({ title: '请填写主家称呼', icon: 'none' });
    if (this.data.uploading) return wx.showToast({ title: '收款码上传中，请稍候', icon: 'none' });
    if (!this.data.payCodeFileID) return wx.showToast({ title: '请上传微信收款码', icon: 'none' });
    if (this.data.codeOnly && this._saved && this.data.payCodeFileID === this._saved.payCodeFileID) return wx.showToast({ title: '请先上传新的收款码', icon: 'none' });
    const quickAmounts = String(this.data.quickText || '').split(/[,，\s]+/).map(Number).filter(n => n > 0);

    this.setData({ saving: true });
    try {
      const { account, pendingPayCode } = await req.accountSave({
        accountName: name,
        payCodeFileID: this.data.payCodeFileID,
        // 新建主家信息时带上默认主题，之后在「外观设置」修改
        ...(this._own || !this._saved ? { theme: { name: this.data.themeName || '我的礼簿', primary: this.data.primary } } : {}),
        quickAmounts,
        confirmPayCode: true, // 主家在本页核对后保存：解除收款码提醒
        own: this._own || undefined
      });
      if (this._own) {
        getApp().resetIdentity(); // 已切换到自己的身份
        this._own = false;
      }
      this._saved = account;
      getApp().globalData.account = account;
      theme.setAccount(account); // 主题色立即生效
      theme.apply(this);
      if (pendingPayCode) {
        this.setData({ pendingNote: true });
        wx.showModal({ title: '已提交主家确认', content: '新收款码待主家确认后生效', showCancel: false });
      } else {
        wx.showToast({ title: '保存成功', icon: 'success' });
      }
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});
