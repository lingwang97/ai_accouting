// pages/pending/pending.js — 待确认礼金：列表批量 / 逐笔大字 两种处理方式
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const confirm = require('../../utils/confirm.js');
const notify = require('../../utils/notify.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');
const { countOf, groupRecords } = require('../../utils/group.js');

const POLL_MS = 10000; // 轮询只查计数（pendingStat），数量变化才拉完整列表；每 3 次也拉一次（刷新宾客未点完成的列表）
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
    current: null,    // 逐笔模式当前显示的一笔
    cardIdx: 0,       // 逐笔模式：当前是第几笔（左右滑动切换）
    cardCount: 0,
    slide: '',        // 切换动画：slide-l / slide-r
    editor: null,     // 批次逐人改金额：{ group, rows: [{_id, name, declared, value}] }
    sheet: null,      // 列表模式批次明细弹层（当前打开的一组）
    notifyTip: '',    // 新礼金提醒未开启时提示
    busy: false,
    canConfirm: true, // 没有「确认收礼」权限：只能查看列表
    loaded: false,
    bookName: '',     // 当前礼簿名：待确认只处理当前礼簿
    otherCount: 0,    // 其他礼簿的待确认份数（提示回工作台切换）
    unit: '礼簿'       // 机构模式称「场次」
  },

  onLoad() {
    this._list = [];  // 全部待确认（仅 JS 使用，不进 data，减少 setData 传输）
    let mode = 'list';
    try { mode = wx.getStorageSync(MODE_KEY) || 'list'; } catch (e) { /* 默认列表 */ }
    this.setData({ mode });
  },

  onShow() {
    theme.apply(this); // 主题色跟当前礼簿事由走
    const acc = getApp().globalData.account;
    this.setData({ unit: acc && acc.orgMode ? '场次' : '礼簿' });
    getApp().ensureRole().then(() => {
      const canConfirm = perm.can('confirm');
      this.setData(canConfirm ? { canConfirm } : { canConfirm, mode: 'list', selectMode: false });
    });
    this.checkNotify();
    this.load(false);
    this._timer = setInterval(() => this.poll(), POLL_MS);
  },
  /** 其他礼簿有待确认：回工作台切换当前礼簿 */
  goSwitch() { wx.switchTab({ url: '/pages/index/index' }); },

  onHide() { this.clearTimer(); },
  onUnload() { this.clearTimer(); },
  clearTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  /** 轮询：先用轻接口查计数，变化了才拉完整列表 */
  async poll() {
    if (this.data.busy) return;
    this._tick = (this._tick || 0) + 1;
    if (this._tick % 3 === 0) return this.load(true);
    try {
      const s = await req.pendingStat();
      if (Math.min(s.count, 100) !== countOf(this._list) || (s.other || 0) !== this.data.otherCount) this.load(true);
    } catch (e) { /* 静默 */ }
  },

  /** 拉取待确认；silent=true 为轮询，有新礼金时震动 */
  async load(silent) {
    if (this.data.busy) return;
    try {
      const { list, stalled, bookName, otherCount } = await req.recordPending();
      // 宾客没点「我已完成转账」的（含 24 小时内被自动取消的）：主家核对微信到账后可直接入簿
      this.setData({
        stalled: groupRecords(stalled || []).map(g => ({ ...g, auto: g.status === 'cancelled', timeStr: fmt.time(g.createdAt) }))
      });
      if (silent && list.length > countOf(this._list)) wx.vibrateShort({ type: 'heavy', fail() {} });
      const picked = new Set(this._list.filter(r => r.picked).map(r => r._id));
      // 批次录入的多位随礼人合成一组；按转账时间先后排列：逐笔模式先处理最早的
      const items = groupRecords(list)
        .map(g => ({ ...g, picked: picked.has(g._id) }))
        .sort((a, b) => new Date(a.transferredAt || a.createdAt) - new Date(b.transferredAt || b.createdAt));
      this._list = items;
      // 轮询只做一次 setData
      const patch = { ...this.derive(), loaded: true, bookName: bookName || '', otherCount: otherCount || 0 };
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
      ? this._list.filter(g => g.records.some(r => r.payerName.includes(k)))
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
      ...this.cardOf(list),     // 逐笔模式：保持正在看的那一笔；它已处理则显示原位置的下一笔
      total,
      sumStr: fmt.money(fen / 100),
      pickedCount: countOf(picked),
      pickedSum: fmt.money(pickedFen / 100)
    };
  },

  /** 宾客未点完成的：核对到账后入簿（批次金额不符时逐人改金额） */
  async onStallConfirm(e) {
    const g = this.data.stalled.find(x => x._id === e.currentTarget.dataset.id);
    if (!g) return;
    const res = await this.run(() => confirm.confirmTransfer(g));
    if (res === 'edit') this.openEditor(g);
    else if (res) this.load(false);
  },
  /** 宾客未点完成的：核对确实没收到。还没取消的标记为未收到（宾客那边显示主家未收到）；已自动取消的从这一栏移除 */
  async onStallReject(e) {
    const g = this.data.stalled.find(x => x._id === e.currentTarget.dataset.id);
    if (!g) return;
    if (!g.auto) {
      if (await this.run(() => confirm.rejectTransfer(g))) this.load(false);
      return;
    }
    const ok = await new Promise(resolve => wx.showModal({
      title: '确认未收到',
      content: `${g.payerName} ￥${g.amountStr} 已被自动取消。确认微信里没有收到这笔转账？确认后从这一栏移除。`,
      confirmText: '未收到',
      confirmColor: '#FA5151',
      success: r => resolve(r.confirm),
      fail: () => resolve(false)
    }));
    if (!ok) return;
    try {
      await this.run(() => req.payDismissStall(g._id));
      wx.showToast({ title: '已移除', icon: 'success' });
      this.load(false);
    } catch (err) { /* toast 已提示 */ }
  },
  onStallAll() { this.setData({ stallAll: !this.data.stallAll }); },

  async onConfirm(e) {
    const g = this.findById(e.currentTarget.dataset.id);
    if (!g) return;
    const res = await this.run(() => confirm.confirmTransfer(g));
    if (res === 'edit') { this.onCloseSheet(); this.openEditor(g); }
    else if (res) { this.removeLocal(g._id); if (g.status !== 'transferred') this.load(false); }
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
    if (!record) return;
    // 弹层里打开的是「宾客未点完成」中已自动取消的批次：按移除处理
    if (record.status === 'cancelled') { this.onCloseSheet(); return this.onStallReject({ currentTarget: { dataset: { id: record._id } } }); }
    if (await this.run(() => confirm.rejectTransfer(record))) { this.removeLocal(record._id); if (record.status !== 'transferred') this.load(false); }
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

  // —— 逐笔模式：左右滑动切换 ——
  /**
   * 当前显示哪一笔：优先保持正在看的那一笔（新到账的排在队尾，不打断）；
   * 它已处理（不在列表中）则停在原位置，即显示下一笔；超出末尾回到第一笔
   */
  cardOf(list) {
    let idx = this._curId ? list.findIndex(r => r._id === this._curId) : -1;
    if (idx < 0) idx = this._curIdx || 0; // 已处理：原位置即下一笔
    if (idx >= list.length) idx = 0;      // 处理的是最后一笔：回到第一笔
    const current = list[idx] || null;
    this._curId = current ? current._id : null;
    this._curIdx = idx;
    return { current, cardIdx: idx, cardCount: list.length };
  },
  setCurrent() {
    this.setData(this.cardOf(this._list));
  },
  goCard(step) {
    const n = this._list.length;
    if (n < 2) return;
    const idx = ((this._curIdx || 0) + step + n) % n;
    this._curId = this._list[idx]._id;
    this._curIdx = idx;
    this.setData({ ...this.cardOf(this._list), slide: step > 0 ? 'slide-l' : 'slide-r' });
    clearTimeout(this._slideT);
    this._slideT = setTimeout(() => this.setData({ slide: '' }), 260);
  },
  onCardPrev() { this.goCard(-1); },
  onCardNext() { this.goCard(1); },
  onTouchStart(e) {
    const t = e.changedTouches[0];
    this._touch = { x: t.clientX, y: t.clientY };
  },
  onTouchEnd(e) {
    const s = this._touch;
    this._touch = null;
    if (!s) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    // 水平滑动超过 60px 且明显大于竖直方向才切换，避免与页面上下滚动冲突
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) this.goCard(dx < 0 ? 1 : -1);
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
        rows: g.records.map(r => ({ _id: r._id, name: r.nameStr, declared: fmt.money(r.amount), value: String(r.amount) })),
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
    this.load(false); // 可能是「宾客未点完成」里的一批
  },
  resumeTimer() {
    this.clearTimer();
    this._timer = setInterval(() => this.poll(), POLL_MS);
  },

  async onCardNo() {
    const r = this.data.current;
    if (r && (await this.run(() => confirm.rejectTransfer(r)))) this.removeLocal(r._id);
  },

  // —— 工具 ——
  findById(id) {
    return this._list.find(r => r._id === id) || (this.data.stalled || []).find(r => r._id === id);
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
