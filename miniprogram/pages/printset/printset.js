// pages/printset/printset.js — 打印排版与格式自定义（UC7，文档 §6.6）
const req = require('../../utils/request.js');
const escpos = require('../../utils/escpos.js');
const printer = require('../../utils/printer.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');

// 字段定义（顺序可调）
const FIELD_LABELS = {
  title: '标题', divider: '分隔线', theme: '事由', payDay: '日期', time: '时间',
  payerName: '随礼人', relation: '关系', amount: '礼金', remark: '礼品/备注', thanks: '致谢语',
  receiptNo: '编号', payMethod: '支付方式', amountUpper: '金额大写'
};
const label = f => FIELD_LABELS[f] || f;

Page({
  data: {
    paperWidth: 32,
    title: '礼金回执',
    thanks: '谢谢惠顾',
    showDivider: true,
    promo: true,        // 小票底部推广语
    titleAlign: 'center',
    titleBold: true,
    showHandler: true,
    amountSize: 'double',
    footer: '',
    feedTop: 1,
    feedBottom: 5,
    topOpts: [0, 1, 2, 3, 4],
    bottomOpts: [2, 3, 4, 5, 6, 7, 8],
    fields: [],            // 已启用字段键（有序）
    fieldItems: [],        // [{f,label}] 渲染用
    disabledItems: [],
    saving: false,
    pageLoading: true,   // 首次读取模板期间：转圈 + 不可操作
    books: [],
    bookIdx: 0,
    previewLines: []
  },

  onShow() {
    this.setData({ primary: theme.apply(this).primary }); // 主题色跟当前礼簿事由走
  },

  async onLoad(options) {
    if (!(await perm.guard('style', '你没有修改回执与打印样式的权限'))) { this.setData({ pageLoading: false }); return; } // 文案同 books.saveTpl
    try {
      const { list, activeBookId } = await req.bookList();
      const books = list.filter(b => !b.archived || b._id === activeBookId);
      const want = options.bookId || activeBookId; // 从「电子回执」切换过来时沿用所选礼簿
      this.setData({ books, bookIdx: Math.max(0, books.findIndex(b => b._id === want)) });
    } catch (e) { /* 未完善主家信息 */ }
    try { await this.load(); } finally { this.setData({ pageLoading: false }); }
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
    const tpl = escpos.withDefaults(await printer.getTemplate(true, book && book._id)); // 旧模板缺新字段时补默认值
    this.setData({
      paperWidth: tpl.paperWidth || 32,
      title: tpl.title || '礼金回执',
      thanks: tpl.thanks || '',
      showDivider: tpl.showDivider !== false,
      promo: tpl.promo !== false,
      titleAlign: tpl.titleAlign,
      titleBold: tpl.titleBold,
      showHandler: tpl.showHandler,
      amountSize: tpl.amountSize,
      footer: tpl.footer,
      feedTop: tpl.feedTop,
      feedBottom: tpl.feedBottom,
      fields: (tpl.fields || escpos.DEFAULT_FIELDS).filter(f => FIELD_LABELS[f]) // 去掉已下线的字段（如旧版的「代随礼」）
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
  onTitleAlign(e) { this.setData({ titleAlign: e.currentTarget.dataset.v }, () => this.buildPreview()); },
  onTitleBold(e) { this.setData({ titleBold: e.detail.value }, () => this.buildPreview()); },
  onHandler(e) { this.setData({ showHandler: e.detail.value }, () => this.buildPreview()); },
  onAmountSize(e) { this.setData({ amountSize: e.currentTarget.dataset.v }, () => this.buildPreview()); },
  onFooter(e) { this.setData({ footer: e.detail.value }, () => this.buildPreview()); },
  onFeedTop(e) { this.setData({ feedTop: Number(e.currentTarget.dataset.n) }, () => this.buildPreview()); },
  onFeedBottom(e) { this.setData({ feedBottom: Number(e.currentTarget.dataset.n) }, () => this.buildPreview()); },
  onWidth(e) {
    this.setData({ paperWidth: Number(e.currentTarget.dataset.w) }, () => this.buildPreview());
  },

  onAddField(e) {
    const f = e.currentTarget.dataset.f;
    const fields = this.data.fields;
    // 金额固定靠后，其余按点击顺序追加在金额前
    const amtIdx = fields.indexOf('amount');
    if (f === 'amountUpper' && amtIdx >= 0) fields.splice(amtIdx + 1, 0, f); // 大写紧跟金额之后
    else if (amtIdx >= 0 && f !== 'amount') fields.splice(amtIdx, 0, f);
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

  /** WXML 模拟小票预览（长文本按列宽折行，与打印一致） */
  buildPreview() {
    const d = this.data;
    const w = d.paperWidth;
    const lines = [];
    const add = (t, o) => escpos.wrap(t, w).forEach(x => lines.push({ t: x, ...(o || {}) }));
    for (let i = 0; i < d.feedTop; i++) lines.push({ t: ' ', blank: true });
    const who = '主家：张三  ' + (d.showHandler ? '记账：李四' : '');
    const tAl = d.titleAlign === 'left' ? {} : { center: true };
    for (const f of d.fields) {
      switch (f) {
        case 'title': add(d.title || '礼金回执', { ...tAl, bold: d.titleBold }); add(who.trim(), tAl); break;
        case 'theme': add('事由：张三&李四 新婚之喜'); break;
        case 'relation': add('关系：同学'); break;
        case 'divider': if (d.showDivider) lines.push({ t: '-'.repeat(w) }); break;
        case 'payDay': add('日期：2026-10-10'); break;
        case 'time': add('时间：12:30'); break;
        case 'receiptNo': add('编号：R20261010A1B2C3'); break;
        case 'payerName': add('随礼人：张三'); break;
        case 'payMethod': add('方式：微信'); break;
        case 'amount': lines.push({ big: d.amountSize === 'double', tall: d.amountSize === 'tall', bold: true, right: true, t: '￥88.50' }); break;
        case 'amountUpper': add('大写：捌拾捌元伍角整', { right: true }); break;
        case 'remark': add('礼品/备注：另送花篮一对'); break;
        case 'thanks': if (d.thanks) add(d.thanks, { center: true }); break;
      }
    }
    if (d.footer) add(d.footer, { center: true });
    if (d.promo) add('微信搜索「慧礼记」记礼金·查往来', { center: true });
    for (let i = 0; i < d.feedBottom; i++) lines.push({ t: ' ', blank: true });
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
          thanks: this.data.thanks,
          footer: this.data.footer,
          amountSize: this.data.amountSize,
          titleAlign: this.data.titleAlign,
          titleBold: this.data.titleBold,
          showHandler: this.data.showHandler,
          feedTop: this.data.feedTop,
          feedBottom: this.data.feedBottom
        }
      });
      printer.clearTemplateCache();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});
