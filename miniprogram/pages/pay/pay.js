// pages/pay/pay.js — 扫码付款页（付款方落地页）
// 步骤：form 填写 → transfer 扫收款码转账 → waiting 等待收款方确认 → success / failed
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');

const POLL_MS = 3000;
const POLL_MAX = 200; // 约 10 分钟

Page({
  data: {
    aid: '',
    account: null,
    loadErr: '',
    step: 'form',      // form | transfer | waiting | success | failed
    payerName: '',
    amount: '',
    remark: '',
    submitting: false,
    record: null,
    payCodeUrl: '',
    failReason: ''
  },

  onLoad(options) {
    let aid = options.aid || '';
    // 小程序码 scene 形如 aid=xxx
    if (!aid && options.scene) {
      const scene = decodeURIComponent(options.scene);
      const m = scene.match(/aid=([a-zA-Z0-9_-]+)/);
      if (m) aid = m[1];
    }
    if (!aid) {
      this.setData({ loadErr: '二维码无效，请联系收款方' });
      return;
    }
    this.setData({ aid });
    this.loadAccount(aid);
  },

  onUnload() {
    this.stopPoll();
  },

  onHide() {
    this.stopPoll();
  },

  onShow() {
    // 付款方去微信转账后返回本页，继续轮询
    if (this.data.step === 'waiting') this.startPoll();
  },

  async loadAccount(aid) {
    try {
      const { account } = await req.accountGetByAid(aid);
      this.setData({ account });
      wx.setNavigationBarTitle({ title: `向「${account.accountName}」付款` });
    } catch (e) {
      this.setData({ loadErr: '收款账户不存在或已失效' });
    }
  },

  onName(e) { this.setData({ payerName: e.detail.value }); },
  onAmount(e) { this.setData({ amount: e.detail.value }); },
  onRemark(e) { this.setData({ remark: e.detail.value }); },

  /** 第 1 步：确认转账 → 创建待转账记录，进入转账步骤 */
  async onConfirmTransfer() {
    if (this.data.submitting) return;
    const name = (this.data.payerName || '').trim();
    const amount = Number(this.data.amount);
    if (!name) return wx.showToast({ title: '请填写姓名', icon: 'none' });
    if (!Number.isFinite(amount) || amount <= 0) {
      return wx.showToast({ title: '请填写正确金额', icon: 'none' });
    }

    this.setData({ submitting: true });
    try {
      const { record } = await req.payCreate({
        aid: this.data.aid,
        payerName: name,
        amount,
        remark: this.data.remark
      });
      const payCodeUrl = record.payCodeFileID ? await this.getTempUrl(record.payCodeFileID) : '';
      this.setData({
        record: { ...record, amountStr: fmt.money(record.amount) },
        payCodeUrl,
        step: 'transfer'
      });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ submitting: false });
    }
  },

  /** 第 2 步：付款方转账完成 → 等待收款方确认 */
  async onTransferred() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await req.payTransferred(this.data.record._id);
      this.setData({ step: 'waiting' });
      this.startPoll();
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ submitting: false });
    }
  },

  /** 取消本次转账（尚未转账时） */
  onCancel() {
    wx.showModal({
      title: '取消转账',
      content: '确定取消本次转账吗？',
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.payCancel(this.data.record._id);
        } catch (e) { /* 忽略 */ }
        this.setData({ step: 'form', record: null, payCodeUrl: '' });
      }
    });
  },

  // —— 轮询收款方确认结果 ——
  startPoll() {
    this.stopPoll();
    this._pollCount = 0;
    this._timer = setInterval(() => this.poll(), POLL_MS);
    this.poll();
  },

  stopPoll() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  async poll() {
    if (!this.data.record) return;
    if (++this._pollCount > POLL_MAX) {
      this.stopPoll();
      return;
    }
    try {
      const { status } = await req.payStatus(this.data.record._id);
      if (status === 'paid') {
        this.stopPoll();
        wx.vibrateShort({ type: 'medium' });
        this.setData({ step: 'success' });
      } else if (status === 'rejected') {
        this.stopPoll();
        this.setData({ step: 'failed', failReason: '收款方未收到该笔转账，请与收款方核实' });
      }
    } catch (e) { /* 网络抖动，下次再试 */ }
  },

  /** 手动刷新（超时后） */
  onRefresh() {
    this.startPoll();
  },

  onRetry() {
    this.setData({ step: 'form', record: null, payCodeUrl: '', failReason: '' });
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

  /** 保存收款码到相册：长按无法识别时，用微信扫一扫从相册识别 */
  async onSavePayCode() {
    if (!this.data.payCodeUrl) return;
    wx.showLoading({ title: '保存中' });
    try {
      const dl = await new Promise((r, j) => wx.downloadFile({ url: this.data.payCodeUrl, success: r, fail: j }));
      await new Promise((r, j) => wx.saveImageToPhotosAlbum({ filePath: dl.tempFilePath, success: r, fail: j }));
      wx.hideLoading();
      wx.showModal({
        title: '已保存到相册',
        content: '请打开微信「扫一扫」，点右上角「相册」选择刚保存的收款码完成转账，转完回到本页点「我已完成转账」',
        showCancel: false
      });
    } catch (e) {
      wx.hideLoading();
      if (/auth|deny/i.test((e && e.errMsg) || '')) {
        wx.showModal({
          title: '需要相册权限',
          content: '请允许保存到相册',
          confirmText: '去设置',
          success: res => res.confirm && wx.openSetting()
        });
      } else {
        wx.showToast({ title: '保存失败，可截屏后扫码', icon: 'none' });
      }
    }
  },

  /** 预览收款码大图，长按可识别 */
  onPreviewPayCode() {
    if (this.data.payCodeUrl) {
      wx.previewImage({ urls: [this.data.payCodeUrl] });
    }
  }
});
