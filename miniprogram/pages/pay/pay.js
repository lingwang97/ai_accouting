// pages/pay/pay.js — 扫码随礼页（宾客落地页）
// 步骤：form 登记 → transfer 向主家收款码转账 → waiting 等待主家确认 → success（显示回执）/ failed
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const receipt = require('../../utils/receipt.js');
const scenes = require('../../utils/scenes.js');

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
    relation: '',
    proxyItems: [{ name: '', amount: '' }], // 代随礼：每人姓名 + 金额（选填）
    showProxy: false,
    relations: scenes.RELATIONS,
    isFuneral: false,
    submitting: false,
    record: null,
    payCodeUrl: '',
    failReason: '',
    showFallback: false, // 亮屏模式下：在本机显示收款码（备用）
    codeSaved: false,    // 宾客手机付款：收款码是否已存入相册
    receiptModel: null,  // 到账后的留存收据
    savingReceipt: false
  },

  onLoad(options) {
    let aid = options.aid || '';
    // 小程序码 scene 即 aid（兼容旧版 aid=xxx 格式）
    if (!aid && options.scene) {
      const scene = decodeURIComponent(options.scene);
      const m = scene.match(/^(?:aid=)?([a-zA-Z0-9_-]{1,32})$/);
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
      this.setData({ account, isFuneral: !!(account.book && account.book.type === 'funeral') });
      wx.setNavigationBarTitle({ title: `向「${account.accountName}」随礼` });
    } catch (e) {
      this.setData({ loadErr: '礼簿码无效或主家已停用' });
    }
  },

  onName(e) { this.setData({ payerName: e.detail.value }); },
  onAmount(e) { this.setData({ amount: e.detail.value }); },
  onRemark(e) { this.setData({ remark: e.detail.value }); },
  onProxyInput(e) {
    const { i, k } = e.currentTarget.dataset;
    this.setData({ [`proxyItems[${i}].${k}`]: e.detail.value });
  },
  onProxyAdd() { this.setData({ proxyItems: this.data.proxyItems.concat({ name: '', amount: '' }) }); },
  onProxyDel(e) {
    const items = this.data.proxyItems.filter((x, i) => i !== Number(e.currentTarget.dataset.i));
    this.setData({ proxyItems: items.length ? items : [{ name: '', amount: '' }] });
  },
  onQuick(e) { this.setData({ amount: String(e.currentTarget.dataset.v) }); },
  onRelation(e) {
    const r = e.currentTarget.dataset.r;
    this.setData({ relation: this.data.relation === r ? '' : r });
  },
  onToggleProxy() { this.setData({ showProxy: !this.data.showProxy }); },

  /** 第 1 步：确认转账 → 创建待转账记录，进入转账步骤 */
  async onConfirmTransfer() {
    if (this.data.submitting) return;
    const name = (this.data.payerName || '').trim();
    const amount = Number(this.data.amount);
    if (!name) return wx.showToast({ title: '请填写随礼人姓名', icon: 'none' });
    if (!Number.isFinite(amount) || amount <= 0) {
      return wx.showToast({ title: '请选择或填写礼金', icon: 'none' });
    }

    const proxyItems = [];
    if (this.data.showProxy) {
      for (const p of this.data.proxyItems) {
        const pName = (p.name || '').trim();
        const raw = String(p.amount || '').trim();
        if (!pName && !raw) continue; // 空行忽略
        if (!pName) return wx.showToast({ title: '请填写被代随礼人姓名', icon: 'none' });
        if (raw && !(Number(raw) > 0)) return wx.showToast({ title: `${pName} 的金额不正确`, icon: 'none' });
        if (pName === name) return wx.showToast({ title: '被代随礼人不能是自己', icon: 'none' });
        if (proxyItems.some(x => x.name === pName)) return wx.showToast({ title: `${pName} 重复填写`, icon: 'none' });
        proxyItems.push({ name: pName, amount: raw ? Math.round(Number(raw) * 100) / 100 : null });
      }
    }
    const proxyFen = proxyItems.reduce((s, p) => s + Math.round((p.amount || 0) * 100), 0);
    if (proxyFen > Math.round(amount * 100)) {
      return wx.showToast({ title: '代随礼金额之和超过礼金总额', icon: 'none' });
    }

    this.setData({ submitting: true });
    try {
      const { record } = await req.payCreate({
        aid: this.data.aid,
        payerName: name,
        amount,
        remark: this.data.remark,
        relation: this.data.relation,
        proxyItems
      });
      const payCodeUrl = record.payCodeFileID ? await this.getTempUrl(record.payCodeFileID) : '';
      this.setData({
        record: { ...record, amountStr: fmt.money(record.amount), proxyStr: receipt.proxyText(record) },
        payCodeUrl,
        showFallback: false,
        'account.payMode': record.payMode || this.data.account.payMode,
        codeSaved: false,
        step: 'transfer'
      });
      // 宾客手机付款：自动把收款码存入相册并弹出引导，省去手动保存
      const mode = record.payMode || this.data.account.payMode;
      if (mode !== 'screen' && payCodeUrl && (await this.savePayCode(true))) this.showScanGuide();
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ submitting: false });
    }
  },

  onToggleFallback() {
    this.setData({ showFallback: !this.data.showFallback });
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
      title: '取消随礼',
      content: '确定取消本次随礼吗？',
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
        this.loadReceipt();
      } else if (status === 'rejected') {
        this.stopPoll();
        this.setData({ step: 'failed', failReason: '主家未收到该笔转账，请与主家核实' });
      }
    } catch (e) { /* 网络抖动，下次再试 */ }
  },

  /** 收款方确认后加载留存收据（失败时退回简单成功页） */
  async loadReceipt() {
    try {
      const { record, accountName, tpl } = await req.receiptGet(this.data.record._id);
      this.setData({ receiptModel: receipt.buildModel(record, tpl, accountName) });
    } catch (e) { /* 保留简单成功页 */ }
  },

  async onSaveReceipt() {
    if (this.data.savingReceipt || !this.data.receiptModel) return;
    this.setData({ savingReceipt: true });
    try {
      const path = await receipt.toImage('#receiptCanvas', this.data.receiptModel);
      await receipt.saveImage(path);
    } catch (e) {
      wx.showToast({ title: '生成图片失败，可截屏留存', icon: 'none' });
    } finally {
      this.setData({ savingReceipt: false });
    }
  },

  /** 手动刷新（超时后） */
  onRefresh() {
    this.startPoll();
  },

  onRetry() {
    this.setData({ step: 'form', record: null, payCodeUrl: '', failReason: '', receiptModel: null });
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

  /** 保存收款码到相册（手动重新保存） */
  async onSavePayCode() {
    if (await this.savePayCode(true)) this.showScanGuide();
  },

  /** 下载并保存收款码；返回是否成功（失败已提示） */
  async savePayCode(loading) {
    if (!this.data.payCodeUrl) return false;
    if (loading) wx.showLoading({ title: '保存中' });
    try {
      const dl = await new Promise((r, j) => wx.downloadFile({ url: this.data.payCodeUrl, success: r, fail: j }));
      await new Promise((r, j) => wx.saveImageToPhotosAlbum({ filePath: dl.tempFilePath, success: r, fail: j }));
      if (loading) wx.hideLoading();
      this.setData({ codeSaved: true });
      return true;
    } catch (e) {
      if (loading) wx.hideLoading();
      if (/auth|deny/i.test((e && e.errMsg) || '')) {
        wx.showModal({
          title: '需要相册权限',
          content: '收款码要先保存到相册，才能用微信扫一扫识别。请允许保存到相册',
          confirmText: '去设置',
          success: res => res.confirm && wx.openSetting()
        });
      } else {
        wx.showToast({ title: '保存失败，可截屏后扫码', icon: 'none' });
      }
      return false;
    }
  },

  /** 保存成功后的转账引导 */
  showScanGuide() {
    wx.showModal({
      title: '收款码已存入相册',
      content: `① 退回微信，点右上角「＋」→「扫一扫」\n② 点右上角「相册」，选第一张图（刚保存的收款码）\n③ 转账 ￥${this.data.record.amountStr}，再回到这里点「我已完成转账」`,
      confirmText: '去转账',
      showCancel: false
    });
  },

  /** 预览收款码大图（可在大图里长按保存） */
  onPreviewPayCode() {
    if (this.data.payCodeUrl) {
      wx.previewImage({ urls: [this.data.payCodeUrl], showmenu: true });
    }
  }
});
