// pages/person/person.js — 与某人的人情往来明细：他随给我的 / 我送给他的
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');

Page({
  data: {
    key: '',
    name: '',
    dup: false,
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

  onShow() { this.load(); },

  async load() {
    try {
      const r = await req.rqQuery(this.data.key);
      const deco = x => ({ ...x, amountStr: fmt.money(x.amount), typeLabel: scenes.label(x.eventType) });
      wx.setNavigationBarTitle({ title: `与 ${r.name} 的往来` });
      this.setData({
        key: r.key,
        name: r.name,
        dup: r.dup,
        byWx: r.key.indexOf('o:') === 0,
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

  /** 给此人记一笔送礼（回礼） */
  onAddGift() {
    const key = this.data.key.startsWith('o:') ? this.data.key : '';
    wx.navigateTo({ url: `/pages/giftedit/giftedit?toName=${encodeURIComponent(this.data.name)}&toKey=${encodeURIComponent(key)}` });
  },

  onEditGift(e) {
    const g = this.data.given[e.currentTarget.dataset.idx];
    if (g.auto) return wx.navigateTo({ url: `/pages/receipt/receipt?rid=${g.rid}` });
    getApp().globalData.editGift = g;
    wx.navigateTo({ url: '/pages/giftedit/giftedit?edit=1' });
  }
});
