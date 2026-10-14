// pages/bookdetail/bookdetail.js — 单本礼簿统计：合计、份数、按关系分组；可看明细、导出
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const openfile = require('../../utils/openfile.js');

Page({
  data: {
    id: '',
    book: null,
    typeLabel: '',
    sum: '0.00',
    count: 0,
    avg: '0.00',
    maxAmount: '0.00',
    byRelation: []
  },

  onLoad(options) {
    this.setData({ id: options.id });
  },

  async onShow() {
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
        byRelation: s.byRelation.map(r => ({
          ...r,
          sumStr: fmt.money(r.sum),
          pct: total ? Math.round(r.sum / total * 100) : 0
        }))
      });
      wx.setNavigationBarTitle({ title: s.book.name });
    } catch (e) { /* toast 已提示 */ }
  },

  /** 礼簿页按本礼簿筛选 */
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
