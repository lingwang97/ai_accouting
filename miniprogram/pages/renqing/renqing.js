// pages/renqing/renqing.js — 人情往来：收礼往来（按人：收/送对比，可筛待回礼、多送；按笔：收到的每一笔）+ 送出的礼 + 随礼回执（扫码随礼后主家确认的电子回执）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const theme = require('../../utils/theme.js');
const samename = require('../../utils/samename.js');

Page({
  data: {
    tab: 'people',     // 收礼往来（people 按人 | in 按笔）| out 送出的礼 | receipts 随礼回执
    pFilter: 'all',    // 按人筛选：all 全部 | owe 待回礼 | given 多送
    pFilters: [{ v: 'all', t: '全部' }, { v: 'owe', t: '待回礼' }, { v: 'given', t: '多送' }],
    inList: [],        // 按笔：收到的每一笔（分页）
    inSum: '0.00',
    inTotal: 0,
    inPage: 1,
    reminds: [],       // 亲友办事提醒（未处理，最近的在前）
    remindAll: false,  // 展开全部提醒
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

  async onShow() {
    // 已退出登录：立即清空上一个账户的往来（不等登录状态恢复，也不再查询身份）
    if (getApp().isLoggedOut()) {
      getApp().refreshTabBar();
      return this.setData({ loggedIn: false, people: [], shownPeople: [], outList: [], inList: [], receipts: [], shownReceipts: [], reminds: [] });
    }
    // 记账人身份不显示「往来」（切换身份后可能停留在本页）：回到工作台
    if ((await getApp().ensureRole()) === 'clerk') return wx.switchTab({ url: '/pages/index/index' });
    theme.apply(this); // 主题色跟当前礼簿事由走
    getApp().refreshTabBar();
    getApp().refreshBadge();
    this.load();
    // 办事提醒只在进入页面时刷新，切换标签不重复请求
    getApp().loginReady.then(() => { if (getApp().globalData.user) this.loadReminds(); });
  },

  async load() {
    await getApp().loginReady;
    if (!getApp().globalData.user) {
      return this.setData({ loggedIn: false, people: [], shownPeople: [], outList: [], inList: [], receipts: [], shownReceipts: [], reminds: [] });
    }
    this.setData({ loading: true, loggedIn: true });
    try {
      if (this.data.tab === 'people') {
        const { list } = await req.rqPeople();
        const people = list.map(p => ({
          ...p,
          nameOnly: p.key.indexOf('n:') === 0,
          label: p.label || p.name,
          inSumStr: fmt.money(p.inSum),
          outSumStr: fmt.money(p.outSum),
          balanceStr: fmt.money(Math.abs(p.balance))
        }));
        this.setData({ people });
        this.filterPeople();
      } else if (this.data.tab === 'in') {
        await this.loadIn(1);
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
    const f = this.data.pFilter;
    this.setData({
      shownPeople: this.data.people.filter(p => (!k || p.label.includes(k)) &&
        (f === 'all' || (f === 'owe' ? p.balance > 0 : p.balance < 0)))
    });
  },
  onPFilter(e) {
    this.setData({ pFilter: e.currentTarget.dataset.v });
    this.filterPeople();
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

  /** 切换页签；「收礼往来」回到上次看的按人 / 按笔 */
  onTab(e) {
    let t = e.currentTarget.dataset.t;
    if (t === 'recv') t = this._recvView || 'people';
    if (t === 'people' || t === 'in') this._recvView = t;
    if (t === this.data.tab) return;
    this.setData({ tab: t });
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
    if (this.data.tab === 'out' || this.data.tab === 'in') return this.load();
    if (this.data.tab === 'receipts') return this.filterReceipts();
    if (k && this.data.shownPeople.length === 0) this.openPerson('n:' + k);
  },

  onPerson(e) { this.openPerson(e.currentTarget.dataset.key); },

  // —— 亲友办事提醒 ——
  async loadReminds() {
    try {
      const { list } = await req.remindList();
      const today = fmt.day(new Date());
      const dayDiff = d => Math.round((new Date(d + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
      this.setData({
        reminds: list.map(r => {
          const n = dayDiff(r.date);
          return {
            ...r,
            typeLabel: scenes.label(r.eventType),
            dateStr: r.date.slice(5).replace('-', '月') + '日',
            leftStr: n > 0 ? `还有 ${n} 天` : (n === 0 ? '今天' : `已过 ${-n} 天`),
            // 提醒时间（旧版提醒没有具体时间，按提醒日 9:00）
            remindStr: r.remindStr ? `${r.remindStr.slice(5, 7)}月${r.remindStr.slice(8, 10)}日 ${r.remindStr.slice(11)}` : '',
            hot: n >= 0 && Date.now() >= (r.remindAt ? new Date(r.remindAt).getTime() : new Date(`${r.notifyDay || r.date}T09:00:00`).getTime()), // 已到提醒时间
            past: n < 0
          };
        })
      });
    } catch (e) { /* 静默 */ }
  },
  onRemindAll() { this.setData({ remindAll: !this.data.remindAll }); },
  onAddRemind() { wx.navigateTo({ url: '/pages/remind/remind' }); },
  onInRemind(e) {
    const { name, amount } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/remind/remind?name=${encodeURIComponent(name)}&note=${encodeURIComponent(`曾随我 ￥${amount}`)}` });
  },
  onRemind(e) {
    const r = this.data.reminds[e.currentTarget.dataset.idx];
    if (!r) return;
    wx.showActionSheet({
      itemList: ['记回礼', '已处理', '修改', '删除'],
      success: async res => {
        try {
          if (res.tapIndex === 0) {
            wx.navigateTo({
              url: `/pages/giftedit/giftedit?toName=${encodeURIComponent(r.name)}&toKey=${encodeURIComponent(r.personKey || '')}&eventType=${r.eventType}&event=${encodeURIComponent(r.event || '')}`
            });
            await req.remindDone(r._id, true);
          } else if (res.tapIndex === 1) {
            await req.remindDone(r._id, true);
            wx.showToast({ title: '已处理', icon: 'success' });
          } else if (res.tapIndex === 2) {
            getApp().globalData.editRemind = r;
            return wx.navigateTo({ url: '/pages/remind/remind?edit=1' });
          } else {
            await req.remindDelete(r._id);
          }
          this.loadReminds();
        } catch (err) { /* toast 已提示 */ }
      }
    });
  },

  /** 按笔：收到的每一笔，按页加载（page=1 重新加载），可按姓名搜索 */
  async loadIn(page) {
    const res = await req.inList({ page, pageSize: 30, keyword: (this.data.keyword || '').trim() || undefined });
    const rows = res.list.map(r => ({
      ...r,
      amountStr: fmt.money(r.amount),
      typeLabel: scenes.label(r.bookType),
      methodStr: r.payMethod === 'cash' ? '现金' : '微信',
      nameStr: samename.nameStr(r.payerName, r.nameTag),
      // 往来人：有区分备注按 n:姓名#备注，否则按姓名（唯一同名时服务端直接返回该宾客）
      personKey: r.key || ('n:' + r.payerName + (r.nameTag ? '#' + r.nameTag : '')) // 服务端算好的往来人 key
    }));
    const patch = { inPage: page, inTotal: res.total, inSum: fmt.money(res.sum) };
    if (page === 1) patch.inList = rows;
    else {
      // 加载更多：按下标追加，不重传整张列表
      const start = this.data.inList.length;
      rows.forEach((r, i) => { patch[`inList[${start + i}]`] = r; });
    }
    this.setData(patch);
  },
  onInMore() {
    if (this.data.inList.length < this.data.inTotal) this.loadIn(this.data.inPage + 1).catch(() => {});
  },
  onInPerson(e) { this.openPerson(e.currentTarget.dataset.key); },

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
