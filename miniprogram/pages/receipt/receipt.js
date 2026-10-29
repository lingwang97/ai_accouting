// pages/receipt/receipt.js — 电子回执（宾客与主家均可查看、保存图片）
const req = require('../../utils/request.js');
const receipt = require('../../utils/receipt.js');
const rcptscene = require('../../utils/rcptscene.js');
const theme = require('../../utils/theme.js');

Page({
  data: {
    model: null,
    bookType: '', // 白事不展示广告、不展示推广
    isHost: false, // 主家 / 记账人自己查看时不展示"我家也要办事"
    errMsg: '',
    themeStyle: '', // 白事回执页用素灰主题；其余保持默认红（宾客端不套用自己的主家主题）
    saving: false,
    token: '',      // 小票二维码进入时的 token
    claim: '',      // open 可认领 / mine 已在我的记录 / taken 已被认领 / staff 主家或记账人
    claiming: false
  },

  async onLoad(options) {
    this.setData({ isHost: !!getApp().globalData.account });
    // 扫小票小程序码：参数在 options.scene（t=token，URL 编码）；兼容 ?t=token
    const token = rcptscene.tokenFromOptions(options);
    if (!options.rid && !token) return this.setData({ errMsg: options.scene ? '二维码无效' : '回执不存在' });
    // batch=1：入簿通知打开的批次回执（v3.69.1），整批合并显示；云端只对扫码登记这一批的宾客本人与主家 / 记账人放开，认领人仍只看自己那张
    this._opt = { rid: options.rid, token, batch: options.batch === '1' };
    await this.load();
  },

  async load() {
    const { rid, token, batch } = this._opt;
    const options = { rid };
    try {
      // 扫小票二维码（?t=token）：按 token 取这一笔；否则按记录 id（付款人 / 主家 / 认领人）
      const { record, accountName, tpl, claim } = token ? await req.receiptByToken(token, { silent: true }) : await req.receiptGet(options.rid, batch, { silent: true });
      // 扫码冷启动时 globalData.account 还没加载：主家 / 记账人以服务端判断（claim=staff）为准，不显示「我家也要办事」
      if (token) this.setData({ token, claim, isHost: this.data.isHost || claim === 'staff' });
      const model = receipt.buildModel(record, tpl, accountName);
      this.setData({ model, bookType: record.bookType || 'other' });
      if (record.bookType === 'funeral') {
        const t = theme.forType('funeral');
        this.setData({ themeStyle: theme.styleOf(t) });
        wx.setNavigationBarColor({ frontColor: '#ffffff', backgroundColor: t.primary, fail() {} });
      }
      this.setData({ model: await receipt.withAppCode(model) }); // 小程序码后补，不拖慢回执显示
    } catch (e) {
      // 网络失败可点此重试（v3.66.0）
      if (req.isNetErr(e)) this.setData({ errMsg: req.errText(e) + '，回执没加载出来', errNet: true });
      else this.setData({ errMsg: (e && e.biz && e.message) || '回执加载失败', errNet: false });
    }
  },
  onRetryLoad() {
    if (!this.data.errNet || this._reloading) return;
    this._reloading = true;
    this.setData({ errMsg: '', errNet: false });
    const done = () => { this._reloading = false; };
    this.load().then(done, done);
  },

  /** 宾客转化：我家也要办事收礼 → 首页（登录后创建礼簿） */
  goHostEntry() { wx.switchTab({ url: '/pages/index/index' }); },

  /** 放入我的随礼记录（礼台登记的记录，先到先得；主家可解除） */
  async onClaim() {
    if (this.data.claiming || !this.data.token) return;
    this.setData({ claiming: true });
    try {
      await req.claimReceipt(this.data.token);
      this.setData({ claim: 'mine' });
      wx.showToast({ title: '已放入', icon: 'success' });
    } catch (e) {
      // toast 已提示（如已被他人认领），刷新状态
      try { const r = await req.receiptByToken(this.data.token); this.setData({ claim: r.claim }); } catch (e2) { /* 忽略 */ }
    } finally {
      this.setData({ claiming: false });
    }
  },
  goMine() { wx.navigateTo({ url: '/pages/myreceipts/myreceipts' }); },

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
