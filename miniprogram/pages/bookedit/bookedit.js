// pages/bookedit/bookedit.js — 新建 / 编辑礼簿；事由类型变化时询问是否套用场景模板
const req = require('../../utils/request.js');
const scenes = require('../../utils/scenes.js');
const sceneApply = require('../../utils/sceneApply.js');
const printer = require('../../utils/printer.js');
const theme = require('../../utils/theme.js');

Page({
  data: {
    id: '',
    name: '',
    type: 'wedding',
    date: '',
    location: '',
    origType: '',
    scenes: scenes.SCENES.map(s => ({ type: s.type, label: s.label })),
    saving: false,
    orgMode: false,     // 机构模式：可设本场主家与收款码
    hostName: '',
    hasPayCode: false,  // 已设置本场收款码
    payCodePreview: '', // 本次新选的图片
    payCodeFileID: '',
    payCodeChanged: false,
    uploading: false
  },

  onShow() {
    theme.apply(this); // 主题色跟当前礼簿事由走
  },

  async onLoad(options) {
    const acc = getApp().globalData.account;
    this.setData({ orgMode: !!(acc && acc.orgMode) });
    if (!options.id) {
      wx.setNavigationBarTitle({ title: '新建礼簿' });
      return;
    }
    try {
      const { list } = await req.bookList();
      const b = list.find(x => x._id === options.id);
      if (b) this.setData({ id: b._id, name: b.name, type: b.type, date: b.date, location: b.location || '', origType: b.type, hostName: b.hostName || '', hasPayCode: !!b.hasPayCode });
    } catch (e) { /* toast 已提示 */ }
  },

  onName(e) { this.setData({ name: e.detail.value }); },
  onLocation(e) { this.setData({ location: e.detail.value }); },
  onDate(e) { this.setData({ date: e.detail.value }); },
  onType(e) { this.setData({ type: e.currentTarget.dataset.t }); },
  onHostName(e) { this.setData({ hostName: e.detail.value }); },

  /** 本场收款码：上传本场主家（如新郎家）的微信收款码 */
  onChoosePayCode() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: res => {
        const tempPath = res.tempFiles[0].tempFilePath;
        this.setData({ payCodePreview: tempPath, uploading: true });
        wx.cloud.uploadFile({
          cloudPath: `paycodes/book-${getApp().globalData.openid}-${Date.now()}.png`,
          filePath: tempPath,
          success: up => this.setData({ payCodeFileID: up.fileID, payCodeChanged: true }),
          fail: () => {
            wx.showToast({ title: '上传失败', icon: 'none' });
            this.setData({ payCodePreview: '' });
          },
          complete: () => this.setData({ uploading: false })
        });
      }
    });
  },
  onClearPayCode() {
    this.setData({ payCodePreview: '', payCodeFileID: '', payCodeChanged: true, hasPayCode: false });
  },

  async onSave() {
    if (this.data.saving) return;
    const name = (this.data.name || '').trim();
    if (!name) return wx.showToast({ title: '请填写礼簿名称', icon: 'none' });
    if (this.data.uploading) return wx.showToast({ title: '收款码上传中，请稍候', icon: 'none' });
    this.setData({ saving: true });
    try {
      const { id, type, date, location, origType, orgMode, hostName, payCodeChanged, payCodeFileID } = this.data;
      const org = orgMode ? { hostName: (hostName || '').trim(), ...(payCodeChanged ? { payCodeFileID } : {}) } : {};
      const { book, pendingPayCode } = await req.bookSave({ _id: id || undefined, name, type, date, location, ...org });
      printer.clearTemplateCache(); // 新建即设为当前礼簿 / 事由类型可能变化
      if (pendingPayCode) {
        // 记账人上传的本场收款码：主家确认采用后才生效
        await new Promise(resolve => wx.showModal({
          title: '收款码待主家确认', content: '礼簿已保存。新上传的本场收款码需主家在「主家信息」页确认采用后才生效。', showCancel: false, complete: resolve
        }));
      } else {
        wx.showToast({ title: id ? '已保存' : '已创建并设为当前', icon: 'success' });
      }
      // 未自定义样式的礼簿自动按事由类型显示；改了事由类型时询问是否重新套用
      if (id && type !== origType) await sceneApply.askApply(type, book._id);
      setTimeout(() => wx.navigateBack(), 300);
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});
