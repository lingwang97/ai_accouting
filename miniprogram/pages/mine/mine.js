// pages/mine/mine.js — 我的：收款方工作台（待确认、今日概览、收款设置）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const confirm = require('../../utils/confirm.js');
const notify = require('../../utils/notify.js');

const POLL_MS = 5000;
const LOGOUT_KEY = 'logged_out'; // 主动退出标记，login 页登录成功后清除

Page({
  data: {
    user: null,
    account: null,
    pending: [],
    todaySum: '0.00',
    todayCount: 0,
    printerName: '',
    loading: true
  },

  onShow() {
    this.refresh();
    this._timer = setInterval(() => this.refreshPending(true), POLL_MS);
  },
  onHide() { this.clearTimer(); },
  onUnload() { this.clearTimer(); },
  clearTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  async refresh() {
    const app = getApp();
    const saved = wx.getStorageSync('printerDevice');
    this.setData({ printerName: (saved && saved.name) || '' });
    try {
      // 恢复登录态（重启小程序后 globalData 为空）；主动退出过则不自动恢复
      if (!app.globalData.user && !wx.getStorageSync(LOGOUT_KEY)) {
        const { openid, user } = await req.loginCheck();
        app.globalData.openid = openid;
        app.globalData.user = user;
      }
      this.setData({ user: app.globalData.user });
      if (!app.globalData.user) {
        this.setData({ loading: false });
        return;
      }

      const { account } = await req.accountGet();
      app.globalData.account = account;
      app._accountChecked = true;
      this.setData({ account });
      if (account) {
        const res = await req.recordList({ page: 1, pageSize: 1, payDay: fmt.day(new Date()) });
        this.setData({ todaySum: fmt.money(res.sum), todayCount: res.total });
        await this.refreshPending(false);
      }
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  /** 刷新待确认列表与角标；silent=true 时有新转账才震动 */
  async refreshPending(silent) {
    if (!this.data.account) return;
    try {
      const { list } = await req.recordPending();
      if (silent && list.length > this.data.pending.length) wx.vibrateShort({ type: 'heavy' });
      this.setData({
        pending: list.map(r => ({ ...r, amountStr: fmt.money(r.amount), timeStr: fmt.time(r.transferredAt || r.createdAt) }))
      });
      getApp().setBadge(list.length);
    } catch (e) { /* 静默 */ }
  },

  async onConfirm(e) {
    const record = this.data.pending[e.currentTarget.dataset.idx];
    if (await confirm.confirmTransfer(record)) this.refresh();
  },

  async onReject(e) {
    const record = this.data.pending[e.currentTarget.dataset.idx];
    if (await confirm.rejectTransfer(record)) this.refreshPending(false);
  },

  /** 快捷改主题名（设置该次记账的主题） */
  onEditTheme() {
    const a = this.data.account;
    if (!a) return this.goAccount();
    wx.showModal({
      title: '本次记账主题',
      editable: true,
      placeholderText: '如：夜市摊 10月10日',
      success: async res => {
        if (!res.confirm) return;
        const name = (res.content || '').trim().slice(0, 20);
        if (!name) return;
        try {
          const { account } = await req.accountSave({
            accountName: a.accountName,
            payCodeFileID: a.payCodeFileID,
            theme: { ...a.theme, name }
          });
          getApp().globalData.account = account;
          this.setData({ account });
          wx.showToast({ title: '主题已更新', icon: 'success' });
        } catch (err) { /* toast 已提示 */ }
      }
    });
  },

  /** 开启新转账微信提醒（一次同意 = 一条提醒；勾选"总是保持"后确认收款时自动续订） */
  onSubscribe() { notify.subscribe(); },

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },
  goAccount() { wx.navigateTo({ url: '/pages/account/account' }); },
  goQrcode() { wx.navigateTo({ url: '/pages/qrcode/qrcode' }); },
  goPrinter() { wx.navigateTo({ url: '/pages/printer/printer' }); },
  goPrintset() { wx.navigateTo({ url: '/pages/printset/printset' }); },
  goExport() { wx.navigateTo({ url: '/pages/export/export' }); },
  goRecords() { wx.switchTab({ url: '/pages/records/records' }); },

  /** 收款方自己模拟付款方，单机联调用 */
  goTestPay() {
    wx.navigateTo({ url: `/pages/pay/pay?aid=${this.data.account._id}` });
  },

  onLogout() {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.account = null;
    app._accountChecked = false;
    app.setBadge(0);
    try { wx.setStorageSync(LOGOUT_KEY, true); } catch (e) { /* 忽略 */ }
    this.setData({ user: null, account: null, pending: [] });
  }
});
