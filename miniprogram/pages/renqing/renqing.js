// pages/renqing/renqing.js — 人情往来：往来名单（收/送汇总）+ 我送出的礼
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');

Page({
  data: {
    tab: 'people',     // people | out
    keyword: '',
    people: [],
    shownPeople: [],
    outList: [],
    outSum: '0.00',
    outTotal: 0,
    loading: false,
    loggedIn: true
  },

  onShow() {
    getApp().refreshTabBar();
    getApp().refreshBadge();
    this.load();
  },

  async load() {
    if (!getApp().globalData.user && wx.getStorageSync('logged_out')) {
      return this.setData({ loggedIn: false });
    }
    this.setData({ loading: true, loggedIn: true });
    try {
      if (this.data.tab === 'people') {
        const { list } = await req.rqPeople();
        const people = list.map(p => ({
          ...p,
          nameOnly: p.key.indexOf('n:') === 0,
          inSumStr: fmt.money(p.inSum),
          outSumStr: fmt.money(p.outSum),
          balanceStr: fmt.money(Math.abs(p.balance))
        }));
        this.setData({ people });
        this.filterPeople();
      } else {
        const res = await req.outList({ page: 1, pageSize: 50, keyword: this.data.keyword || undefined });
        this.setData({
          outList: res.list.map(g => ({ ...g, amountStr: fmt.money(g.amount), typeLabel: scenes.label(g.eventType) })),
          outSum: fmt.money(res.sum),
          outTotal: res.total
        });
      }
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  filterPeople() {
    const k = (this.data.keyword || '').trim();
    this.setData({ shownPeople: k ? this.data.people.filter(p => p.name.includes(k)) : this.data.people });
  },

  onTab(e) {
    this.setData({ tab: e.currentTarget.dataset.t });
    this.load();
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
    if (this.data.tab === 'people') this.filterPeople();
  },

  /** 搜索：名单里没有时也可直接查询该姓名 */
  onSearch() {
    const k = (this.data.keyword || '').trim();
    if (this.data.tab === 'out') return this.load();
    if (k && this.data.shownPeople.length === 0) this.openPerson('n:' + k);
  },

  onPerson(e) { this.openPerson(e.currentTarget.dataset.key); },

  /** key：o:微信身份:姓名 或 n:姓名（只输入姓名查询时） */
  openPerson(key) {
    wx.navigateTo({ url: `/pages/person/person?key=${encodeURIComponent(key)}` });
  },

  onAddGift() { wx.navigateTo({ url: '/pages/giftedit/giftedit' }); },

  onEditGift(e) {
    const g = this.data.outList[e.currentTarget.dataset.idx];
    // 扫码随礼自动记录的不可修改，点开看电子回执
    if (g.auto) return wx.navigateTo({ url: `/pages/receipt/receipt?rid=${g.rid}` });
    getApp().globalData.editGift = g;
    wx.navigateTo({ url: '/pages/giftedit/giftedit?edit=1' });
  },

  goLogin() { wx.switchTab({ url: '/pages/mine/mine' }); }
});
