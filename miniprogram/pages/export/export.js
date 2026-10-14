// pages/export/export.js — 礼簿导出：表格 PDF / Excel / 传统礼簿 PDF（按礼簿或日期范围）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const openfile = require('../../utils/openfile.js');

function presets() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const day = d => fmt.day(d);
  return [
    { key: 'today', label: '今日', start: day(now), end: day(now) },
    { key: 'month', label: '本月', start: day(new Date(y, m, 1)), end: day(now) },
    { key: 'last', label: '上月', start: day(new Date(y, m - 1, 1)), end: day(new Date(y, m, 0)) },
    { key: 'year', label: '今年', start: day(new Date(y, 0, 1)), end: day(now) }
  ];
}

Page({
  data: {
    presets: [],
    preset: 'month',
    startDay: '',
    endDay: '',
    today: '',
    books: [{ _id: '', name: '按日期范围导出' }],
    bookIdx: 0,
    exporting: ''   // '' | 'pdf' | 'xlsx' | 'book'
  },

  onLoad(options) {
    const list = presets();
    const month = list.find(p => p.key === 'month');
    this.setData({ presets: list, startDay: month.start, endDay: month.end, today: fmt.day(new Date()) });
    this.loadBooks(options.bookId || '');
  },

  /** 礼簿列表：选中某本礼簿时导出整本，不限日期 */
  async loadBooks(bookId) {
    try {
      const { list, activeBookId } = await req.bookList();
      const books = [{ _id: '', name: '按日期范围导出' }, ...list];
      const want = bookId || activeBookId;
      const idx = Math.max(0, books.findIndex(b => b._id === want));
      this.setData({ books, bookIdx: idx });
    } catch (e) { /* 礼簿可选，失败时按日期导出 */ }
  },

  onPreset(e) {
    const p = this.data.presets.find(x => x.key === e.currentTarget.dataset.k);
    this.setData({ preset: p.key, startDay: p.start, endDay: p.end });
  },

  onStart(e) { this.setData({ startDay: e.detail.value, preset: '' }); },
  onEnd(e) { this.setData({ endDay: e.detail.value, preset: '' }); },
  onBook(e) { this.setData({ bookIdx: Number(e.detail.value) }); },

  onExportPdf() { this.doExport('pdf'); },
  onExportXlsx() { this.doExport('xlsx'); },
  onExportBook() { this.doExport('book'); },
  onBackup() { this.doExport('backup'); },

  /** 云端生成文件 → 下载 → 打开预览（右上角可转发/保存） */
  async doExport(format) {
    if (this.data.exporting) return;
    const { startDay, endDay, books, bookIdx } = this.data;
    const bookId = books[bookIdx] ? books[bookIdx]._id : '';
    if (format === 'book' && !bookId) return wx.showToast({ title: '传统礼簿请选择一本礼簿整本导出', icon: 'none' });
    if (format !== 'backup' && !bookId && startDay > endDay) return wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });

    this.setData({ exporting: format });
    wx.showLoading({ title: '正在生成…', mask: true });
    try {
      const params = format === 'backup' ? { format } : (bookId ? { format, bookId } : { format, startDay, endDay });
      const res = await req.exportFile(params);
      const filePath = await openfile.download(res.fileID, res.fileName);
      // 已下载到本机，立即删除云端文件，避免礼金明细通过链接外泄
      req.exportCleanup(res.fileID).catch(() => {});
      wx.hideLoading();
      openfile.open(filePath, res.fileName);
    } catch (e) {
      wx.hideLoading();
      openfile.showError(e);
    } finally {
      this.setData({ exporting: '' });
    }
  }
});
