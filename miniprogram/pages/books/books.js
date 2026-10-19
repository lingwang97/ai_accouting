// pages/books/books.js — 礼簿管理：当前礼簿 + 其他礼簿（切换、编辑、统计、导出、归档）
// 导出直接在这里选格式生成并打开；按日期范围导出与一键备份在「我的 → 导出与备份」
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const printer = require('../../utils/printer.js');
const theme = require('../../utils/theme.js');
const openfile = require('../../utils/openfile.js');
const perm = require('../../utils/perm.js');

const EXPORTS = [
  { format: 'book', label: '传统礼簿 PDF（竖排，整本）' },
  { format: 'pdf', label: '表格 PDF' },
  { format: 'xlsx', label: 'Excel 表格' }
];

Page({
  data: {
    activeBookId: '',
    current: null,     // 当前礼簿
    list: [],          // 其他未归档礼簿
    archived: [],
    showArchived: false,
    restricted: false, // 只能看到部分礼簿（数据范围受限）：不能新建礼簿
    pm: {},            // 当前身份的权限：管理礼簿 / 导出 / 礼簿共享（邀请与管理）按权限显示
    canExport: false,  // 有导出权限（家人共享也可导出）
    orgMode: false,
    exporting: false,
    iconKey: 'r',      // 描边按钮图标颜色跟主题色
    loading: true,
    themeStyle: ''
  },

  onShow() {
    this.setData({ iconKey: theme.apply(this).icon }); // 主题色跟当前礼簿事由走
    this.load();
  },

  async load() {
    try {
      const [{ list, activeBookId, restricted, perms }, role] = await Promise.all([req.bookList(), getApp().ensureRole()]);
      const acc = getApp().globalData.account;
      const pm = perm.map(perms, role);
      const all = list.map(b => ({
        ...b,
        typeLabel: scenes.label(b.type),
        sumStr: fmt.money(b.sum),
        title: b.hostName ? `${b.hostName} · ${b.name}` : b.name
      }));
      this.setData({
        activeBookId,
        restricted: !!restricted,
        pm,
        canExport: pm.export || role === 'viewer',
        orgMode: !!(acc && acc.orgMode),
        current: all.find(b => b._id === activeBookId) || null,
        list: all.filter(b => !b.archived && b._id !== activeBookId),
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
      const id = e.currentTarget.dataset.id;
      await req.bookSetActive(id);
      printer.clearTemplateCache(); // 当前礼簿变了，打印样式随之变化
      const b = this.data.list.find(x => x._id === id);
      if (b) this.setData({ iconKey: theme.apply(this, b.type).icon }); // 主题色跟新的当前礼簿走
      wx.showToast({ title: '已设为当前礼簿', icon: 'success' });
      this.load();
    } catch (err) { /* toast 已提示 */ }
  },

  /** 导出：选格式 → 云端生成 → 下载打开（右上角可转发 / 保存） */
  onExport(e) {
    const bookId = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: EXPORTS.map(x => x.label),
      success: res => this.doExport(EXPORTS[res.tapIndex].format, bookId)
    });
  },

  async doExport(format, bookId) {
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    wx.showLoading({ title: '正在生成…', mask: true });
    try {
      const res = await req.exportFile({ format, bookId });
      const filePath = await openfile.download(res.fileID, res.fileName);
      // 已下载到本机，立即删除云端文件，避免礼金明细通过链接外泄
      req.exportCleanup(res.fileID).catch(() => {});
      wx.hideLoading();
      openfile.open(filePath, res.fileName);
    } catch (err) {
      wx.hideLoading();
      openfile.showError(err);
    } finally {
      this.setData({ exporting: false });
    }
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

  onToggleArchived() { this.setData({ showArchived: !this.data.showArchived }); },

  goExportMore() { wx.navigateTo({ url: '/pages/export/export' }); },
  goShare() { wx.navigateTo({ url: '/pages/bookshare/bookshare' }); }
});
