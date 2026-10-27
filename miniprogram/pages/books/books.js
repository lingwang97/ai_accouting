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
    const a = getApp().globalData.account;
    wx.setNavigationBarTitle({ title: a && a.orgMode ? '场次管理' : '礼簿管理' }); // 机构模式称「场次」
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
        isOwner: role === 'owner', // 删除礼簿只限主家本人
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
      const target = this.data.list.find(x => x._id === id);
      const ok = await require('../../utils/switchguard.js').confirmSwitch({
        orgMode: this.data.orgMode,
        fromName: this.data.current && this.data.current.name, toName: target && target.name
      });
      if (!ok) return;
      await req.bookSetActive(id);
      printer.clearTemplateCache(); // 当前礼簿变了，打印样式随之变化
      const b = this.data.list.find(x => x._id === id);
      if (b) this.setData({ iconKey: theme.apply(this, b.type).icon }); // 主题色跟新的当前礼簿走
      wx.showToast({ title: '已切换', icon: 'success' });
      this.load();
    } catch (err) { /* toast 已提示 */ }
  },

  /** 导出：选格式 → 云端生成 → 下载打开（右上角可转发 / 保存） */
  onExport(e) {
    const bookId = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: EXPORTS.map(x => x.label),
      success: res => {
        const format = EXPORTS[res.tapIndex].format;
        // 传统礼簿 PDF 先去选主题，确认后再导出；表格 PDF / Excel 直接导出
        if (format === 'book') wx.navigateTo({ url: `/pages/booktheme/booktheme?bookId=${bookId}` });
        else this.doExport(format, bookId);
      }
    });
  },

  async doExport(format, bookId) {
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    wx.showLoading({ title: '约需半分钟…', mask: true }); // 导出一般 10～30 秒，礼金多时接近 1 分钟（v3.65.2 提示预计时间）
    try {
      const res = await req.exportFile({ format, bookId });
      const filePath = await openfile.download(res.fileID, res.fileName);
      // 已下载到本机，立即删除云端文件，避免礼金明细通过链接外泄
      req.exportCleanup(res.fileID).catch(() => {});
      wx.hideLoading();
      await openfile.notice(res);
      openfile.open(filePath, res.fileName);
    } catch (err) {
      wx.hideLoading();
      openfile.showError(err);
    } finally {
      this.setData({ exporting: false });
    }
  },

  // —— 删除礼簿（只能删已归档的）：说明份数与合计 → 移入回收站，保留期内（默认 15 天，可在高级功能修改）可在「我的 → 回收站」恢复 ——
  async onDelete(e) {
    const id = e.currentTarget.dataset.id;
    let pv;
    try { pv = await req.bookRemovePreview(id); } catch (err) { return; }
    const more = pv.total > pv.count ? `（另有 ${pv.total - pv.count} 条未入簿的登记）` : '';
    const who = pv.affected && pv.affected.length ? `记账人「${pv.affected.join('、')}」只负责这本，删除后需重新安排。` : '';
    wx.showModal({
      title: '删除礼簿',
      content: `「${pv.name}」共 ${pv.count} 份已入簿礼金，合计 ￥${fmt.money(pv.sum)}${more}。删除后移入「我的 → 回收站」，${pv.days} 天内可以恢复，之后永久删除。${who}`,
      confirmText: '删除',
      confirmColor: '#FA5151',
      success: res => { if (res.confirm) this.doDelete(id, pv); }
    });
  },
  /** 数据多时分批移动：云函数返回 done=false 就接着调用 */
  async doDelete(id, pv) {
    wx.showLoading({ title: '正在删除…', mask: true });
    try {
      let r;
      for (let i = 0; i < 50; i++) {
        r = await req.bookRemove(id);
        if (r.done) break;
      }
      wx.hideLoading();
      this.load();
      if (!(r && r.done)) {
        // 数据特别多、循环次数用完仍未移完：不提示成功（再点一次删除会接着移，系统也会在后台自动续上）
        return wx.showModal({ title: '删除未完成', content: '礼金记录较多，还没有全部移完，请稍后再点一次删除继续。', showCancel: false });
      }
      wx.showToast({ title: '已移入回收站', icon: 'none' });
      const names = (r && r.affected) || [];
      if (names.length) {
        setTimeout(() => wx.showModal({
          title: '记账人需要重新安排',
          content: `「${names.join('、')}」只负责被删除的礼簿，现在不能登记。可在「我的 → 记账人」里给他们换一本。`,
          confirmText: '去设置',
          success: m2 => { if (m2.confirm) wx.navigateTo({ url: '/pages/members/members' }); }
        }), 1500);
      }
    } catch (err) {
      wx.hideLoading(); // request.js 已提示；没删完的再点一次删除会接着进行
    }
  },

  onArchive(e) {
    const { id, archived } = e.currentTarget.dataset;
    const toArchive = !archived;
    wx.showModal({
      title: toArchive ? '归档礼簿' : '取消归档',
      content: toArchive ? '归档后不再接收随礼，礼金记录仍可查询和导出' : '恢复为可用礼簿？已生成的存档 PDF 会删除，重新归档时自动生成新的',
      success: async res => {
        if (!res.confirm) return;
        try {
          const r = await req.bookArchive(id, toArchive);
          if (toArchive) {
            // 归档时自动生成传统礼簿 PDF 存档（长期保留，可在礼簿统计页查看）
            // 没有「对账与导出」权限的记账人不生成存档（由主家或有权限的人在礼簿详情里补生成）
            if (!(this.data.pm && this.data.pm.export)) {
              wx.showToast({ title: '已归档', icon: 'success' });
            } else {
              wx.showLoading({ title: '生成存档 PDF…', mask: true });
              try {
                await req.exportFile({ format: 'book', bookId: id, keep: true });
                wx.hideLoading();
                wx.showToast({ title: '已归档并存档', icon: 'success' });
              } catch (e) {
                wx.hideLoading(); // 无礼金等，request.js 已提示
              }
            }
            // 只负责这一本的记账人：之后没有礼簿可记，提醒主家重新安排
            const names = (r && r.affected) || [];
            if (names.length) {
              await new Promise(resolve => setTimeout(resolve, 1200));
              wx.showModal({
                title: '记账人需要重新安排',
                content: `「${names.join('、')}」只负责这本礼簿，归档后不能再登记。可在「我的 → 记账人」里给他们换一本。`,
                confirmText: '去设置',
                success: m2 => { if (m2.confirm) wx.navigateTo({ url: '/pages/members/members' }); }
              });
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
