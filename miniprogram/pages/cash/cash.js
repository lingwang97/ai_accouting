// pages/cash/cash.js — 礼台记账：主家 / 记账人直接录入（现金，或宾客当面微信转账、礼台看到到账），入簿即生效，自动打印回执，可连续登记
// 不想自助扫码登记的宾客由礼台代为登记；批次录入还可选「转账+现金」（每人各自选）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const printer = require('../../utils/printer.js');
const batch = require('../../utils/batch.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');
const samename = require('../../utils/samename.js');
const ble = require('../../utils/ble.js');

const DEFAULT_QUICK = [100, 200, 300, 500, 600, 800, 1000, 1500, 2000];
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
    orgMode: !!(getApp().globalData.account && getApp().globalData.account.orgMode), // 机构模式称「场次」，个人称「礼簿」
    bookIdx: 0,
    relations: scenes.RELATIONS,
    saving: false,
    pageLoading: true, // 首次读取礼簿期间：转圈 + 不可操作
    done: [],          // 本次已登记（只显示最近 DONE_MAX 份）
    doneCount: 0,      // 本次已登记份数、合计：单独累加，不受显示条数限制
    doneSum: '0.00',
    printerStatus: 'none', // connected 已连接 / paired 已配对未连接 / none 未配对（顶部状态条）
    nameFocus: false,      // 入簿后自动聚焦姓名，接着登记下一位
    amountFocus: false
  },

  onShow() {
    this.setData({ primary: theme.apply(this).primary }); // 主题色跟当前礼簿事由走
    this.syncPrinter();
    if (!this._onPrinter) this._onPrinter = () => this.syncPrinter();
    ble.onStateChange(this._onPrinter);
  },

  async onLoad() {
    try { await this.init(); } finally { this.setData({ pageLoading: false }); }
  },

  async init() {
    // 记账人需有「礼台记账」权限
    const role = await getApp().ensureRole();
    if ((role === 'clerk' || role === 'viewer') && !perm.can('desk')) {
      wx.showToast({ title: '你没有「礼台记账」权限', icon: 'none' });
      return setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) }), 800);
    }
    try {
      // 冷启动时 ensureRole 刚读过主家信息：直接用，不再重复调用（v3.66.2）
      const fresh = getApp().takeFreshAccount();
      const [account, { list, activeBookId }] = await Promise.all([
        fresh !== undefined ? fresh : req.accountGet().then(r => r.account),
        req.bookList()
      ]);
      if (!account) {
        wx.showToast({ title: '请先完善主家信息', icon: 'none' });
        return setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) }), 800);
      }
      const book = list.find(b => b._id === activeBookId);
      // 机构模式 / 只负责部分场次：登记前选择场次
      const books = list.filter(b => !b.archived).map(b => ({ _id: b._id, name: b.hostName ? `${b.hostName} · ${b.name}` : b.name, type: b.type }));
      const pickBook = account.orgMode || !activeBookId;
      this.setData({
        orgMode: !!account.orgMode,
        books: pickBook ? books : [],
        bookIdx: books.findIndex(b => b._id === activeBookId), // -1：没有当前礼簿，须先选
        bookName: book ? book.name : '',
        quick: Array.isArray(account.quickAmounts) ? account.quickAmounts : DEFAULT_QUICK
      });
    } catch (e) { /* toast 已提示 */ }
  },

  onHide() { if (this._onPrinter) ble.offStateChange(this._onPrinter); },
  onUnload() { if (this._onPrinter) ble.offStateChange(this._onPrinter); },
  syncPrinter() {
    const status = ble.printerStatus(ble.loadDevice(), !!ble.state.deviceId);
    if (status !== this.data.printerStatus) this.setData({ printerStatus: status });
  },
  /** 打印机状态条：已配对未连接 → 立即重连（并结束自动打印的 10 分钟暂停）；未配对 → 去配对 */
  async onPrinterTap() {
    const st = this.data.printerStatus;
    if (st === 'connected') return;
    if (st === 'none') return wx.navigateTo({ url: '/pages/printer/printer' });
    if (this._linking) return;
    this._linking = true;
    wx.showLoading({ title: '正在连接', mask: true });
    printer.resumeAuto();
    let ok = false;
    try { ok = await printer.ensureConnected(); } catch (e) { ok = false; }
    wx.hideLoading();
    this._linking = false;
    this.syncPrinter();
    if (ok) wx.showToast({ title: '已连接', icon: 'success' });
    else {
      wx.showModal({
        title: '没连上打印机',
        content: '请确认打印机已开机、手机蓝牙已打开，并靠近打印机后再试；也可以去「打印机」页重新配对。',
        confirmText: '去配对',
        cancelText: '知道了',
        success: r => { if (r.confirm) wx.navigateTo({ url: '/pages/printer/printer' }); }
      });
    }
  },
  onNameBlur() { this.setData({ nameFocus: false }); },
  onAmountBlur() { this.setData({ amountFocus: false }); },
  /** 姓名键盘点「下一项」：跳到金额 */
  onNameNext() { this.setData({ nameFocus: false, amountFocus: true }); },
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
      // 同名区分：礼簿里已有同名宾客时，逐个确认是哪一位（取消即中止，不提示）
      // 先检查礼簿再选同名，避免选完同名才提示没选礼簿
      const b = this.data.books[this.data.bookIdx];
      if (this.data.books.length && !b) return wx.showToast({ title: '请先选择记入哪本礼簿', icon: 'none' });
      if (this.data.books.length && b) payload.bookId = b._id;
      payload.payMethod = this.data.payMethod;
      // 转账+现金只填了一位：按这一位的方式提交，不算混合
      if (payload.payMethod === 'mixed' && payload.items && payload.items.length === 1) payload.payMethod = payload.items[0].method;
      // 一次调用完成同名检查 + 入簿（v3.66.0）：礼簿里没有同名直接入簿；有同名时云端只返回名单，选好是哪一位后再提交
      let res = await req.cashEntry({ ...payload, reqId: this.reqIdOf(payload), nameCheck: true });
      if (res.needPick) {
        const picked = await this.pickSameName(payload, b ? b._id : '', res.map || {});
        if (!picked) return; // 取消即中止，不提示
        res = await req.cashEntry({ ...payload, reqId: this.reqIdOf(payload) });
      }
      const { record, list } = res;
      this._reqId = ''; // 已入簿，下一位换新 reqId
      const added = (list && list.length ? list : [record]).map(r => ({ ...r, amountStr: fmt.money(r.amount), nameStr: samename.nameStr(r.payerName, r.nameTag) }));
      const done = added.slice().reverse().concat(this.data.done).slice(0, DONE_MAX);
      this._doneFen = (this._doneFen || 0) + added.reduce((s, r) => s + Math.round(r.amount * 100), 0);
      added.forEach(r => { r.methodStr = r.payMethod === 'cash' ? '现金' : '微信'; });
      this.setData({ ...emptyForm(), done, doneCount: this.data.doneCount + added.length, doneSum: fmt.money(this._doneFen / 100), nameFocus: false, amountFocus: false });
      if (this.data.batchMode) this.selectComponent('#batch').reset();
      else setTimeout(() => this.setData({ nameFocus: true }), 50); // 光标回到姓名，直接登记下一位
      const addFen = added.reduce((s, r) => s + Math.round(r.amount * 100), 0);
      // 自动归到以前随过礼的人时不再弹窗说明（第二场起老亲戚几乎每位都会触发，太打扰）；归错了到往来页区分
      wx.showToast({
        title: added.length > 1 ? `${added.length} 人 ￥${fmt.money(addFen / 100)} 已入簿` : `${added[0].payerName} ￥${added[0].amountStr} 已入簿`,
        icon: 'none'
      });
      this.print(added);
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  },

  /**
   * 幂等键：弱网下超时重试、重复点击都带同一个 reqId，服务端不会重复入簿；成功后才换新的
   * 内容变了（重试前改过表单、选了同名的哪一位）就换新的，避免把修改后的内容当成重复提交
   */
  reqIdOf(payload) {
    const sig = JSON.stringify(payload);
    if (!this._reqId || this._reqSig !== sig) {
      this._reqId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      this._reqSig = sig;
    }
    return this._reqId;
  },

  /**
   * 同名区分：查询礼簿里已有的同名宾客，逐个选择「是哪一位」或「新的一位」并填区分备注
   * 选中已有 → personRef（那一位的某条记录 id，服务端换成往来人）+ tag；新的一位 → tag。返回 false 表示用户取消，否则 { notes }（自动归并的提示）；查询失败（网络）按无备注继续
   */
  async pickSameName(payload, bookId, given) {
    const items = payload.items || [payload];
    const nameOf = it => it.name || it.payerName;
    const notes = [];
    let map = given || {};
    if (!given) { // 旧用法：单独查询（云端已随 cashEntry 返回名单时不再查）
      try {
        map = (await req.bookNameCheck(items.map(nameOf), bookId)).map || {};
      } catch (e) { return { notes }; }
    }
    for (const it of items) {
      const name = nameOf(it);
      const d = samename.decide(map[name]);
      if (d.type === 'none') continue;
      if (d.type === 'auto') { // 本场没有、以前的礼簿只有一位：不弹窗，按同一个人记
        it.personRef = d.person.ref;
        it.tag = d.person.tag;
        notes.push({ name, person: d.person });
        continue;
      }
      const people = d.people;
      people.forEach(p => { p.label = samename.labelOf(name, p); });
      const r = await samename.choose(name, people);
      if (!r) return false;
      if (r.person) {
        it.personRef = r.person.ref;
        it.tag = r.person.tag;
      } else {
        it.tag = r.tag;
      }
    }
    return { notes };
  },

  /** 自动打印回执（批次每人一张）；没配过打印机不打印；连不上时暂停自动打印 10 分钟，只提示这一次（v3.65.2） */
  async print(list) {
    const st = await printer.autoConnect();
    this.syncPrinter();
    if (st === 'failed') return wx.showToast({ title: '打印机没连上，暂停自动打印', icon: 'none', duration: 3000 });
    if (st !== 'ok') return;
    try {
      for (const r of list) await printer.printRecord(r);
    } catch (e) {
      wx.showToast({ title: e.partial ? e.message : '打印失败，可在礼簿页补打', icon: 'none' });
    }
  },

  onReceipt(e) {
    wx.navigateTo({ url: `/pages/receipt/receipt?rid=${e.currentTarget.dataset.id}` });
  }
});
