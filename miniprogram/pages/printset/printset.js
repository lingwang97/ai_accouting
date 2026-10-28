// pages/printset/printset.js — 打印排版与格式自定义（UC7，文档 §6.6）
const req = require('../../utils/request.js');
const escpos = require('../../utils/escpos.js');
const bordertiles = require('../../utils/bordertiles.js');
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

/**
 * 小程序码生成失败原因码 → 中文提示（reason 由 payment.issueQr / qrCheck 返回，不含敏感信息）
 * 码含义以微信官方文档为准：85407 无 URL Link 权限（旧版）、40001 access_token 无效、40125 AppSecret 错误、40013 AppID 无效、
 * 41030 页面不存在、45009 调用超过限额、40097 参数错误、-604101 云函数没有该云调用权限
 */
function qrReasonText(reason) {
  const r = String(reason || '');
  const tips = [];
  if (/secret-missing/.test(r)) tips.push('AppSecret 未配置：云开发控制台 → 云函数 system → 配置 → 环境变量添加 WX_APPSECRET');
  if (/token:(40125|40001|40013)/.test(r)) tips.push('AppSecret 不正确或已被重置：请到公众平台重新获取，更新 system 的 WX_APPSECRET 环境变量');
  else if (/token:/.test(r)) tips.push('获取 access_token 失败，请核对 AppID 与 AppSecret');
  if (/(-604101|-604100)/.test(r)) tips.push('云函数缺少 wxacode 权限');
  if (/http:(40001|42001)/.test(r)) tips.push('access_token 失效，请重试');
  if (/http:85407|openapi:85407/.test(r)) tips.push('无生成权限（小程序主体类型不支持）');
  if (/http:41030/.test(r)) tips.push('页面不存在：该版本尚未包含此页面（请用对应版本，或先发布）');
  if (/http:(45009|45029)/.test(r)) tips.push('今日生成额度已用完，请明天再试');
  if (/http:(40097|40129|40130)/.test(r)) tips.push('参数不合法，请把原因码发给开发者');
  if (/call:/.test(r)) tips.push('备用通道调用失败：请确认 system 云函数已部署');
  if (/decode:/.test(r)) tips.push('码图解码失败，请把原因码发给开发者');
  if (!tips.length) tips.push('请把下面的原因码发给开发者');
  return tips.join('；');
}

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
    qr: false,
    qrMode: 'image',
    qrTesting: false,
    qrChecking: false,
    border: 'off',        // 花边：off | auto | 款式键
    borderSide: true,
    borderStyles: bordertiles.styleList(),
    borderTesting: false,
    bookType: 'other',
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
    const acc0 = getApp().globalData.account;
    this.setData({ org: !!(acc0 && acc0.orgMode), staffWord: acc0 && acc0.orgMode ? '礼台人员' : '记账人' }); // 机构模式称「礼台人员」
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
      border: tpl.border,
      borderSide: tpl.borderSide,
      bookType: (book && book.type) || 'other',
      feedTop: tpl.feedTop,
      feedBottom: tpl.feedBottom,
      qr: tpl.qr === true, // 默认关（v3.59.0）
      qrMode: 'image', // 小程序码只能图片方式
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
  onQr(e) { this.setData({ qr: e.detail.value }, () => this.buildPreview()); },
  /** 打印测试码：真实小程序码（指向首页，scene test=1），微信扫一扫应打开首页，用来实测这台机器的识别率 */
  async onQrTest() {
    if (this.data.qrTesting) return;
    this.setData({ qrTesting: true });
    try {
      await printer.printQrTest();
      printer.resetQrBreaker();
      wx.showToast({ title: '已发送打印', icon: 'success' });
    } catch (e) {
      const why = e.reason ? `${qrReasonText(e.reason)}\n\n原因码：${e.reason}` : (e.message || '请先连接打印机');
      wx.showModal({ title: '打印失败', content: why, showCancel: false });
    } finally {
      this.setData({ qrTesting: false });
    }
  },
  /** 检测小程序码生成：只生成不打印，成功提示正常，失败给出中文原因与原因码 */
  async onQrCheck() {
    if (this.data.qrChecking) return;
    this.setData({ qrChecking: true });
    try {
      const r = await req.qrCheck();
      if (r.ok) { printer.resetQrBreaker(); return wx.showToast({ title: '小程序码正常', icon: 'success' }); } // 配置修好后立即恢复印码
      wx.showModal({ title: '小程序码生成失败', content: `${qrReasonText(r.reason)}\n\n原因码：${r.reason || '无'}`, showCancel: false });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ qrChecking: false });
    }
  },
  /** 花边：关闭 / 跟随礼簿类型 / 手动选一款 */
  onBorder(e) { this.setData({ border: e.currentTarget.dataset.v }, () => this.buildPreview()); },
  onBorderSide(e) { this.setData({ borderSide: e.detail.value }, () => this.buildPreview()); },
  /** 当前设置页的打印样式（未保存也能试打） */
  _curTpl() {
    const d = this.data;
    return escpos.withDefaults({
      paperWidth: d.paperWidth, fields: d.fields, title: d.title, showDivider: d.showDivider, promo: d.promo, thanks: d.thanks,
      footer: d.footer, amountSize: d.amountSize, titleAlign: d.titleAlign, titleBold: d.titleBold, showHandler: d.showHandler,
      feedTop: d.feedTop, feedBottom: d.feedBottom, border: d.border, borderSide: d.borderSide, qr: false
    });
  },
  /** 打印花边测试：按当前样式印一张示例小票（不带二维码、不入簿） */
  async onBorderTest() {
    if (this.data.borderTesting) return;
    this.setData({ borderTesting: true });
    try {
      await printer.printBorderSample(this._curTpl(), this.data.bookType);
      wx.showToast({ title: '已发送打印', icon: 'success' });
    } catch (e) {
      wx.showModal({ title: '打印失败', content: e.message || '请先连接打印机', showCancel: false });
    } finally {
      this.setData({ borderTesting: false });
    }
  },
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
    // 花边（v3.60.0）：上下花纹带用示意字符，左右装饰字符逐行交替；预览只是示意，以实际打印为准
    const bd = bordertiles.resolve(d.border, d.borderSide, d.bookType);
    const sideOn = !!(bd && bd.side);
    const cw = sideOn ? w - 4 : w;
    let ln = 0;
    const push = o => lines.push(sideOn ? { ...o, s: bd.side[ln++ % 2] } : o);
    const add = (t, o) => (sideOn ? escpos.wrapCols : escpos.wrap)(t, cw).forEach(x => push({ t: x, ...(o || {}) }));
    for (let i = 0; i < d.feedTop; i++) lines.push({ t: ' ', blank: true });
    const bandGap = () => (sideOn ? push({ t: ' ' }) : lines.push({ t: ' ', blank: true })); // 花纹带与正文空一行（v3.60.2）
    if (bd) { lines.push({ t: bordertiles.previewBand(bd.key, w), band: true }); bandGap(); }
    const who = '主家：张三  ' + (d.showHandler ? '记账：李四' : '');
    const tAl = d.titleAlign === 'left' ? {} : { center: true };
    for (const f of d.fields) {
      switch (f) {
        case 'title': add(d.title || '礼金回执', { ...tAl, bold: d.titleBold }); add(who.trim(), tAl); break;
        case 'theme': add('事由：张三&李四 新婚之喜'); break;
        case 'relation': add('关系：同学'); break;
        case 'divider': if (d.showDivider) push({ t: '-'.repeat(cw) }); break;
        case 'payDay': add('日期：2026-10-10'); break;
        case 'time': add('时间：12:30'); break;
        case 'receiptNo': add('编号：R20261010A1B2C3'); break;
        case 'payerName': add('随礼人：张三'); break;
        case 'payMethod': add('方式：微信'); break;
        case 'amount': push({ big: d.amountSize === 'double', tall: d.amountSize === 'tall', bold: true, right: true, t: '￥88.50' }); break;
        case 'amountUpper': add('大写：捌拾捌元伍角整', { right: true }); break;
        case 'remark': add('礼品/备注：另送花篮一对'); break;
        case 'thanks': if (d.thanks) add(d.thanks, { center: true }); break;
      }
    }
    if (d.qr) {
      const book = d.books[d.bookIdx];
      lines.push({ t: '[ 二维码 ]', center: true });
      add(book && book.type === 'funeral' ? '扫码查看回执' : '扫码查看电子回执', { center: true });
    }
    if (d.footer) add(d.footer, { center: true });
    if (d.promo) add('微信搜索「慧礼记」记礼金·查往来', { center: true });
    if (bd) { bandGap(); lines.push({ t: bordertiles.previewBand(bd.key, w), band: true }); }
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
          feedBottom: this.data.feedBottom,
          border: this.data.border,
          borderSide: this.data.borderSide,
          qr: this.data.qr,
          qrMode: this.data.qrMode
        }
      });
      printer.clearTemplateCache();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});
