// pages/person/person.js — 与某人的人情往来明细：他随给我的 / 我送给他的
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const theme = require('../../utils/theme.js');
const samename = require('../../utils/samename.js');

/** 往来人 key 显示为姓名：o:身份:张伟 → 张伟（扫码）；n:张伟#李村 → 张伟（李村） */
function keyName(k) {
  if (k.indexOf('o:') === 0 || k.indexOf('h:') === 0) return k.split(':').slice(2).join(':') + '（扫码）';
  const [name, tag] = k.slice(2).split('#');
  return samename.nameStr(name, tag);
}

Page({
  data: {
    key: '',
    name: '',
    label: '',
    dup: false,
    same: [],      // 其他同名的人 [{ key, label }]
    sameStr: '',
    merged: [],    // 已合并到此人的 key
    received: [],
    given: [],
    receivedSum: '0.00',
    givenSum: '0.00',
    balance: 0,
    balanceStr: '0.00',
    loading: true
  },

  onLoad(options) {
    // key：o:微信身份:姓名（宾客）或 n:姓名；兼容旧入口 name
    const key = decodeURIComponent(options.key || '') || ('n:' + decodeURIComponent(options.name || ''));
    this.setData({ key });
  },

  onShow() {
    theme.apply(this); // 主题色跟当前礼簿事由走
    this.load();
  },

  async load() {
    try {
      const r = await req.rqQuery(this.data.key);
      const deco = x => ({ ...x, amountStr: fmt.money(x.amount), typeLabel: scenes.label(x.eventType) });
      const label = r.label || r.name;
      wx.setNavigationBarTitle({ title: `与 ${label} 的往来` });
      const same = r.same || [];
      this.setData({
        key: r.key,
        name: r.name,
        label,
        same,
        sameStr: same.slice(0, 3).map(x => x.label).join('、') + (same.length > 3 ? '…' : ''),
        merged: r.merged || [],
        dup: r.dup,
        byWx: r.key.indexOf('h:') === 0, // 扫码宾客（服务端返回加密后的 h: 标识）
        received: r.received.map(deco),
        given: r.given.map(deco),
        receivedSum: fmt.money(r.receivedSum),
        givenSum: fmt.money(r.givenSum),
        balance: r.balance,
        balanceStr: fmt.money(Math.abs(r.balance))
      });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  // —— 同名区分：合并 / 取消合并 / 移动记录 ——
  /** 与同名的另一位合并为同一人，合并后跳到合并后的人 */
  async onMerge() {
    const same = this.data.same.slice(0, samename.SHEET_MAX);
    const idx = await samename.sheet(same.map(x => x.label), '合并到哪一位？');
    if (idx < 0) return;
    const to = same[idx];
    const ok = await new Promise(resolve => wx.showModal({
      title: '合并为同一人',
      content: '合并后两人的往来记录合并统计，可随时取消合并',
      confirmText: '合并',
      success: res => resolve(res.confirm),
      fail: () => resolve(false)
    }));
    if (!ok) return;
    try {
      await req.rqMerge(this.data.key, to.key);
      wx.showToast({ title: '已合并', icon: 'success' });
      wx.redirectTo({ url: `/pages/person/person?key=${encodeURIComponent(to.key)}` });
    } catch (e) { /* toast 已提示 */ }
  },

  /** 取消合并：选一位已合并进来的人，恢复单独统计 */
  async onUnmerge() {
    const merged = this.data.merged.slice(0, samename.SHEET_MAX);
    const idx = await samename.sheet(merged.map(keyName), '取消合并哪一位？');
    if (idx < 0) return;
    try {
      await req.rqUnmerge(merged[idx]);
      wx.showToast({ title: '已取消合并', icon: 'success' });
      this.load();
    } catch (e) { /* toast 已提示 */ }
  },

  /** 不是 TA：把这条记录移到同名的另一位，或新的一位（填区分备注） */
  async onMove(e) {
    const { side, idx } = e.currentTarget.dataset;
    const entry = this.data[side][idx];
    if (!entry) return;
    const r = await samename.choose(this.data.name, this.data.same);
    if (!r) return;
    try {
      await req.rqMoveEntry(r.person ? { side, id: entry._id, to: r.person.key } : { side, id: entry._id, tag: r.tag });
      wx.showToast({ title: '已移动', icon: 'success' });
      this.load();
    } catch (err) { /* toast 已提示 */ }
  },

  /** 给此人记一笔送礼（回礼）：带上此人 key，避免同名混淆 */
  onAddGift() {
    const key = this.data.key;
    wx.navigateTo({ url: `/pages/giftedit/giftedit?toName=${encodeURIComponent(this.data.name)}&toKey=${encodeURIComponent(key)}` });
  },

  /** 记下此人家办事的日期，到时提醒回礼 */
  onAddRemind() {
    const key = this.data.key.startsWith('h:') ? this.data.key : '';
    wx.navigateTo({ url: `/pages/remind/remind?name=${encodeURIComponent(this.data.name)}&key=${encodeURIComponent(key)}` });
  },

  /** 这一笔收礼：记下 TA 家办事日期，到时提醒回礼（备注带上当时的金额） */
  onRemindRecv(e) {
    const key = this.data.key.startsWith('h:') ? this.data.key : '';
    const note = `曾随我 ￥${e.currentTarget.dataset.amount}`;
    wx.navigateTo({ url: `/pages/remind/remind?name=${encodeURIComponent(this.data.name)}&key=${encodeURIComponent(key)}&note=${encodeURIComponent(note)}` });
  },

  onEditGift(e) {
    const g = this.data.given[e.currentTarget.dataset.idx];
    if (g.auto) return wx.navigateTo({ url: `/pages/receipt/receipt?rid=${g.rid}` });
    getApp().globalData.editGift = g;
    wx.navigateTo({ url: '/pages/giftedit/giftedit?edit=1' });
  }
});
