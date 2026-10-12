// pages/export/export.js — 账目导出 PDF / Excel（按日期范围 + 记账主题）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');

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
    themes: ['全部主题'],
    themeIdx: 0,
    exporting: ''   // '' | 'pdf' | 'xlsx'
  },

  onLoad() {
    const list = presets();
    const month = list.find(p => p.key === 'month');
    this.setData({ presets: list, startDay: month.start, endDay: month.end, today: fmt.day(new Date()) });
    this.loadThemes();
  },

  async loadThemes() {
    try {
      const { list } = await req.recordThemes();
      this.setData({ themes: ['全部主题', ...list] });
    } catch (e) { /* 主题筛选可选，失败不影响导出 */ }
  },

  onPreset(e) {
    const p = this.data.presets.find(x => x.key === e.currentTarget.dataset.k);
    this.setData({ preset: p.key, startDay: p.start, endDay: p.end });
  },

  onStart(e) { this.setData({ startDay: e.detail.value, preset: '' }); },
  onEnd(e) { this.setData({ endDay: e.detail.value, preset: '' }); },
  onTheme(e) { this.setData({ themeIdx: Number(e.detail.value) }); },

  onExportPdf() { this.doExport('pdf'); },
  onExportXlsx() { this.doExport('xlsx'); },

  /** 云端生成文件 → 下载 → 打开预览（右上角可转发/保存） */
  async doExport(format) {
    if (this.data.exporting) return;
    const { startDay, endDay, themes, themeIdx } = this.data;
    if (startDay > endDay) return wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });

    this.setData({ exporting: format });
    wx.showLoading({ title: '正在生成…', mask: true });
    try {
      const res = await req.exportFile({
        format, startDay, endDay,
        themeName: themeIdx > 0 ? themes[themeIdx] : ''
      });
      const filePath = await this.download(res.fileID, res.fileName);
      wx.hideLoading();
      wx.openDocument({
        filePath,
        fileType: format,
        showMenu: true,   // 右上角菜单可转发给好友/文件传输助手
        fail: () => wx.showModal({ title: '提示', content: '文件已生成，但当前设备无法预览', showCancel: false })
      });
    } catch (e) {
      wx.hideLoading(); // 业务错误 request.js 已 toast
    } finally {
      this.setData({ exporting: '' });
    }
  },

  /** 云存储文件下载到本地，并以可读文件名保存（转发时显示该名称） */
  download(fileID, fileName) {
    return new Promise((resolve, reject) => {
      wx.cloud.downloadFile({
        fileID,
        success: res => {
          const target = `${wx.env.USER_DATA_PATH}/${fileName}`;
          wx.getFileSystemManager().saveFile({
            tempFilePath: res.tempFilePath,
            filePath: target,
            success: () => resolve(target),
            fail: () => resolve(res.tempFilePath) // 存储空间不足等，退回临时路径
          });
        },
        fail: () => {
          wx.showToast({ title: '下载失败，请重试', icon: 'none' });
          reject(new Error('download failed'));
        }
      });
    });
  }
});
