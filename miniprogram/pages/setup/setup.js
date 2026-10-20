// pages/setup/setup.js — 主家创建向导：一页一步（主家称呼 → 收款码 → 第一本礼簿），完成后进工作台
// 主家信息要有收款码才能创建：收款码先跳过时只存本机草稿（utils/setup.js），首页显示进度卡片，补上后再创建
// 保存用现有接口：account.save 建主家信息，books.save 建第一本礼簿并设为当前
const req = require('../../utils/request.js');
const theme = require('../../utils/theme.js');
const scenes = require('../../utils/scenes.js');
const setup = require('../../utils/setup.js');
const fmt = require('../../utils/format.js');

const STEPS = ['主家称呼', '收款码', '第一本礼簿'];

Page({
  data: {
    step: 0,
    steps: STEPS,
    name: '',
    payCodeFileID: '',
    payCodeUrl: '',
    uploading: false,
    bookName: '',
    bookType: 'wedding',
    bookDate: '',
    bookLocation: '',
    today: '',
    scenes: scenes.SCENES.map(s => ({ type: s.type, label: s.label })),
    saving: false,
    themeStyle: ''
  },

  onLoad() {
    // 已有主家信息：不再走向导（避免覆盖已有的称呼和收款码）
    if (getApp().globalData.account && getApp().globalData.role === 'owner') return wx.switchTab({ url: '/pages/index/index' });
    // 接着上次的草稿：停在第一个没完成的步骤
    const d = setup.draft() || {};
    const p = setup.progress(d);
    const b = d.book || {};
    this.setData({
      today: fmt.day(new Date()),
      name: d.name || (getApp().globalData.user && getApp().globalData.user.nickname) || '',
      payCodeFileID: d.payCodeFileID || '',
      bookName: b.name || '',
      bookType: b.type || 'wedding',
      bookDate: b.date || '',
      bookLocation: b.location || '',
      step: !p.name ? 0 : (!p.code ? 1 : 2)
    });
    this._bookNameTouched = !!b.name;
    if (d.payCodeFileID) this.previewCode(d.payCodeFileID);
    setup.setIntent('host');
  },

  onShow() {
    theme.apply(this);
  },

  /** 草稿里的收款码：换成临时链接预览 */
  previewCode(fileID) {
    wx.cloud.getTempFileURL({
      fileList: [fileID],
      success: res => {
        const f = res.fileList[0];
        if (f && f.tempFileURL) this.setData({ payCodeUrl: f.tempFileURL });
        else this.setData({ payCodeFileID: '' }); // 文件已失效：重新上传
      },
      fail: () => {}
    });
  },

  saveDraft() {
    const d = this.data;
    setup.saveDraft({
      name: d.name.trim(),
      payCodeFileID: d.payCodeFileID,
      book: d.bookName.trim() ? { name: d.bookName.trim(), type: d.bookType, date: d.bookDate, location: d.bookLocation.trim() } : null
    });
  },

  // —— 第 1 步：主家称呼 ——
  onName(e) { this.setData({ name: e.detail.value }); },

  // —— 第 2 步：收款码 ——
  onChooseCode() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: res => {
        const tempPath = res.tempFiles[0].tempFilePath;
        this.setData({ payCodeUrl: tempPath, uploading: true });
        wx.cloud.uploadFile({
          cloudPath: `paycodes/${getApp().globalData.openid}-${Date.now()}.png`,
          filePath: tempPath,
          success: up => { this.setData({ payCodeFileID: up.fileID }); this.saveDraft(); },
          fail: () => {
            wx.showToast({ title: '上传失败', icon: 'none' });
            this.setData({ payCodeUrl: '', payCodeFileID: '' });
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

  // —— 第 3 步：第一本礼簿 ——
  onBookName(e) { this._bookNameTouched = true; this.setData({ bookName: e.detail.value }); },
  onBookType(e) {
    const t = e.currentTarget.dataset.t;
    this.setData({ bookType: t, ...(this._bookNameTouched ? {} : { bookName: this.defaultBookName(this.data.name.trim(), t) }) });
  },
  onBookDate(e) { this.setData({ bookDate: e.detail.value }); },
  onBookLocation(e) { this.setData({ bookLocation: e.detail.value }); },

  // —— 翻页 ——
  onPrev() {
    if (this.data.step > 0) this.setData({ step: this.data.step - 1 });
  },
  onNext() {
    const d = this.data;
    if (d.step === 0) {
      const name = d.name.trim();
      if (!name) return wx.showToast({ title: '请填写主家称呼', icon: 'none' });
      // 礼簿名称默认「称呼 + 事由」，没手动改过时跟着称呼变
      if (!this._bookNameTouched) this.setData({ bookName: this.defaultBookName(name, d.bookType) });
    }
    if (d.step === 1) {
      if (d.uploading) return wx.showToast({ title: '收款码上传中，请稍候', icon: 'none' });
      if (!d.payCodeFileID) return wx.showToast({ title: '请上传收款码，或点「先跳过」', icon: 'none' });
    }
    this.saveDraft();
    if (d.step < STEPS.length - 1) return this.setData({ step: d.step + 1 });
    this.onFinish();
  },
  /** 收款码先跳过：直接到下一步，完成时只存草稿 */
  onSkipCode() {
    if (!this._bookNameTouched) this.setData({ bookName: this.defaultBookName(this.data.name.trim(), this.data.bookType) });
    this.saveDraft();
    this.setData({ step: 2 });
  },
  /** 默认礼簿名称：称呼 + 事由，如「张三婚礼」 */
  defaultBookName(name, type) {
    const word = { wedding: '婚礼', birthday: '寿宴', baby: '满月酒', house: '乔迁宴', funeral: '白事', other: '礼簿' }[type] || '礼簿';
    return `${name || '我的'}${word}`.slice(0, 20);
  },

  async onFinish() {
    const d = this.data;
    if (d.saving) return;
    const bookName = d.bookName.trim();
    if (!bookName) return wx.showToast({ title: '请填写礼簿名称', icon: 'none' });
    this.saveDraft();
    if (!d.payCodeFileID) {
      // 没有收款码：先存草稿，回首页按进度卡片继续
      wx.showModal({
        title: '还差收款码',
        content: '主家称呼和礼簿已记下。上传微信收款码后才能生成礼簿码，可在首页「开始办事」卡片里继续。',
        showCancel: false,
        confirmText: '知道了',
        success: () => wx.switchTab({ url: '/pages/index/index' })
      });
      return;
    }
    this.setData({ saving: true });
    try {
      const { account } = await req.accountSave({
        accountName: d.name.trim(),
        payCodeFileID: d.payCodeFileID,
        theme: { name: bookName, primary: '#C8161D' },
        quickAmounts: [100, 200, 300, 500, 600, 800, 1000, 1500, 2000], // 默认快捷礼金，可在「主家信息」里修改
        confirmPayCode: true,
        own: true // 建本人自己的主家信息（记账人身份下也不会改到所记账的主家）
      });
      const app = getApp();
      if (app.globalData.role && app.globalData.role !== 'owner') app.resetIdentity(); // 已切换到自己的身份
      app.globalData.account = account;
      app.globalData.role = 'owner';
      theme.setAccount(account);
      await req.bookSave({ name: bookName, type: d.bookType, date: d.bookDate, location: d.bookLocation.trim(), setActive: true });
      setup.clearDraft();
      app.globalData.justSetup = true; // 工作台提示下一步：出示礼簿码
      require('../../utils/cache.js').clear();
      wx.switchTab({ url: '/pages/index/index' });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});
