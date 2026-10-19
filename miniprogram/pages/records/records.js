// pages/records/records.js — 礼簿：礼金明细 + 合计 + 确认收到（按礼簿 / 今日 / 关键字筛选）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const receiptUtil = require('../../utils/receipt.js');
const printer = require('../../utils/printer.js');
const confirm = require('../../utils/confirm.js');
const theme = require('../../utils/theme.js');
const cache = require('../../utils/cache.js');
const perm = require('../../utils/perm.js');

const PAGE_SIZE = 20;
const POLL_MS = 5000; // 页面停留时自动刷新待确认转账

const STATUS_TEXT = {
  pending: '未转账', transferred: '待确认', paid: '已入簿', void: '已作废'
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
    filterDay: 'all',     // all 全部（默认）| today 今日
    keyword: '',
    books: [{ _id: '', name: '全部礼簿' }],
    bookIdx: 0,
    relations: ['全部关系', ...scenes.RELATIONS],
    relIdx: 0,
    loggedIn: true,
    readonly: false,  // 家人共享：只读
    pm: {},           // 当前身份的权限：确认 / 作废 / 打印 / 礼台记账按权限显示
    busy: false
  },

  async onShow() {
    this._hidden = false;
    theme.apply(this); // 主题色跟当前礼簿事由走
    const app = getApp();
    app.refreshTabBar();
    await app.loginReady;
    if (!app.globalData.user) {
      this.setData({ loggedIn: false, list: [] });
      return;
    }
    // 切换过身份：丢弃上一身份的礼簿与明细，重新加载
    if (this._idVer !== app.globalData.identityVer) {
      if (this._idVer !== undefined) {
        this._booksAt = 0;
        this._bookPicked = false;
        this.setData({ books: [{ _id: '', name: '全部礼簿' }], bookIdx: 0, list: [] });
      }
      this._idVer = app.globalData.identityVer;
    }
    // 冷启动时 role 为空：先读取身份，避免家人共享看到操作按钮
    const role = await app.ensureRole();
    this.setData({ loggedIn: true, readonly: role === 'viewer', pm: perm.current() });
    // 礼簿下拉：首次进入先用缓存，网络结果回来后再校正；之后每分钟最多重新拉一次
    let booksP = null;
    if (app.globalData.activeBookChanged) {
      // 在工作台 / 礼簿管理切换了当前礼簿：重新拉礼簿并选中新的当前礼簿（不保留之前的手动选择）
      app.globalData.activeBookChanged = false;
      this._bookPicked = false;
      if (this._booksAt) {
        await this.loadBooks();
        this.setData({ list: [] });
      }
    }
    if (!this._booksAt) {
      const cb = cache.get('books');
      if (cb) this.applyBooks(cb);
      booksP = this.loadBooks();
      if (!cb) await booksP;
    } else if (app.globalData.recordsBookId) {
      await this.loadBooks(); // 从礼簿统计页跳来：先选中指定礼簿
      this.setData({ list: [] });
    } else if (Date.now() - this._booksAt > 60 * 1000) {
      booksP = this.loadBooks();
    }
    const before = this.selectedBookId();
    this.refreshFirst();
    if (booksP) booksP.then(() => { if (this.selectedBookId() !== before) this.reload(); });
    this.clearTimer();
    if (this._hidden) return; // 加载期间已离开本页：不再启动轮询
    this._timer = setInterval(() => this.silentRefresh(), POLL_MS);
  },

  selectedBookId() {
    const b = this.data.books[this.data.bookIdx];
    return b ? b._id : '';
  },

  onHide() { this._hidden = true; this.clearTimer(); },
  onUnload() { this._hidden = true; this.clearTimer(); },

  clearTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  /** 筛选条件变化：清空后重新加载（有该条件的缓存时先显示缓存） */
  reload() {
    this._notified = false;
    this.setData({ page: 1, list: [], hasMore: true });
    this.refreshFirst();
  },

  /**
   * 刷新第一页：列表为空时先显示该筛选条件的缓存；网络结果回来后整体替换（不先清空，避免白屏闪烁）
   * 只缓存无关键字的查询
   */
  async refreshFirst() {
    const params = this.buildParams(1);
    const key = params.keyword ? '' : 'rec_' + JSON.stringify(params);
    if (key && !this.data.list.length) {
      const c = cache.get(key);
      if (c) this.applyFirst(c);
    }
    this.setData({ loading: true });
    try {
      const res = await req.recordList(params);
      if (JSON.stringify(this.buildParams(1)) !== JSON.stringify(params)) return; // 期间筛选已变
      this.applyFirst(res);
      if (key) cache.set(key, res);
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  applyFirst(res) {
    this._listTotal = res.listTotal;
    this.setData({
      list: res.list.map(decorate),
      sum: fmt.money(res.sum),
      total: res.total,
      pendingCount: res.pendingCount,
      page: 2,
      hasMore: res.list.length < res.listTotal
    });
  },

  /** 后台静默刷新首页数据（有新待确认转账时提醒） */
  async silentRefresh() {
    if (this.data.loading || this.data.busy || !this.data.loggedIn) return;
    const before = this.data.pendingCount;
    try {
      const res = await req.recordList(this.buildParams(1));
      if (res.pendingCount > before) wx.vibrateShort({ type: 'heavy' });
      if (res.pendingCount !== before) getApp().setBadge(res.pendingCount);
      // 合计与份数总是刷新
      this.setData({ sum: fmt.money(res.sum), total: res.total, pendingCount: res.pendingCount });
      const changed = res.listTotal !== this._listTotal || res.pendingCount !== before;
      if (!changed) return;
      if (this.data.page <= 2) {
        // 只看第一页时直接替换列表
        this._listTotal = res.listTotal;
        this.setData({ list: res.list.map(decorate), page: 2, hasMore: res.list.length < res.listTotal });
      } else if (!this._notified) {
        // 已翻到后面几页时不打断浏览，只提示
        this._notified = true;
        wx.showToast({ title: '有新的礼金，下拉刷新查看', icon: 'none' });
      }
    } catch (e) { /* 静默 */ }
  },

  /** 礼簿下拉：默认当前礼簿；从礼簿统计页跳来时选中指定礼簿 */
  async loadBooks() {
    const app = getApp();
    try {
      if (!app._accountChecked) {
        const { account } = await req.accountGet();
        app.globalData.account = account;
        app._accountChecked = true;
      }
      if (!app.globalData.account) return; // 宾客没有礼簿
      const res = await req.bookList();
      this._booksAt = Date.now();
      cache.set('books', res);
      this.applyBooks(res);
    } catch (e) { /* 未完善主家信息时不显示礼簿 */ }
  },

  applyBooks({ list, activeBookId }) {
    const app = getApp();
    // 机构模式：显示「本场主家 · 礼簿名」
    const books = [{ _id: '', name: '全部礼簿' }, ...list.map(b => ({ ...b, name: b.hostName ? `${b.hostName} · ${b.name}` : b.name }))];
    const pick = app.globalData.recordsBookId;
    app.globalData.recordsBookId = '';
    let want = activeBookId;
    if (pick) {
      want = pick;
      this._bookPicked = true;
    } else if (this._bookPicked) {
      want = this.data.books[this.data.bookIdx]._id; // 保留用户手动选择
    }
    this.setData({ books, bookIdx: Math.max(0, books.findIndex(b => b._id === want)) });
  },

  onBook(e) {
    this._bookPicked = true;
    this.setData({ bookIdx: Number(e.detail.value) });
    this.reload();
  },

  buildParams(page) {
    const params = { page, pageSize: PAGE_SIZE, keyword: this.data.keyword || undefined };
    const book = this.data.books[this.data.bookIdx];
    if (book && book._id) params.bookId = book._id;
    if (this.data.relIdx > 0) params.relation = this.data.relations[this.data.relIdx];
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
      this._listTotal = res.listTotal;
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  onReachBottom() { this.load(); },

  onPullDownRefresh() {
    this.reload();
    setTimeout(() => wx.stopPullDownRefresh(), 600);
  },

  onRelation(e) {
    this.setData({ relIdx: Number(e.detail.value) });
    this.reload();
  },

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
    // 批次录入：需整批核对，到待确认页处理
    if (record.batchId) return wx.navigateTo({ url: '/pages/pending/pending' });
    if (this.data.busy) return;
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
    if (record.batchId) return wx.navigateTo({ url: '/pages/pending/pending' });
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      if (await confirm.rejectTransfer(record)) this.reload();
    } finally {
      this.setData({ busy: false });
    }
  },

  /** 查看付款方留存收据 */
  onReceipt(e) { wx.navigateTo({ url: `/pages/receipt/receipt?rid=${e.currentTarget.dataset.id}` }); },

  goCash() { wx.navigateTo({ url: '/pages/cash/cash' }); },
  goBooks() { wx.navigateTo({ url: '/pages/books/books' }); },

  goLogin() { wx.switchTab({ url: '/pages/mine/mine' }); },

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
      title: '作废礼金记录',
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
    proxyStr: receiptUtil.proxyText(r),
    declaredStr: r.declaredAmount ? fmt.money(r.declaredAmount) : '',
    timeStr: fmt.dateTime(r.createdAt),
    statusText: STATUS_TEXT[r.status] || r.status
  };
}
