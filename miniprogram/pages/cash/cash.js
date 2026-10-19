// pages/cash/cash.js — 礼台记账：主家 / 记账人直接录入（现金，或宾客当面微信转账、礼台看到到账），入簿即生效，自动打印回执，可连续登记
// 不想自助扫码登记的宾客由礼台代为登记；批次录入还可选「转账+现金」（每人各自选）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const printer = require('../../utils/printer.js');
const batch = require('../../utils/batch.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');

const DEFAULT_QUICK = [200, 500, 600, 800, 1000, 1888];
const DONE_MAX = 20; // 本次已登记列表最多显示的份数
const emptyForm = () => ({
  payerName: '',
  relation: '',
  amount: '',
  remark: ''
});

Page({
  data: {
    ...emptyForm(),
    bookName: '',
    quick: DEFAULT_QUICK,
    batchMode: false, // 批次录入：一次登记多位随礼人，每人各打一张小票
    payMethod: 'cash', // cash 现金 | wechat 微信（礼台确认已到账）| mixed 转账+现金（仅批次录入）
    books: [],        // 机构模式：可选场次（未归档）
    bookIdx: 0,
    relations: scenes.RELATIONS,
    saving: false,
    done: [],          // 本次已登记（只显示最近 DONE_MAX 份）
    doneCount: 0,      // 本次已登记份数、合计：单独累加，不受显示条数限制
    doneSum: '0.00'
  },

  onShow() {
    theme.apply(this); // 主题色跟当前礼簿事由走
  },

  async onLoad() {
    // 记账人需有「礼台记账」权限
    const role = await getApp().ensureRole();
    if ((role === 'clerk' || role === 'viewer') && !perm.can('desk')) {
      wx.showToast({ title: '你没有「礼台记账」权限', icon: 'none' });
      return setTimeout(() => wx.navigateBack(), 800);
    }
    try {
      const [{ account }, { list, activeBookId }] = await Promise.all([req.accountGet(), req.bookList()]);
      if (!account) {
        wx.showToast({ title: '请先完善主家信息', icon: 'none' });
        return setTimeout(() => wx.navigateBack(), 800);
      }
      const book = list.find(b => b._id === activeBookId);
      // 机构模式 / 只负责部分场次：登记前选择场次
      const books = list.filter(b => !b.archived).map(b => ({ _id: b._id, name: b.hostName ? `${b.hostName} · ${b.name}` : b.name, type: b.type }));
      const pickBook = account.orgMode || !activeBookId;
      this.setData({
        books: pickBook ? books : [],
        bookIdx: Math.max(0, books.findIndex(b => b._id === activeBookId)),
        bookName: book ? book.name : '',
        quick: Array.isArray(account.quickAmounts) ? account.quickAmounts : DEFAULT_QUICK
      });
    } catch (e) { /* toast 已提示 */ }
  },

  onInput(e) { this.setData({ [e.currentTarget.dataset.k]: e.detail.value }); },
  onQuick(e) { this.setData({ amount: String(e.currentTarget.dataset.v) }); },
  onRelation(e) {
    const r = e.currentTarget.dataset.r;
    this.setData({ relation: this.data.relation === r ? '' : r });
  },
  onBatchMode(e) {
    const on = e.detail.value;
    this.setData({ batchMode: on, ...(on || this.data.payMethod !== 'mixed' ? {} : { payMethod: 'cash' }) });
  },
  onPayMethod(e) { this.setData({ payMethod: e.currentTarget.dataset.m }); },
  onPickBook(e) { this.setData({ bookIdx: Number(e.detail.value) }); },
  onBatchChange(e) { this._batchRows = e.detail.rows; },

  /** 入簿：直接记入当前礼簿，自动打印回执，清空表单登记下一位 */
  async onSave() {
    if (this.data.saving) return;
    let payload;
    if (this.data.batchMode) {
      const v = batch.validate(this._batchRows);
      if (v.error) return wx.showToast({ title: v.error, icon: 'none' });
      payload = { items: v.items };
    } else {
      const name = (this.data.payerName || '').trim();
      const amount = Number(this.data.amount);
      if (!name) return wx.showToast({ title: '请填写随礼人姓名', icon: 'none' });
      if (!(amount > 0)) return wx.showToast({ title: '请选择或填写金额', icon: 'none' });
      payload = { payerName: name, amount, relation: this.data.relation, remark: this.data.remark };
    }

    this.setData({ saving: true });
    try {
      const b = this.data.books[this.data.bookIdx];
      if (this.data.books.length && b) payload.bookId = b._id;
      payload.payMethod = this.data.payMethod;
      const { record, list } = await req.cashEntry(payload);
      const added = (list && list.length ? list : [record]).map(r => ({ ...r, amountStr: fmt.money(r.amount) }));
      const done = added.slice().reverse().concat(this.data.done).slice(0, DONE_MAX);
      this._doneFen = (this._doneFen || 0) + added.reduce((s, r) => s + Math.round(r.amount * 100), 0);
      added.forEach(r => { r.methodStr = r.payMethod === 'cash' ? '现金' : '微信'; });
      this.setData({ ...emptyForm(), done, doneCount: this.data.doneCount + added.length, doneSum: fmt.money(this._doneFen / 100) });
      if (this.data.batchMode) this.selectComponent('#batch').reset();
      const addFen = added.reduce((s, r) => s + Math.round(r.amount * 100), 0);
      wx.showToast({
        title: added.length > 1 ? `${added.length} 人 ￥${fmt.money(addFen / 100)} 已入簿` : `${added[0].payerName} ￥${added[0].amountStr} 已入簿`,
        icon: 'none'
      });
      this.print(added);
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  },

  /** 自动打印回执（批次每人一张）；打印机未连接只提示，不影响登记 */
  async print(list) {
    if (!(await printer.ensureConnected())) return;
    try {
      for (const r of list) await printer.printRecord(r);
    } catch (e) {
      wx.showToast({ title: '打印失败，可在礼簿页补打', icon: 'none' });
    }
  },

  onReceipt(e) {
    wx.navigateTo({ url: `/pages/receipt/receipt?rid=${e.currentTarget.dataset.id}` });
  }
});
