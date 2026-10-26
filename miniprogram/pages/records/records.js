// pages/records/records.js — 礼簿：礼金明细 + 合计 + 确认收到（按礼簿 / 今日 / 关键字筛选）
const req = require('../../utils/request.js');
const { groupRecords } = require('../../utils/group.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const printer = require('../../utils/printer.js');
const confirm = require('../../utils/confirm.js');
const theme = require('../../utils/theme.js');
const cache = require('../../utils/cache.js');
const perm = require('../../utils/perm.js');
const { REC } = require('../../utils/status.js');
const samename = require('../../utils/samename.js');
const poller = require('../../utils/poller.js');
const pollcfg = require('../../utils/pollcfg.js');
const fresh = require('../../utils/fresh.js');

const PAGE_SIZE = 20;
const SORT_KEYS = ['time_desc', 'time_asc', 'amount_desc', 'amount_asc', 'name', 'dup'];
const ST_KEYS = ['all', 'confirm', 'paid'];
const POLL_MS = 10000; // 页面停留时自动刷新待确认转账

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
    keyword: '',
    books: [{ _id: '', name: '全部礼簿' }],
    bookIdx: 0,
    relations: ['全部关系', ...scenes.RELATIONS],
    relIdx: 0,
    sorts: ['最新', '最早', '金额高→低', '金额低→高', '按姓名', '只看重名'],
    sortIdx: 0,
    statuses: ['全部', '待确认', '已入簿'],
    stIdx: 0,
    loggedIn: true,
    readonly: false,  // 家人共享：只读
    pm: {},           // 当前身份的权限：确认 / 作废 / 打印 / 礼台记账按权限显示
    curBook: null,    // 当前礼簿 id（服务端返回）：只有这一本的待确认可直接确认；null 表示未知
    unit: '礼簿',      // 机构模式称「场次」
    busy: false,
    showTop: false,   // 回到顶部按钮
    amend: null,      // 修改已入簿礼金的弹层：{ rid, name, amount, relIdx, remark, orig }
    amendRels: ['不选', ...scenes.RELATIONS]
  },

  async onShow() {
    this._hidden = false;
    const app = getApp();
    // 已退出登录：立即清空上一个账户的礼簿（不等登录状态恢复）
    if (app.isLoggedOut()) {
      this._booksAt = 0;
      this._bookPicked = false;
      this.setData({ loggedIn: false, list: [], books: [{ _id: '', name: '全部礼簿' }], bookIdx: 0 });
      app.refreshTabBar();
      return;
    }
    theme.apply(this); // 主题色跟当前礼簿事由走
    app.refreshTabBar();
    await app.loginReady;
    const acc = app.globalData.account;
    this.setData({ unit: acc && acc.orgMode ? '场次' : '礼簿' });
    if (!app.globalData.user) {
      this.setData({ loggedIn: false, list: [], books: [{ _id: '', name: '全部礼簿' }], bookIdx: 0 });
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
    const pm = perm.current();
    pm.tag = pm.desk || pm.confirm; // 设区分备注
    pm.amend = pm.confirm || pm.void; // 修改已入簿礼金（与服务端 payment.amend 一致）
    this.setData({ loggedIn: true, readonly: role === 'viewer', isOwner: role === 'owner', pm });
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
    // 切回页面：45 秒内且期间没有写操作（修改 / 撤销未收到 / 确认等都会记写操作）、列表非空时不重拉第一页，轮询仍会更新合计；
    // 礼簿被切换 / 换身份 / 从统计页跳来时列表已清空，必然刷新
    if (fresh.needs(this) || !this.data.list.length || booksP) this.refreshFirst();
    if (booksP) booksP.then(() => { if (this.selectedBookId() !== before) this.reload(); });
    this.clearTimer();
    if (this._hidden) return; // 加载期间已离开本页：不再启动轮询
    const fast = pollcfg.ms(); // 高级功能：待确认刷新频率；设置变了就重建轮询
    if (!this._poller || this._pollFast !== fast) { this._pollFast = fast; this._poller = poller.create(() => this.silentRefresh(), { base: POLL_MS, fast, hold: pollcfg.peakOn }); }
    this._poller.start();
  },

  selectedBookId() {
    const b = this.data.books[this.data.bookIdx];
    return b ? b._id : '';
  },

  onHide() { this._hidden = true; this.clearTimer(); },
  onUnload() { this._hidden = true; this.clearTimer(); },

  clearTimer() {
    if (this._poller) this._poller.stop();
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
    if (this._poller) this._poller.kick(); // 用户操作 / 刷新后恢复轮询频率
    const params = this.buildParams(1);
    const key = params.keyword ? '' : 'rec_' + JSON.stringify(params);
    if (key && !this.data.list.length) {
      const c = cache.get(key);
      if (c) this.applyFirst(c);
    }
    this.setData({ loading: true });
    const at = Date.now();
    try {
      const res = await req.recordList(params);
      if (JSON.stringify(this.buildParams(1)) !== JSON.stringify(params)) return; // 期间筛选已变
      this.applyFirst(res);
      fresh.mark(this, at);
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
      curBook: res.workBookId === undefined ? null : res.workBookId,
      dupTruncated: !!res.dupTruncated,
      page: 2,
      hasMore: res.list.length < res.listTotal
    });
  },

  /** 后台静默刷新首页数据（有新待确认转账时提醒） */
  async silentRefresh() {
    if (this.data.loading || this.data.busy || !this.data.loggedIn) return false;
    const before = this.data.pendingCount;
    // 先只查合计与计数（不取列表行）；列表条数 / 待确认数变化才拉第一页
    const res = await req.recordList({ ...this.buildParams(1), statOnly: true });
    if (res.pendingCount > before) wx.vibrateShort({ type: 'heavy', fail() {} });
    // 角标统一按当前礼簿的待确认（工作台 / 待确认页设置），这里按筛选礼簿计数，不改角标
    // 合计与份数及时更新；值没变就不 setData
    const curBook = res.workBookId === undefined ? null : res.workBookId;
    const sum = fmt.money(res.sum);
    const d = this.data;
    const statChanged = sum !== d.sum || res.total !== d.total || res.pendingCount !== before || curBook !== d.curBook;
    if (statChanged) this.setData({ sum, total: res.total, pendingCount: res.pendingCount, curBook });
    const changed = res.listTotal !== this._listTotal || res.pendingCount !== before;
    if (!changed) return statChanged;
    if (this.data.page <= 2) {
      // 只看第一页时直接替换列表
      const full = await req.recordList(this.buildParams(1));
      if (this._hidden) return true;
      this._listTotal = full.listTotal;
      this.setData({ list: full.list.map(decorate), page: 2, hasMore: full.list.length < full.listTotal });
    } else if (!this._notified) {
      // 已翻到后面几页时不打断浏览，只提示
      this._notified = true;
      wx.showToast({ title: '有新的礼金，下拉刷新查看', icon: 'none' });
    }
    return true;
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
    if (this.data.sortIdx > 0) params.sort = SORT_KEYS[this.data.sortIdx];
    if (this.data.stIdx > 0) params.status = ST_KEYS[this.data.stIdx];
    return params;
  },

  async load() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });
    try {
      const res = await req.recordList(this.buildParams(this.data.page));
      // 加载更多：按下标追加，不重传整张列表
      const start = this.data.list.length;
      const more = res.list.map(decorate);
      const patch = {
        sum: fmt.money(res.sum),
        total: res.total,
        pendingCount: res.pendingCount,
        page: this.data.page + 1,
        hasMore: start + more.length < res.listTotal
      };
      more.forEach((item, i) => { patch[`list[${start + i}]`] = item; });
      this.setData(patch);
      this._listTotal = res.listTotal;
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  onReachBottom() { this.load(); },

  /** 滚过约两屏才显示「回到顶部」；只在跨过阈值时 setData，滚动中不频繁更新 */
  onPageScroll(e) {
    const show = e.scrollTop > 1200;
    if (show !== !!this._topShown) { this._topShown = show; this.setData({ showTop: show }); }
  },
  onTop() { wx.pageScrollTo({ scrollTop: 0, duration: 200 }); },

  onPullDownRefresh() {
    this.reload();
    setTimeout(() => wx.stopPullDownRefresh(), 600);
  },

  onSort(e) {
    this.setData({ sortIdx: Number(e.detail.value) });
    this.reload();
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  onStatus(e) {
    const i = Number(e.currentTarget.dataset.i);
    if (i === this.data.stIdx) return;
    this.setData({ stIdx: i });
    this.reload();
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  onRelation(e) {
    this.setData({ relIdx: Number(e.detail.value) });
    this.reload();
  },

  /** 输入框被清空（含点 ×）：不用再点搜索，直接恢复完整列表 */
  onSearchInput(e) {
    this._kw = e.detail.value;
    if (!e.detail.value && this.data.keyword) {
      this.setData({ keyword: '' });
      this.reload();
    }
  },

  onSearch(e) {
    // 键盘确认带 detail.value；点「搜索」按钮没有，取输入框最近输入的内容
    const v = e && e.detail && typeof e.detail.value === 'string' ? e.detail.value : (this._kw || '');
    this._kw = v;
    wx.hideKeyboard({ fail() {} });
    this.setData({ keyword: v });
    this.reload();
  },

  /** 确认收款：核对微信到账后点击 → 付款方页面显示成功 → 自动打印（需求 e） */
  async onConfirm(e) {
    const record = this.data.list[e.currentTarget.dataset.idx];
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      // 批次录入：就地弹窗整批核对（列出这一批所有人和金额），不再跳到待确认页
      const target = record.batchId ? await this.batchOf(record) : record;
      if (!target) return;
      const res = await confirm.confirmTransfer(target);
      if (res === 'edit') {
        // 批次金额不一致：逐人改金额在待确认页的批次明细里
        wx.showToast({ title: '请在待确认页逐人修改金额', icon: 'none' });
        return setTimeout(() => wx.navigateTo({ url: '/pages/pending/pending' }), 800);
      }
      if (res) this.reload();
    } finally {
      this.setData({ busy: false });
    }
  },

  /** 取这一批的全部待确认记录并分组；已处理时提示刷新 */
  async batchOf(record) {
    try {
      const { list } = await req.recordPending();
      const g = groupRecords(list.filter(r => r.batchId === record.batchId))[0];
      if (!g) { wx.showToast({ title: '这一批已处理，请刷新', icon: 'none' }); this.reload(); }
      return g || null;
    } catch (err) { return null; }
  },

  /** 未收到款 */
  async onReject(e) {
    const record = this.data.list[e.currentTarget.dataset.idx];
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const target = record.batchId ? await this.batchOf(record) : record; // 批次整批标记
      if (target && await confirm.rejectTransfer(target)) this.reload();
    } finally {
      this.setData({ busy: false });
    }
  },

  /** 查看付款方留存收据 */
  onReceipt(e) { wx.navigateTo({ url: `/pages/receipt/receipt?rid=${e.currentTarget.dataset.id}` }); },

  goLogin() { wx.switchTab({ url: '/pages/mine/mine' }); },

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

  /** 「更多」：区分备注 / 作废（按权限显示，最多 2 项） */
  onMore(e) {
    const idx = e.currentTarget.dataset.idx;
    const pm = this.data.pm;
    const items = [];
    if (pm.tag) items.push(['区分备注', () => this.onNameTag({ currentTarget: { dataset: { idx } } })]);
    if (pm.void) items.push(['作废', () => this.onVoid({ currentTarget: { dataset: { idx } } })]);
    // 小票二维码：重置 / 解除认领只有主家本人（服务端同样校验）
    const rec = this.data.list[idx];
    if (this.data.isOwner && rec && rec.status === REC.PAID) {
      items.push(['重置二维码', () => this.onResetQr(idx)]);
      if (rec.claimed) items.push(['解除认领', () => this.onUnclaim(idx)]);
    }
    if (!items.length) return;
    wx.showActionSheet({
      itemList: items.map(i => i[0]),
      success: r => items[r.tapIndex] && items[r.tapIndex][1]()
    });
  },

  /** 重置二维码：旧小票上的码立即失效（token 换新），需要时补打 */
  onResetQr(idx) {
    const record = this.data.list[idx];
    wx.showModal({
      title: '重置二维码',
      content: '重置后，这笔已打印小票上的二维码立即失效，需要补打新小票。确定重置吗？',
      confirmText: '重置',
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.resetQr(record._id);
          wx.showToast({ title: '已重置', icon: 'success' });
        } catch (err) { /* toast 已提示 */ }
      }
    });
  },

  /** 解除认领：对方的「我的随礼记录」不再显示这笔，二维码可被他人重新认领 */
  onUnclaim(idx) {
    const record = this.data.list[idx];
    wx.showModal({
      title: '解除认领',
      content: '解除后，对方的「我的随礼记录」里将不再显示这笔。如担心被他人认领，可再「重置二维码」。',
      confirmText: '解除',
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.unclaim(record._id);
          this.setData({ [`list[${idx}].claimed`]: false });
          wx.showToast({ title: '已解除', icon: 'success' });
        } catch (err) { /* toast 已提示 */ }
      }
    });
  },

  /** 设区分备注：区分同名宾客（扫码宾客改其全部记录，礼台登记的只改这一条） */
  onNameTag(e) {
    const record = this.data.list[e.currentTarget.dataset.idx];
    wx.showModal({
      title: '区分备注',
      content: record.nameTag || '',
      editable: true,
      placeholderText: '如：李村、公司同事（留空即清除）',
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.setNameTag(record._id, samename.cleanTag(res.content));
          wx.showToast({ title: '已保存', icon: 'success' });
          this.reload();
        } catch (err) { /* toast 已提示 */ }
      }
    });
  },

  /** 修改已入簿礼金：打开弹层（姓名 / 金额 / 关系 / 备注） */
  onAmend(e) {
    const r = this.data.list[e.currentTarget.dataset.idx];
    if (!r || this.data.busy) return;
    const relIdx = Math.max(0, this.data.amendRels.indexOf(r.relation || ''));
    this.setData({ amend: { rid: r._id, name: r.payerName, amount: String(r.amount), relIdx, remark: r.remark || '', orig: r, hint: r.printed ? '小票已打印过，修改后不会自动重打，需要的话保存后点「补打」' : '' } });
  },
  onAmendInput(e) { this.setData({ [`amend.${e.currentTarget.dataset.k}`]: e.detail.value }); },
  onAmendRel(e) { this.setData({ 'amend.relIdx': Number(e.detail.value) }); },
  noop() {},
  onAmendClose() { if (!this.data.busy) this.setData({ amend: null }); },
  async onAmendSave() {
    const a = this.data.amend;
    if (!a || this.data.busy) return;
    const name = String(a.name || '').trim();
    const amount = Number(String(a.amount || '').replace(/[,，\s]/g, ''));
    if (!name) return wx.showToast({ title: '请填写姓名', icon: 'none' });
    if (!(amount > 0)) return wx.showToast({ title: '请填写正确的金额', icon: 'none' });
    const o = a.orig;
    const rel = a.relIdx > 0 ? this.data.amendRels[a.relIdx] : '';
    const fields = {};
    if (name !== o.payerName) fields.payerName = name;
    if (Math.round(amount * 100) !== Math.round(o.amount * 100)) fields.amount = amount;
    if (rel !== (o.relation || '')) fields.relation = rel;
    if (String(a.remark || '').trim() !== (o.remark || '')) fields.remark = String(a.remark || '').trim();
    if (!Object.keys(fields).length) return this.setData({ amend: null });
    this.setData({ busy: true });
    try {
      await req.payAmend(a.rid, fields);
      this.setData({ amend: null });
      wx.showToast({ title: '已修改', icon: 'success' });
      this.reload();
    } catch (err) { /* toast 已提示（如已被他人修改、权限不足） */ } finally {
      this.setData({ busy: false });
    }
  },
  /** 查看修改记录（最近 20 次） */
  onAmendLog(e) {
    const r = this.data.list[e.currentTarget.dataset.idx];
    const NAMES = { amount: '金额', payerName: '姓名', relation: '关系', remark: '备注' };
    const lines = (r.amendLog || []).slice().reverse().map(l => {
      const cs = Object.keys(l.changes || {}).map(k => {
        const [b, n] = l.changes[k];
        return k === 'amount' ? `金额 ￥${fmt.money(b)} → ￥${fmt.money(n)}` : `${NAMES[k] || k} ${b || '空'} → ${n || '空'}`;
      });
      return `${fmt.dateTime(l.at)} ${l.by || ''}\n${cs.join('；')}`;
    });
    wx.showModal({ title: '修改记录', content: lines.join('\n\n') || '暂无', showCancel: false });
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
    nameStr: samename.nameStr(r.payerName, r.nameTag),
    declaredStr: r.declaredAmount ? fmt.money(r.declaredAmount) : '',
    timeStr: fmt.dateTime(r.createdAt),
    statusText: STATUS_TEXT[r.status] || r.status
  };
}
