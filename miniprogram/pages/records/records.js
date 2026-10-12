// pages/records/records.js — 账目列表 + 汇总 + 收款确认（UC5/UC8）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const printer = require('../../utils/printer.js');
const confirm = require('../../utils/confirm.js');

const PAGE_SIZE = 20;
const POLL_MS = 5000; // 页面停留时自动刷新待确认转账

const STATUS_TEXT = {
  pending: '待转账', transferred: '待确认', paid: '已到账', void: '已作废'
};

Page({
  data: {
    list: [],
    sum: '0.00',
    total: 0,
    pendingCount: 0,
    page: 1,
    hasMore: true,
    loading: false,
    filterDay: 'today',   // today | all
    keyword: '',
    busy: false
  },

  onShow() {
    this.reload();
    this._timer = setInterval(() => this.silentRefresh(), POLL_MS);
  },

  onHide() { this.clearTimer(); },
  onUnload() { this.clearTimer(); },

  clearTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  reload() {
    this.setData({ page: 1, list: [], hasMore: true });
    this.load();
  },

  /** 后台静默刷新首页数据（有新待确认转账时提醒） */
  async silentRefresh() {
    if (this.data.loading || this.data.busy) return;
    const before = this.data.pendingCount;
    try {
      const res = await req.recordList(this.buildParams(1));
      if (res.pendingCount > before) wx.vibrateShort({ type: 'heavy' });
      if (res.pendingCount !== before) getApp().setBadge(res.pendingCount);
      if (res.listTotal !== this.data.list.length || res.pendingCount !== before) {
        this.setData({
          list: res.list.map(decorate),
          sum: fmt.money(res.sum),
          total: res.total,
          pendingCount: res.pendingCount,
          page: 2,
          hasMore: res.list.length < res.listTotal
        });
      }
    } catch (e) { /* 静默 */ }
  },

  buildParams(page) {
    const params = { page, pageSize: PAGE_SIZE, keyword: this.data.keyword || undefined };
    if (this.data.filterDay === 'today') params.payDay = fmt.day(new Date());
    return params;
  },

  async load() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });
    try {
      const res = await req.recordList(this.buildParams(this.data.page));
      const list = this.data.list.concat(res.list.map(decorate));
      this.setData({
        list,
        sum: fmt.money(res.sum),
        total: res.total,
        pendingCount: res.pendingCount,
        page: this.data.page + 1,
        hasMore: list.length < res.listTotal
      });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  onReachBottom() { this.load(); },

  onFilterChange(e) {
    this.setData({ filterDay: e.currentTarget.dataset.v });
    this.reload();
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value });
    this.reload();
  },

  /** 确认收款：核对微信到账后点击 → 付款方页面显示成功 → 自动打印（需求 e） */
  async onConfirm(e) {
    const record = this.data.list[e.currentTarget.dataset.idx];
    this.setData({ busy: true });
    try {
      if (await confirm.confirmTransfer(record)) this.reload();
    } finally {
      this.setData({ busy: false });
    }
  },

  /** 未收到款 */
  async onReject(e) {
    const record = this.data.list[e.currentTarget.dataset.idx];
    if (await confirm.rejectTransfer(record)) this.reload();
  },

  goExport() { wx.navigateTo({ url: '/pages/export/export' }); },

  /** 手动打印 / 补打（UC8） */
  async onPrint(e) {
    if (this.data.busy) return;
    const idx = e.currentTarget.dataset.idx;
    const record = this.data.list[idx];
    this.setData({ busy: true });
    wx.showLoading({ title: '打印中' });
    try {
      await printer.printRecord(record);
      wx.hideLoading();
      wx.showToast({ title: '打印成功', icon: 'success' });
      this.setData({ [`list[${idx}].printed`]: true });
    } catch (err) {
      wx.hideLoading();
      wx.showModal({ title: '打印失败', content: err.message || '未知错误', showCancel: false });
    } finally {
      this.setData({ busy: false });
    }
  },

  /** 作废错误账目（文档 §8） */
  onVoid(e) {
    const idx = e.currentTarget.dataset.idx;
    const record = this.data.list[idx];
    wx.showModal({
      title: '作废账目',
      content: `确定作废 ${record.payerName} 的 ￥${record.amountStr} ？`,
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.payVoid(record._id);
          wx.showToast({ title: '已作废', icon: 'success' });
          this.reload();
        } catch (err) { /* toast 已提示 */ }
      }
    });
  }
});

function decorate(r) {
  return {
    ...r,
    amountStr: fmt.money(r.amount),
    timeStr: fmt.dateTime(r.createdAt),
    statusText: STATUS_TEXT[r.status] || r.status
  };
}
