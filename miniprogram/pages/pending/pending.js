// pages/pending/pending.js — 待确认礼金：列表批量 / 逐笔大字 两种处理方式
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const confirm = require('../../utils/confirm.js');
const receipt = require('../../utils/receipt.js');
const notify = require('../../utils/notify.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');

const POLL_MS = 5000;
const MODE_KEY = 'pending_mode'; // 记住上次使用的处理方式

Page({
  data: {
    mode: 'list',     // list 列表批量 | card 逐笔大字
    shown: [],        // 列表模式按姓名筛选后
    keyword: '',
    total: 0,
    sumStr: '0.00',
    selectMode: false,
    pickedCount: 0,
    pickedSum: '0.00',
    current: null,    // 逐笔模式当前一笔（队列最早的一笔）
    editor: null,     // 批次逐人改金额：{ group, rows: [{_id, name, declared, value}] }
    sheet: null,      // 列表模式批次明细弹层（当前打开的一组）
    notifyTip: '',    // 新礼金提醒未开启时提示
    busy: false,
    canConfirm: true, // 没有「确认收礼」权限：只能查看列表
    loaded: false
  },

  onLoad() {
    this._list = [];  // 全部待确认（仅 JS 使用，不进 data，减少 setData 传输）
    let mode = 'list';
    try { mode = wx.getStorageSync(MODE_KEY) || 'list'; } catch (e) { /* 默认列表 */ }
    this.setData({ mode });
  },

  onShow() {
    theme.apply(this); // 主题色跟当前礼簿事由走
    getApp().ensureRole().then(() => {
      const canConfirm = perm.can('confirm');
      this.setData(canConfirm ? { canConfirm } : { canConfirm, mode: 'list', selectMode: false });
    });
    this.checkNotify();
    this.load(false);
    this._timer = setInterval(() => this.load(true), POLL_MS);
  },
  onHide() { this.clearTimer(); },
  onUnload() { this.clearTimer(); },
  clearTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  /** 拉取待确认；silent=true 为轮询，有新礼金时震动 */
  async load(silent) {
    if (this.data.busy) return;
    try {
      const { list } = await req.recordPending();
      if (silent && list.length > countOf(this._list)) wx.vibrateShort({ type: 'heavy', fail() {} });
      const picked = new Set(this._list.filter(r => r.picked).map(r => r._id));
      // 批次录入的多位随礼人合成一组；按转账时间先后排列：逐笔模式先处理最早的
      const items = groupRecords(list)
        .map(g => ({ ...g, picked: picked.has(g._id) }))
        .sort((a, b) => new Date(a.transferredAt || a.createdAt) - new Date(b.transferredAt || b.createdAt));
      this._list = items;
      // 轮询只做一次 setData
      const patch = { ...this.derive(), loaded: true };
      if (!items.length) patch.selectMode = false;
      this.setData(patch);
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  /** 从未成功收到提醒时，提示开启（确认礼金时会自动续订） */
  async checkNotify() {
    if (!notify.enabled()) return;
    try {
      const { lastNotify } = await req.accountGet();
      this.setData({ notifyTip: notify.tipText(lastNotify) });
    } catch (e) { /* 静默 */ }
  },

  async onSubscribe() {
    if (await notify.subscribe()) {
      this.setData({ notifyTip: '' });
      wx.showToast({ title: '已开启', icon: 'success' });
    }
  },

  // —— 模式切换 ——
  onMode(e) {
    const mode = e.currentTarget.dataset.m;
    this.setData({ mode, selectMode: false });
    try { wx.setStorageSync(MODE_KEY, mode); } catch (err) { /* 忽略 */ }
    this.setCurrent();
  },

  // —— 列表模式 ——
  onKeyword(e) {
    this.setData({ keyword: e.detail.value, shown: this.filterList(e.detail.value) });
  },

  /** 按姓名筛选（列表模式） */
  filterList(keyword) {
    const k = (keyword || '').trim();
    return k
      ? this._list.filter(g => g.records.some(r => r.payerName.includes(k) || (r.proxyFor || '').includes(k)))
      : this._list;
  },

  /** 由 this._list 推导页面需要的全部字段，供一次 setData 使用；顺带更新角标 */
  derive(keyword = this.data.keyword) {
    const list = this._list;
    const fen = list.reduce((s, r) => s + Math.round(r.amount * 100), 0);
    const total = countOf(list);
    const picked = list.filter(r => r.picked);
    const pickedFen = picked.reduce((s, r) => s + Math.round(r.amount * 100), 0);
    getApp().setBadge(total);
    // 批次明细弹层：跟随最新数据；该组已处理（不在列表中）则自动关闭
    const sheet = this._sheetId ? (this.findById(this._sheetId) || null) : null;
    if (!sheet) this._sheetId = null;
    return {
      sheet,
      shown: this.filterList(keyword),
      current: list[0] || null, // 逐笔模式当前一笔（队列最早的一笔）
      total,
      sumStr: fmt.money(fen / 100),
      pickedCount: countOf(picked),
      pickedSum: fmt.money(pickedFen / 100)
    };
  },

  async onConfirm(e) {
    const g = this.findById(e.currentTarget.dataset.id);
    if (!g) return;
    const res = await this.run(() => confirm.confirmTransfer(g));
    if (res === 'edit') { this.onCloseSheet(); this.openEditor(g); }
    else if (res) this.removeLocal(g._id);
  },

  /** 打开批次明细弹层（catchtap，不触发勾选） */
  onOpenSheet(e) {
    this._sheetId = e.currentTarget.dataset.id;
    this.setData(this.derive());
  },
  onCloseSheet() {
    this._sheetId = null;
    this.setData({ sheet: null });
  },
  noop() {},
  /** 弹层内：金额不一致 → 逐人按实际金额入簿（复用逐笔模式的编辑器） */
  onSheetMismatch() {
    const g = this.data.sheet && this.findById(this.data.sheet._id);
    if (!g) return;
    this.onCloseSheet();
    this.openEditor(g);
  },

  async onReject(e) {
    const record = this.findById(e.currentTarget.dataset.id);
    if (record && (await this.run(() => confirm.rejectTransfer(record)))) this.removeLocal(record._id);
  },

  onToggleSelect() {
    this._list = this._list.map(r => ({ ...r, picked: false }));
    this.setData({ selectMode: !this.data.selectMode, ...this.derive() });
  },

  onPick(e) {
    if (!this.data.selectMode) return;
    const id = e.currentTarget.dataset.id;
    this._list = this._list.map(r => (r._id === id ? { ...r, picked: !r.picked } : r));
    this.setData(this.derive());
  },

  onPickAll() {
    const ids = new Set(this.data.shown.map(r => r._id));
    const all = this.data.shown.some(r => !r.picked);
    this._list = this._list.map(r => (ids.has(r._id) ? { ...r, picked: all } : r));
    this.setData(this.derive());
  },

  async onConfirmPicked() {
    // 批次展开为每位随礼人的记录
    const picked = this._list.filter(r => r.picked).reduce((a, g) => a.concat(g.records), []);
    if (!picked.length) return;
    if (await this.run(() => confirm.confirmBatch(picked))) {
      this.setData({ selectMode: false });
      this.load(false);
    }
  },

  // —— 逐笔模式 ——
  setCurrent() {
    this.setData({ current: this._list[0] || null });
  },

  /** 收到了：卡片上已大字显示金额，直接入簿 */
  async onCardOk() {
    const r = this.data.current;
    if (r && (await this.run(() => confirm.confirmDirect(r)))) this.removeLocal(r._id);
  },

  /** 金额不符：按实际到账金额入簿（批次逐人修改） */
  async onCardMismatch() {
    const r = this.data.current;
    if (!r) return;
    if (r.batch) return this.openEditor(r);
    if (await this.run(() => confirm.askActualAmount(r))) this.removeLocal(r._id);
  },

  // —— 批次逐人改金额 ——
  openEditor(g) {
    this.clearTimer(); // 编辑期间暂停轮询
    this.setData({
      editor: {
        group: g,
        rows: g.records.map(r => ({ _id: r._id, name: r.payerName, declared: fmt.money(r.amount), value: String(r.amount) })),
        sumStr: g.amountStr
      }
    });
  },
  onEditInput(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ [`editor.rows[${i}].value`]: e.detail.value });
    const fen = this.data.editor.rows.reduce((s, r) => s + Math.round((Number(r.value) || 0) * 100), 0);
    this.setData({ 'editor.sumStr': fmt.money(fen / 100) });
  },
  onEditCancel() {
    this.setData({ editor: null });
    this.resumeTimer();
  },
  async onEditSave() {
    const { group, rows } = this.data.editor;
    const amounts = {};
    for (const r of rows) {
      const v = Number(String(r.value).trim());
      if (!(v > 0)) return wx.showToast({ title: `${r.name} 的金额不正确`, icon: 'none' });
      const rec = group.records.find(x => x._id === r._id);
      if (Math.round(v * 100) !== Math.round(rec.amount * 100)) amounts[r._id] = v;
    }
    const ok = await this.run(() => confirm.confirmGroupAmounts(group, amounts));
    if (!ok) return;
    this.setData({ editor: null });
    this.removeLocal(group._id);
    this.resumeTimer();
  },
  resumeTimer() {
    this.clearTimer();
    this._timer = setInterval(() => this.load(true), POLL_MS);
  },

  async onCardNo() {
    const r = this.data.current;
    if (r && (await this.run(() => confirm.rejectTransfer(r)))) this.removeLocal(r._id);
  },

  // —— 工具 ——
  findById(id) {
    return this._list.find(r => r._id === id);
  },

  /** 处理期间暂停轮询，避免列表跳动 */
  async run(fn) {
    if (this.data.busy) return; // 防重复点击
    this.setData({ busy: true });
    try {
      return await fn();
    } finally {
      this.setData({ busy: false });
    }
  },

  /** 本地立即移除已处理的一笔（或一批），逐笔模式自动切到下一笔 */
  removeLocal(id) {
    this._list = this._list.filter(r => r._id !== id);
    this.setData(this.derive());
  }
});

/** 份数：批次按人数计 */
function countOf(groups) {
  return groups.reduce((n, g) => n + (g.records ? g.records.length : 1), 0);
}

/** 待确认记录按批次分组；普通记录自成一组 */
function groupRecords(list) {
  const map = new Map();
  for (const r of list) {
    const key = r.batchId || r._id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map.values()].map(recs => {
    recs.sort((a, b) => (a.batchIdx || 0) - (b.batchIdx || 0));
    const first = recs[0];
    const fen = recs.reduce((s, r) => s + Math.round(r.amount * 100), 0);
    const batch = recs.length > 1;
    // 混合支付（服务端标记 batchPay: 'mixed'）：每人各自 payMethod，分别小计
    const mixed = recs.some(r => r.batchPay === 'mixed');
    const cashFen = recs.filter(r => r.payMethod === 'cash').reduce((s, r) => s + Math.round(r.amount * 100), 0);
    return {
      ...first,
      batch,
      mixed,
      methodLabel: mixed ? '转账+现金' : (first.payMethod === 'cash' ? '现金' : '转账'),
      wechatSumStr: fmt.money((fen - cashFen) / 100),
      cashSumStr: fmt.money(cashFen / 100),
      records: recs.map(r => ({ ...r, amountStr: fmt.money(r.amount) })),
      payerName: batch ? `${first.payerName} 等 ${recs.length} 人` : first.payerName,
      amount: fen / 100,
      amountStr: fmt.money(fen / 100),
      relation: batch ? '' : first.relation,
      remark: batch ? '' : first.remark,
      proxyStr: batch ? '' : receipt.proxyText(first),
      timeStr: fmt.time(first.transferredAt || first.createdAt)
    };
  });
}
