// pages/mine/mine.js — 我的：主家工作台（待确认礼金、今日收礼、礼簿与收礼设置）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const confirm = require('../../utils/confirm.js');
const receipt = require('../../utils/receipt.js');
const notify = require('../../utils/notify.js');

const { VERSION } = require('../../config.js');

const POLL_MS = 5000;
const PENDING_FOLD = 3; // 待确认礼金默认显示条数，超过折叠
const PAY_MODES = [
  { v: 'screen', label: '亮屏双码' },   // 主家出示屏幕，宾客扫码登记后用微信扫一扫转账
  { v: 'longpress', label: '宾客手机付款' } // 宾客保存收款码后用扫一扫从相册识别（原模式）
];
const LOGOUT_KEY = 'logged_out'; // 主动退出标记，login 页登录成功后清除

Page({
  data: {
    user: null,
    account: null,
    pending: [],
    todaySum: '0.00',
    todayCount: 0,
    printerName: '',
    payModeLabel: '',
    versionText: versionText(),
    PENDING_FOLD,
    pendingOpen: false,
    selectMode: false,
    pickedCount: 0,
    pickedSum: '0.00',
    activeBookName: '',
    loading: true
  },

  onShow() {
    getApp().refreshTabBar();
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
      this.setData({ account, payModeLabel: modeLabel(account) });
      if (account) {
        // 首次进入会自动用旧版主题名建一本默认礼簿
        req.bookList().then(({ list, activeBookId }) => {
          const b = list.find(x => x._id === activeBookId);
          this.setData({ activeBookName: b ? b.name : '' });
        }).catch(() => {});
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
      // 保留已勾选状态（轮询刷新不打断批量选择）
      const picked = new Set(this.data.pending.filter(r => r.picked).map(r => r._id));
      this.setData({
        pending: list.map(r => ({
          ...r,
          amountStr: fmt.money(r.amount),
          proxyStr: receipt.proxyText(r),
          timeStr: fmt.time(r.transferredAt || r.createdAt),
          picked: picked.has(r._id)
        }))
      });
      if (!list.length) this.setData({ selectMode: false });
      this.updatePicked();
      getApp().setBadge(list.length);
    } catch (e) { /* 静默 */ }
  },

  async onConfirm(e) {
    const record = this.data.pending[e.currentTarget.dataset.idx];
    if (await confirm.confirmTransfer(record)) this.refresh();
  },

  /** 展开 / 收起 */
  onToggleOpen() { this.setData({ pendingOpen: !this.data.pendingOpen }); },

  /** 进入 / 退出批量确认（进入时自动展开） */
  onToggleSelect() {
    const on = !this.data.selectMode;
    this.setData({
      selectMode: on,
      pendingOpen: on || this.data.pendingOpen,
      pending: this.data.pending.map(r => ({ ...r, picked: false }))
    });
    this.updatePicked();
  },

  onPick(e) {
    if (!this.data.selectMode) return;
    const i = e.currentTarget.dataset.idx;
    this.setData({ [`pending[${i}].picked`]: !this.data.pending[i].picked });
    this.updatePicked();
  },

  onPickAll() {
    const all = this.data.pickedCount !== this.data.pending.length;
    this.setData({ pending: this.data.pending.map(r => ({ ...r, picked: all })) });
    this.updatePicked();
  },

  updatePicked() {
    const picked = this.data.pending.filter(r => r.picked);
    const fen = picked.reduce((s, r) => s + Math.round(r.amount * 100), 0);
    this.setData({ pickedCount: picked.length, pickedSum: fmt.money(fen / 100) });
  },

  async onConfirmPicked() {
    const picked = this.data.pending.filter(r => r.picked);
    if (!picked.length) return;
    if (await confirm.confirmBatch(picked)) {
      this.setData({ selectMode: false });
      this.refresh();
    }
  },

  async onReject(e) {
    const record = this.data.pending[e.currentTarget.dataset.idx];
    if (await confirm.rejectTransfer(record)) this.refreshPending(false);
  },

  /** 切换收款模式（新旧两种工作模式） */
  onSwitchMode() {
    const a = this.data.account;
    if (!a) return this.goAccount();
    wx.showActionSheet({
      itemList: PAY_MODES.map(m => (m.v === (a.payMode || 'longpress') ? '✓ ' : '') + m.label),
      success: async res => {
        const mode = PAY_MODES[res.tapIndex];
        if (mode.v === (a.payMode || 'longpress')) return;
        try {
          const { account } = await req.accountSave({
            accountName: a.accountName,
            payCodeFileID: a.payCodeFileID,
            theme: a.theme,
            payMode: mode.v
          });
          getApp().globalData.account = account;
          this.setData({ account, payModeLabel: modeLabel(account) });
          wx.showToast({ title: '已切换为' + mode.label, icon: 'none' });
        } catch (err) { /* toast 已提示 */ }
      }
    });
  },

  goBooks() { wx.navigateTo({ url: '/pages/books/books' }); },

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },
  goAccount() { wx.navigateTo({ url: '/pages/account/account' }); },
  goQrcode() { wx.navigateTo({ url: '/pages/qrcode/qrcode' }); },
  goPrinter() { wx.navigateTo({ url: '/pages/printer/printer' }); },
  goPrintset() { wx.navigateTo({ url: '/pages/printset/printset' }); },
  goReceiptset() { wx.navigateTo({ url: '/pages/receiptset/receiptset' }); },
  goExport() { wx.navigateTo({ url: '/pages/export/export' }); },
  goRecords() { wx.switchTab({ url: '/pages/records/records' }); },

  /** 收款方自己模拟付款方，单机联调用 */
  goTestPay() {
    wx.navigateTo({ url: `/pages/pay/pay?aid=${this.data.account._id}` });
  },

  /** 隐私与数据：查看说明 / 清除我的全部数据（注销） */
  onPrivacy() {
    wx.showActionSheet({
      itemList: ['隐私说明', '清除我的全部数据'],
      success: res => {
        if (res.tapIndex === 0) {
          wx.showModal({
            title: '隐私说明',
            content: '慧礼记仅保存你登记的礼簿、礼金、送礼记录和收款码图片，用于记账、回执与导出；数据存于微信云开发，仅你本人可见。宾客的姓名、礼金仅对主家和宾客本人可见。导出文件下载后即从云端删除。你可随时在此清除全部数据。',
            showCancel: false
          });
        } else {
          this.confirmPurge();
        }
      }
    });
  },

  confirmPurge() {
    wx.showModal({
      title: '清除全部数据',
      content: '将永久删除你的所有礼簿、礼金记录、送礼记录、模板、存档文件和主家信息，无法恢复。建议先在「导出礼簿」里做一次备份。如确认，请输入"清除"',
      editable: true,
      placeholderText: '输入：清除',
      confirmColor: '#FA5151',
      success: async res => {
        if (!res.confirm) return;
        if ((res.content || '').trim() !== '清除') {
          return wx.showToast({ title: '输入不正确，已取消', icon: 'none' });
        }
        wx.showLoading({ title: '正在清除…', mask: true });
        try {
          await req.exportPurge();
          await req.purgeAccount();
          wx.hideLoading();
          try {
            wx.removeStorageSync('db_inited');
            (wx.getStorageInfoSync().keys || []).filter(k => k.indexOf('qr_') === 0).forEach(k => wx.removeStorageSync(k));
          } catch (e) { /* 忽略 */ }
          wx.showModal({ title: '已清除', content: '你的数据已全部删除', showCancel: false });
          this.onLogout();
        } catch (e) {
          wx.hideLoading(); // request.js 已提示
        }
      }
    });
  },

  onLogout() {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.account = null;
    app._accountChecked = false;
    app.setBadge(0); // 同时刷新底部菜单，隐藏「礼簿」
    try { wx.setStorageSync(LOGOUT_KEY, true); } catch (e) { /* 忽略 */ }
    this.setData({ user: null, account: null, pending: [] });
  }
});

function modeLabel(a) {
  const m = PAY_MODES.find(x => x.v === ((a && a.payMode) || 'longpress'));
  return m ? m.label : '';
}

/** 版本号；开发版 / 体验版附加标识，便于测试时区分 */
function versionText() {
  let env = 'release';
  try { env = wx.getAccountInfoSync().miniProgram.envVersion; } catch (e) { /* 默认正式版 */ }
  const tag = { develop: ' 开发版', trial: ' 体验版' }[env] || '';
  return `慧礼记 v${VERSION}${tag}`;
}
