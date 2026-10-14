// pages/books/books.js — 礼簿管理：多本礼簿（婚礼、满月、乔迁……），切换当前礼簿、归档
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const printer = require('../../utils/printer.js');

Page({
  data: {
    activeBookId: '',
    list: [],
    archived: [],
    showArchived: false,
    loading: true
  },

  onShow() { this.load(); },

  async load() {
    try {
      const { list, activeBookId } = await req.bookList();
      const all = list.map(b => ({
        ...b,
        typeLabel: scenes.label(b.type),
        sumStr: fmt.money(b.sum)
      }));
      this.setData({
        activeBookId,
        list: all.filter(b => !b.archived),
        archived: all.filter(b => b.archived)
      });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  onAdd() { wx.navigateTo({ url: '/pages/bookedit/bookedit' }); },

  onEdit(e) {
    wx.navigateTo({ url: `/pages/bookedit/bookedit?id=${e.currentTarget.dataset.id}` });
  },

  onDetail(e) {
    wx.navigateTo({ url: `/pages/bookdetail/bookdetail?id=${e.currentTarget.dataset.id}` });
  },

  async onSetActive(e) {
    try {
      await req.bookSetActive(e.currentTarget.dataset.id);
      printer.clearTemplateCache(); // 当前礼簿变了，打印样式随之变化
      wx.showToast({ title: '已设为当前礼簿', icon: 'success' });
      this.load();
    } catch (err) { /* toast 已提示 */ }
  },

  onArchive(e) {
    const { id, archived } = e.currentTarget.dataset;
    const toArchive = !archived;
    wx.showModal({
      title: toArchive ? '归档礼簿' : '取消归档',
      content: toArchive ? '归档后不再接收随礼，礼金记录仍可查询和导出' : '恢复为可用礼簿？',
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.bookArchive(id, toArchive);
          if (toArchive) {
            // 归档时自动生成传统礼簿 PDF 存档（长期保留，可在礼簿统计页查看）
            wx.showLoading({ title: '生成存档 PDF…', mask: true });
            try {
              await req.exportFile({ format: 'book', bookId: id, keep: true });
              wx.hideLoading();
              wx.showToast({ title: '已归档并存档', icon: 'success' });
            } catch (e) {
              wx.hideLoading(); // 无礼金等，request.js 已提示
            }
          }
          this.load();
        } catch (err) { /* toast 已提示 */ }
      }
    });
  },

  onToggleArchived() { this.setData({ showArchived: !this.data.showArchived }); }
});
