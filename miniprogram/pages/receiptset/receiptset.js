// pages/receiptset/receiptset.js — 电子回执样式（按礼簿设置，宾客留存，UI 自定义，实时预览）
const req = require('../../utils/request.js');
const receipt = require('../../utils/receipt.js');
const scenes = require('../../utils/scenes.js');
const printer = require('../../utils/printer.js');
const theme = require('../../utils/theme.js');

const COLORS = ['#C8161D', '#B8860B', '#C9A227', '#FF7A45', '#07C160', '#333333'];
const ALL_FIELDS = Object.keys(receipt.FIELD_LABELS);

Page({
  data: {
    tpl: receipt.DEFAULT_TPL,
    colors: COLORS,
    styles: receipt.STYLES,
    scenes: scenes.SCENES.map(s => ({ type: s.type, label: s.label })),
    sceneType: '',      // 本次套用的场景（保存时同步到打印模板）
    fieldItems: [],     // 已启用 [{f,label}]
    disabledItems: [],  // 可添加
    model: null,
    accountName: '',
    books: [],
    bookIdx: 0,
    saving: false
  },

  onShow() {
    this.setData({ primary: theme.apply(this).primary }); // 主题色跟当前礼簿事由走
  },

  async onLoad(options) {
    try {
      const [{ account }, { list, activeBookId }] = await Promise.all([req.accountGet(), req.bookList()]);
      const books = list.filter(b => !b.archived || b._id === activeBookId);
      const want = options.bookId || activeBookId; // 从「打印小票」切换过来时沿用所选礼簿
      this.setData({
        accountName: (account && account.accountName) || receipt.SAMPLE.accountName,
        books,
        bookIdx: Math.max(0, books.findIndex(b => b._id === want))
      });
      await this.loadTpl();
    } catch (e) {
      this.update(receipt.normalizeTpl(null));
    }
  },

  /** 读取所选礼簿的样式；未自定义时按事由类型显示场景默认 */
  async loadTpl() {
    const book = this.data.books[this.data.bookIdx];
    if (!book) return;
    const r = await req.bookGetTpl(book._id);
    this.setData({ sceneType: '', tpl: receipt.DEFAULT_TPL });
    this.update(receipt.normalizeTpl(r.receiptTpl, book.type));
  },

  /** 切到「打印小票」 */
  onStyleTab(e) {
    if (e.currentTarget.dataset.t !== 'print') return;
    const b = this.data.books[this.data.bookIdx];
    wx.redirectTo({ url: '/pages/printset/printset' + (b ? '?bookId=' + b._id : '') });
  },

  onBook(e) {
    this.setData({ bookIdx: Number(e.detail.value) });
    this.loadTpl();
  },

  /** 改模板并刷新字段列表与预览 */
  update(patch) {
    const tpl = { ...this.data.tpl, ...patch };
    this.setData({
      tpl,
      fieldItems: tpl.fields.map(f => ({ f, label: receipt.FIELD_LABELS[f] })),
      disabledItems: ALL_FIELDS.filter(f => !tpl.fields.includes(f)).map(f => ({ f, label: receipt.FIELD_LABELS[f] })),
      model: receipt.buildModel(this.sampleRecord(), tpl, this.data.accountName)
    });
  },

  /** 预览用示例：事由与类型取所选礼簿 */
  sampleRecord() {
    const book = this.data.books[this.data.bookIdx];
    return book ? { ...receipt.SAMPLE.record, themeName: book.name, bookType: book.type } : receipt.SAMPLE.record;
  },

  onTitle(e) { this.update({ title: e.detail.value }); },
  onFooter(e) { this.update({ footer: e.detail.value }); },
  onColor(e) { this.update({ color: e.currentTarget.dataset.c }); },
  onStyle(e) { this.update({ style: e.currentTarget.dataset.v }); },
  onStamp(e) { this.update({ showStamp: e.detail.value }); },
  onStampText(e) { this.update({ stamp: e.detail.value }); },

  /** 一键套用场景：保留字段选择，替换标题、配色、印章、底部说明 */
  onScene(e) {
    const type = e.currentTarget.dataset.t;
    this.setData({ sceneType: type });
    this.update({ ...scenes.byType(type).receipt });
  },

  onAddField(e) {
    this.update({ fields: this.data.tpl.fields.concat(e.currentTarget.dataset.f) });
  },
  onRemoveField(e) {
    const f = e.currentTarget.dataset.f;
    this.update({ fields: this.data.tpl.fields.filter(x => x !== f) });
  },
  onMove(e) {
    const { f, dir } = e.currentTarget.dataset;
    const fields = this.data.tpl.fields.slice();
    const i = fields.indexOf(f);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= fields.length) return;
    [fields[i], fields[j]] = [fields[j], fields[i]];
    this.update({ fields });
  },

  onReset() {
    const book = this.data.books[this.data.bookIdx];
    this.setData({ sceneType: '' });
    this.update(receipt.normalizeTpl(null, book && book.type));
  },

  async onSave() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      const book = this.data.books[this.data.bookIdx];
      const tpls = { receiptTpl: this.data.tpl };
      // 套用过场景时，这本礼簿的打印小票标题与致谢语一并切换
      if (this.data.sceneType) {
        const r = await req.bookGetTpl(book._id);
        const cur = r.printTpl || printer.defaultTemplate(book.type, r.paperWidth);
        tpls.printTpl = { ...cur, ...scenes.byType(this.data.sceneType).print };
      }
      await req.bookSaveTpl(book._id, tpls);
      printer.clearTemplateCache();
      wx.showToast({ title: this.data.sceneType ? '已保存（打印同步）' : '已保存', icon: 'success' });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});
