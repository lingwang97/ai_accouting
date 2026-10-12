// pages/printset/printset.js — 打印排版与格式自定义（UC7，文档 §6.6）
const req = require('../../utils/request.js');
const escpos = require('../../utils/escpos.js');
const printer = require('../../utils/printer.js');

// 字段定义（顺序可调）
const FIELD_LABELS = {
  title: '标题', divider: '分隔线', payDay: '日期', time: '时间',
  payerName: '付款人', amount: '金额', remark: '备注', thanks: '致谢语'
};
const label = f => FIELD_LABELS[f] || f;

Page({
  data: {
    paperWidth: 32,
    title: '收款凭证',
    thanks: '谢谢惠顾',
    showDivider: true,
    fields: [],            // 已启用字段键（有序）
    fieldItems: [],        // [{f,label}] 渲染用
    disabledItems: [],
    saving: false,
    previewLines: []
  },

  onLoad() {
    this.load();
  },

  async load() {
    const tpl = await printer.getTemplate(true);
    this.setData({
      paperWidth: tpl.paperWidth || 32,
      title: tpl.title || '收款凭证',
      thanks: tpl.thanks || '',
      showDivider: tpl.showDivider !== false,
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
        case 'title': lines.push({ big: true, t: this.data.title || '收款凭证' }); break;
        case 'divider': if (this.data.showDivider) lines.push({ t: '-'.repeat(w) }); break;
        case 'payDay': lines.push({ t: '日期：2026-10-10' }); break;
        case 'time': lines.push({ t: '时间：12:30' }); break;
        case 'payerName': lines.push({ t: '付款人：张三' }); break;
        case 'amount': lines.push({ big: true, right: true, t: '￥88.50' }); break;
        case 'remark': lines.push({ t: '备注：午餐' }); break;
        case 'thanks': if (this.data.thanks) lines.push({ center: true, t: this.data.thanks }); break;
      }
    }
    this.setData({ previewLines: lines });
  },

  async onSave() {
    if (this.data.saving) return;
    if (this.data.fields.length === 0) {
      return wx.showToast({ title: '至少保留一个字段', icon: 'none' });
    }
    this.setData({ saving: true });
    try {
      await req.tplSave({
        paperWidth: this.data.paperWidth,
        fields: this.data.fields,
        title: this.data.title,
        showDivider: this.data.showDivider,
        thanks: this.data.thanks
      });
      await printer.getTemplate(true); // 刷新缓存
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});
