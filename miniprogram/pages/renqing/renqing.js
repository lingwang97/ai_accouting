// pages/renqing/renqing.js — 人情往来：往来名单（收/送汇总）+ 我送出的礼 + 随礼回执（扫码随礼后主家确认的电子回执）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const theme = require('../../utils/theme.js');

Page({
  data: {
    tab: 'people',     // people | out | receipts
    receipts: [],      // 随礼回执
    shownReceipts: [],
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
    theme.apply(this); // 主题色跟当前礼簿事由走
    getApp().refreshTabBar();
    getApp().refreshBadge();
    this.load();
  },

  async load() {
    await getApp().loginReady;
    if (!getApp().globalData.user) {
      return this.setData({ loggedIn: false, people: [], shownPeople: [], outList: [] });
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
      } else if (this.data.tab === 'receipts') {
        const { list } = await req.myReceipts();
        this.setData({
          receipts: list.map(r => ({ ...r, amountStr: fmt.money(r.amount), timeStr: fmt.dateTime(r.paidAt || r.createdAt) }))
        });
        this.filterReceipts();
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

  /** 随礼回执按主家 / 随礼人 / 礼簿名筛选 */
  filterReceipts() {
    const k = (this.data.keyword || '').trim();
    const all = this.data.receipts;
    this.setData({
      shownReceipts: k ? all.filter(r => [r.accountName, r.payerName, r.themeName].some(x => (x || '').includes(k))) : all
    });
  },

  onOpenReceipt(e) {
    wx.navigateTo({ url: `/pages/receipt/receipt?rid=${e.currentTarget.dataset.id}` });
  },

  onTab(e) {
    this.setData({ tab: e.currentTarget.dataset.t });
    this.load();
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
    if (this.data.tab === 'people') this.filterPeople();
    if (this.data.tab === 'receipts') this.filterReceipts();
  },

  /** 搜索：名单里没有时也可直接查询该姓名 */
  onSearch() {
    const k = (this.data.keyword || '').trim();
    if (this.data.tab === 'out') return this.load();
    if (this.data.tab === 'receipts') return this.filterReceipts();
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

  /** 转发给好友 / 分享到朋友圈：落地首页（宾客扫码随礼，主家创建礼簿） */
  onShareAppMessage() {
    return { title: '慧礼记｜扫码随礼、自动记账、人情往来一本清', path: '/pages/index/index' };
  },
  onShareTimeline() {
    return { title: '慧礼记｜办事收礼，扫码随礼自动记账' };
  },

  goLogin() { wx.switchTab({ url: '/pages/mine/mine' }); }
});
