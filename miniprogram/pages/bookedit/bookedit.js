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
    uploading: false,
    recalcing: false,
    loadFailed: false // 编辑时加载失败：禁止保存，避免被当成新建
  },

  onShow() {
    theme.apply(this); // 主题色跟当前礼簿事由走
  },

  async onLoad(options) {
    this._editId = options.id || '';
    const acc = getApp().globalData.account;
    this.setData({ orgMode: !!(acc && acc.orgMode) });
    if (!options.id) {
      wx.setNavigationBarTitle({ title: '新建礼簿' });
      return;
    }
    try {
      const { list } = await req.bookList();
      const b = list.find(x => x._id === options.id);
      if (!b) throw new Error('礼簿不存在');
      this.setData({ loadFailed: false, id: b._id, name: b.name, type: b.type, date: b.date, location: b.location || '', origType: b.type, hostName: b.hostName || '', hasPayCode: !!b.hasPayCode });
    } catch (e) {
      this.setData({ loadFailed: true });
    }
  },
  onRetryLoad() { this.onLoad({ id: this._editId }); },

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
      },
      fail: err => {
        if (String((err && err.errMsg) || '').includes('cancel')) return; // 用户取消
        wx.showToast({ title: '无法选择图片', icon: 'none' });
      }
    });
  },
  onClearPayCode() {
    this.setData({ payCodePreview: '', payCodeFileID: '', payCodeChanged: true, hasPayCode: false });
  },

  /** 新建礼簿是否设为当前：返回 true / false，取消返回 null */
  async askSetActive(newName) {
    const r = await this.askSetActiveBase();
    if (r !== true) return r;
    const app = getApp();
    const a = app.globalData.account || {};
    if (a.orgMode) return true;
    let fromName = '';
    try {
      const { list, activeBookId } = await req.bookList();
      const cur = activeBookId && (list || []).find(b => b._id === activeBookId);
      fromName = cur ? cur.name : '';
    } catch (e) { return null; }
    const ok = await require('../../utils/switchguard.js').confirmSwitch({ orgMode: false, fromName, toName: newName });
    return ok ? true : null;
  },
  askSetActiveBase() {
    const app = getApp();
    const a = app.globalData.account || {};
    const clerkOrg = app.globalData.role === 'clerk' && a.orgMode;
    return new Promise(resolve => wx.showModal({
      title: '设为当前礼簿？',
      content: clerkOrg
        ? '设为你现在记的一场：工作台、礼台记账、出示礼簿码都用这一本（不影响主家和其他人）。'
        : '设为当前后，宾客扫主礼簿码随礼的礼金会记到这本新礼簿。正在办的这一场还没结束时，请选「暂不」。',
      confirmText: '设为当前',
      cancelText: '暂不',
      success: r => resolve(r.confirm ? true : (r.cancel ? false : null)),
      fail: () => resolve(null)
    }));
  },

  /** 重算合计：需「管理礼簿」权限（服务端同样校验），先二次确认 */
  onRecalc() {
    if (this.data.recalcing || !this.data.id) return;
    wx.showModal({
      title: '重算合计',
      content: '将按这本礼簿全部已入簿的记录重新计算份数与合计，不会修改任何礼金记录。确定重算吗？',
      confirmText: '重算',
      success: async r => {
        if (!r.confirm) return;
        this.setData({ recalcing: true });
        try {
          const res = await req.bookRecalc(this.data.id);
          wx.showToast({ title: `已重算：${res.count} 份`, icon: 'none' });
        } catch (e) { /* toast 已提示 */ } finally {
          this.setData({ recalcing: false });
        }
      }
    });
  },

  async onSave() {
    if (this.data.saving || this.data.loadFailed) return;
    const name = (this.data.name || '').trim();
    if (!name) return wx.showToast({ title: '请填写礼簿名称', icon: 'none' });
    if (this.data.uploading) return wx.showToast({ title: '收款码上传中，请稍候', icon: 'none' });
    this.setData({ saving: true });
    try {
      const { id, type, date, location, origType, orgMode, hostName, payCodeChanged, payCodeFileID } = this.data;
      const org = orgMode ? { hostName: (hostName || '').trim(), ...(payCodeChanged ? { payCodeFileID } : {}) } : {};
      // 新建：询问是否设为当前（设为当前后，宾客扫主礼簿码的礼金会记到这本）
      const setActive = id ? undefined : await this.askSetActive(name);
      if (setActive === null) return;
      const { book, pendingPayCode } = await req.bookSave({ _id: id || undefined, name, type, date, location, setActive, ...org });
      printer.clearTemplateCache(); // 新建即设为当前礼簿 / 事由类型可能变化
      if (pendingPayCode) {
        // 记账人上传的本场收款码：主家确认采用后才生效
        await new Promise(resolve => wx.showModal({
          title: '收款码待主家确认', content: '礼簿已保存，新收款码待主家确认后生效', showCancel: false, complete: resolve
        }));
      } else {
        wx.showToast({ title: id ? '已保存' : '已创建', icon: 'success' });
      }
      // 未自定义样式的礼簿自动按事由类型显示；改了事由类型时询问是否重新套用
      if (id && type !== origType) await sceneApply.askApply(type, book._id);
      setTimeout(() => wx.navigateBack(), 300);
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});
