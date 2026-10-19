// pages/printset/printset.js — 打印排版与格式自定义（UC7，文档 §6.6）
const req = require('../../utils/request.js');
const escpos = require('../../utils/escpos.js');
const printer = require('../../utils/printer.js');
const theme = require('../../utils/theme.js');

// 字段定义（顺序可调）
const FIELD_LABELS = {
  title: '标题', divider: '分隔线', theme: '事由', payDay: '日期', time: '时间',
  payerName: '随礼人', relation: '关系', proxyFor: '代随礼', amount: '礼金', remark: '礼品/备注', thanks: '致谢语'
};
const label = f => FIELD_LABELS[f] || f;

Page({
  data: {
    paperWidth: 32,
    title: '礼金回执',
    thanks: '谢谢惠顾',
    showDivider: true,
    promo: true,        // 小票底部推广语
    fields: [],            // 已启用字段键（有序）
    fieldItems: [],        // [{f,label}] 渲染用
    disabledItems: [],
    saving: false,
    books: [],
    bookIdx: 0,
    previewLines: []
  },

  onShow() {
    this.setData({ primary: theme.apply(this).primary }); // 主题色跟当前礼簿事由走
  },

  async onLoad(options) {
    try {
      const { list, activeBookId } = await req.bookList();
      const books = list.filter(b => !b.archived || b._id === activeBookId);
      const want = options.bookId || activeBookId; // 从「电子回执」切换过来时沿用所选礼簿
      this.setData({ books, bookIdx: Math.max(0, books.findIndex(b => b._id === want)) });
    } catch (e) { /* 未完善主家信息 */ }
    this.load();
  },

  /** 切到「电子回执」 */
  onStyleTab(e) {
    if (e.currentTarget.dataset.t !== 'receipt') return;
    const b = this.data.books[this.data.bookIdx];
    wx.redirectTo({ url: '/pages/receiptset/receiptset' + (b ? '?bookId=' + b._id : '') });
  },

  onBook(e) {
    this.setData({ bookIdx: Number(e.detail.value) });
    this.load();
  },

  /** 读取所选礼簿的打印样式；未自定义时按事由类型显示场景默认 */
  async load() {
    const book = this.data.books[this.data.bookIdx];
    const tpl = await printer.getTemplate(true, book && book._id);
    this.setData({
      paperWidth: tpl.paperWidth || 32,
      title: tpl.title || '礼金回执',
      thanks: tpl.thanks || '',
      showDivider: tpl.showDivider !== false,
      promo: tpl.promo !== false,
      fields: tpl.fields || escpos.DEFAULT_FIELDS.slice()
    }, () => this.refresh());
  },

  /** 重建字段列表并刷新预览 */
  refresh() {
    const disabled = Object.keys(FIELD_LABELS).filter(f => !this.data.fields.includes(f));
    this.setData({
      fieldItems: this.data.fields.map(f => ({ f, label: label(f) })),
      disabledItems: disabled.map(f => ({ f, label: label(f) }))
    }, () => this.buildPreview());
  },

  onTitle(e) {
    this.setData({ title: e.detail.value }, () => this.buildPreview());
  },
  onThanks(e) {
    this.setData({ thanks: e.detail.value }, () => this.buildPreview());
  },
  onDivider(e) {
    this.setData({ showDivider: e.detail.value }, () => this.buildPreview());
  },
  onPromo(e) {
    this.setData({ promo: e.detail.value }, () => this.buildPreview());
  },
  onWidth(e) {
    this.setData({ paperWidth: Number(e.currentTarget.dataset.w) }, () => this.buildPreview());
  },

  onAddField(e) {
    const f = e.currentTarget.dataset.f;
    const fields = this.data.fields;
    // 金额固定靠后，其余按点击顺序追加在金额前
    const amtIdx = fields.indexOf('amount');
    if (amtIdx >= 0 && f !== 'amount') fields.splice(amtIdx, 0, f);
    else fields.push(f);
    this.setData({ fields }, () => this.refresh());
  },

  onRemoveField(e) {
    const f = e.currentTarget.dataset.f;
    const fields = this.data.fields.filter(x => x !== f);
    this.setData({ fields }, () => this.refresh());
  },

  onMove(e) {
    const { f, dir } = e.currentTarget.dataset;
    const fields = this.data.fields.slice();
    const i = fields.indexOf(f);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= fields.length) return;
    [fields[i], fields[j]] = [fields[j], fields[i]];
    this.setData({ fields }, () => this.refresh());
  },

  /** WXML 模拟小票预览 */
  buildPreview() {
    const w = this.data.paperWidth;
    const lines = [];
    for (const f of this.data.fields) {
      switch (f) {
        case 'title': lines.push({ big: true, t: this.data.title || '礼金回执' }); break;
        case 'theme': lines.push({ t: '事由：张三&李四 新婚之喜' }); break;
        case 'relation': lines.push({ t: '关系：同学' }); break;
        case 'proxyFor': lines.push({ t: '代随礼：李四、王五' }); break;
        case 'divider': if (this.data.showDivider) lines.push({ t: '-'.repeat(w) }); break;
        case 'payDay': lines.push({ t: '日期：2026-10-10' }); break;
        case 'time': lines.push({ t: '时间：12:30' }); break;
        case 'payerName': lines.push({ t: '随礼人：张三' }); break;
        case 'amount': lines.push({ big: true, right: true, t: '￥88.50' }); break;
        case 'remark': lines.push({ t: '礼品/备注：另送花篮一对' }); break;
        case 'thanks': if (this.data.thanks) lines.push({ center: true, t: this.data.thanks }); break;
      }
    }
    if (this.data.promo) lines.push({ center: true, t: '微信搜索「慧礼记」记礼金·查往来' });
    this.setData({ previewLines: lines });
  },

  async onSave() {
    if (this.data.saving) return;
    if (this.data.fields.length === 0) {
      return wx.showToast({ title: '至少保留一个字段', icon: 'none' });
    }
    this.setData({ saving: true });
    try {
      const book = this.data.books[this.data.bookIdx];
      if (!book) return wx.showToast({ title: '请先创建礼簿', icon: 'none' });
      await req.bookSaveTpl(book._id, {
        printTpl: {
          paperWidth: this.data.paperWidth,
          fields: this.data.fields,
          title: this.data.title,
          showDivider: this.data.showDivider,
          promo: this.data.promo,
          thanks: this.data.thanks
        }
      });
      printer.clearTemplateCache();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});
