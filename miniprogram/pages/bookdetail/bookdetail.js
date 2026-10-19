// pages/bookdetail/bookdetail.js — 单本礼簿统计：合计、份数、按关系分组；可看明细、导出
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const openfile = require('../../utils/openfile.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');

Page({
  data: {
    id: '',
    book: null,
    typeLabel: '',
    sum: '0.00',
    count: 0,
    avg: '0.00',
    maxAmount: '0.00',
    byRelation: [],
    orgMode: false,
    readonly: true,   // 家人共享：只读（身份读取前先按只读显示）
    pm: {},           // 当前身份的权限：生成存档需「管理礼簿」，导出需「对账与导出」
    canExport: false, // 有导出权限（家人共享也可导出）
    loadError: false  // 加载失败：显示重试，不留空白页
  },

  async onLoad(options) {
    const app = getApp();
    this.setData({ id: options.id });
    const role = await app.ensureRole(); // 冷启动时 role 为空，先读取身份
    const acc = app.globalData.account;
    const pm = perm.current();
    this.setData({ orgMode: !!(acc && acc.orgMode) && role !== 'viewer', readonly: role === 'viewer', pm, canExport: pm.export || role === 'viewer' });
  },

  onShow() {
    theme.apply(this); // 主题色跟当前礼簿事由走
    this.load();
  },

  /** 加载失败后点击重试 */
  onRetry() {
    this.setData({ loadError: false });
    this.load();
  },

  async load() {
    try {
      const s = await req.bookStats(this.data.id);
      const total = s.sum || 0;
      this.setData({
        book: s.book,
        typeLabel: scenes.label(s.book.type),
        sum: fmt.money(total),
        count: s.count,
        avg: fmt.money(s.count ? total / s.count : 0),
        maxAmount: fmt.money(s.maxAmount),
        wechatSum: fmt.money(s.byMethod ? s.byMethod.wechat.sum : 0),
        wechatCount: s.byMethod ? s.byMethod.wechat.count : 0,
        cashSum: fmt.money(s.byMethod ? s.byMethod.cash.sum : 0),
        cashCount: s.byMethod ? s.byMethod.cash.count : 0,
        loadError: false,
        byRelation: s.byRelation.map(r => ({
          ...r,
          sumStr: fmt.money(r.sum),
          pct: total ? Math.round(r.sum / total * 100) : 0
        }))
      });
      wx.setNavigationBarTitle({ title: s.book.name });
    } catch (e) {
      // toast 已提示；还没有数据时显示重试
      if (!this.data.book) this.setData({ loadError: true });
    }
  },

  /** 礼簿页按本礼簿筛选 */
  /** 机构版：本场礼簿码（同一天多场同时办时，宾客扫哪场的码就记到哪场） */
  goBookQr() {
    wx.navigateTo({ url: `/pages/qrcode/qrcode?bookId=${this.data.id}` });
  },

  goRecords() {
    getApp().globalData.recordsBookId = this.data.id;
    wx.switchTab({ url: '/pages/records/records' });
  },

  /** 查看归档时生成的存档 PDF；没有则现在生成 */
  async onArchivePdf() {
    wx.showLoading({ title: '准备存档…', mask: true });
    try {
      let pdf = this.data.book.archivePdf;
      if (!pdf) {
        const r = await req.exportFile({ format: 'book', bookId: this.data.id, keep: true });
        pdf = { fileID: r.fileID, fileName: r.fileName };
        this.setData({ 'book.archivePdf': pdf });
      }
      const path = await openfile.download(pdf.fileID, pdf.fileName);
      wx.hideLoading();
      openfile.open(path, pdf.fileName);
    } catch (e) {
      wx.hideLoading();
      openfile.showError(e);
    }
  },

  goExport() {
    wx.navigateTo({ url: `/pages/export/export?bookId=${this.data.id}` });
  }
});
