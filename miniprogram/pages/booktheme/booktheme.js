// pages/booktheme/booktheme.js — 传统礼簿 PDF：选择主题（预设 / 基于预设修改 / 自定义；白事只能改字体角饰水印标题落款）→ 确认后导出
// 所有入口（礼簿管理、导出页）的「传统礼簿 PDF」都先到这里；校验与云函数一致，云函数另有兜底
const req = require('../../utils/request.js');
const openfile = require('../../utils/openfile.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');
const pt = require('./pdftheme.js');

Page({
  data: {
    loading: true,
    kb: false,               // 键盘是否弹起
    id: '',
    book: null,
    isFuneral: false,
    canSave: true,           // 有「管理礼簿」权限才会把主题记到礼簿
    themeKey: pt.DEFAULT_KEY, // 预设 key 或 'custom'
    base: '',                // 自定义是基于哪个预设改的（仅记录）
    cust: Object.assign({}, pt.DEFAULT_CUSTOM),
    fun: Object.assign({}, pt.DEFAULT_FUNERAL),
    pv: null,                // 封面预览 { bg, border, text, title, footer, mark }
    custErr: '',
    back: Object.assign({}, pt.DEFAULT_BACK), // 尾页设置
    bind: 'none',                              // 装订：none | single | double
    binds: pt.BINDS,
    bindTip: pt.BIND_TIPS.none,
    exporting: false,
    presets: pt.LIST,
    fonts: pt.FONTS, patterns: pt.PATTERNS, marks: pt.MARKS,
    fPatterns: pt.FUNERAL_PATTERNS, fMarks: pt.FUNERAL_MARKS, fFooters: pt.FUNERAL_FOOTERS,
    mainColors: pt.MAIN_COLORS, accentColors: pt.ACCENT_COLORS,
    themeStyle: ''
  },

  // 键盘弹起时隐藏固定底栏（避免底栏被顶到输入框上方遮挡；未在真机验证，输入框另设 cursor-spacing 兜底）
  onKbOn() { if (!this.data.kb) this.setData({ kb: true }); },
  onKbOff() { if (this.data.kb) this.setData({ kb: false }); },

  onLoad(options) {
    this.setData({ id: options.bookId || '' });
    this.load();
  },

  onShow() { theme.apply(this); },

  async load() {
    try {
      const [{ list }] = await Promise.all([req.bookList(), getApp().ensureRole()]);
      const book = list.find(b => b._id === this.data.id);
      if (!book) {
        wx.showToast({ title: '礼簿不存在', icon: 'none' });
        return setTimeout(() => wx.navigateBack({ fail() {} }), 1200);
      }
      const isFuneral = book.type === 'funeral';
      const saved = book.pdfCustom || null;
      this.setData({
        book, isFuneral,
        canSave: perm.can('books'),
        themeKey: isFuneral ? 'custom' : (book.pdfTheme || pt.DEFAULT_KEY),
        base: book.pdfBase || '',
        back: Object.assign({}, pt.DEFAULT_BACK, book.pdfBack || {}),
        bind: book.pdfBind || 'none',
        bindTip: pt.BIND_TIPS[book.pdfBind || 'none'],
        cust: Object.assign({}, pt.DEFAULT_CUSTOM, isFuneral ? {} : (saved || {})),
        fun: Object.assign({}, pt.DEFAULT_FUNERAL, isFuneral && saved ? saved : {})
      });
      this.refresh();
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  /** 当前生效的配置（用于预览） */
  effective() {
    const d = this.data;
    if (d.isFuneral) return d.fun;
    return d.themeKey === 'custom' ? d.cust : pt.expand(d.themeKey);
  },

  refresh() {
    const d = this.data;
    const e = this.effective();
    let colors, err = '';
    if (d.isFuneral) colors = pt.funeralPreview();
    else {
      colors = pt.previewOf(e);
      if (d.themeKey === 'custom') err = pt.checkCustom(e);
    }
    this.setData({
      custErr: err,
      pv: colors ? Object.assign({}, colors, { title: e.title || (d.book && d.book.name) || '', footer: e.footer || '', mark: e.mark || '' }) : null
    });
  },

  onPickTheme(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ themeKey: k, base: k === 'custom' ? this.data.base : '' });
    this.refresh();
  },

  /** 基于当前预设继续修改：把预设展开成自定义项（快照） */
  onEditPreset() {
    const k = this.data.themeKey;
    if (k === 'custom') return;
    this.setData({ cust: pt.expand(k), base: k, themeKey: 'custom' });
    this.refresh();
  },

  onCust(e) {
    const { f, v } = e.currentTarget.dataset;
    this.setData({ ['cust.' + f]: v });
    this.refresh();
  },

  onCustInput(e) {
    const f = e.currentTarget.dataset.f;
    let v = String(e.detail.value || '');
    if (f === 'main' || f === 'accent') v = v.toUpperCase();
    this.setData({ ['cust.' + f]: v });
    this.refresh();
  },

  onFun(e) {
    const { f, v } = e.currentTarget.dataset;
    this.setData({ ['fun.' + f]: v });
    this.refresh();
  },

  onFunInput(e) {
    this.setData({ ['fun.' + e.currentTarget.dataset.f]: String(e.detail.value || '').replace(/[\u0000-\u001f\u007f]/g, '') });
    this.refresh();
  },

  onBackSwitch(e) {
    this.setData({ ['back.' + e.currentTarget.dataset.f]: !!e.detail.value });
  },

  onBackFooter(e) { this.setData({ 'back.footer': e.currentTarget.dataset.v }); },

  onBackInput(e) {
    this.setData({ 'back.footer': String(e.detail.value || '').replace(/[\u0000-\u001f\u007f]/g, '') });
  },

  onBind(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ bind: k, bindTip: pt.BIND_TIPS[k] });
  },

  /** 确认导出：校验 → 云端保存主题（有权限时）并生成 → 下载打开 */
  async onConfirm() {
    const d = this.data;
    if (d.exporting || !d.book) return;
    const params = { format: 'book', bookId: d.id, pdfBack: d.back, pdfBind: d.bind };
    if (d.isFuneral) {
      params.pdfTheme = 'custom';
      params.pdfCustom = d.fun;
    } else {
      params.pdfTheme = d.themeKey;
      if (d.themeKey === 'custom') {
        if (d.custErr) return wx.showToast({ title: d.custErr, icon: 'none' });
        params.pdfCustom = d.cust;
        params.pdfBase = d.base;
      }
    }
    this.setData({ exporting: true });
    wx.showLoading({ title: '正在生成…', mask: true });
    try {
      const res = await req.exportFile(params);
      const filePath = await openfile.download(res.fileID, res.fileName);
      // 已下载到本机，立即删除云端文件，避免礼金明细通过链接外泄
      req.exportCleanup(res.fileID).catch(() => {});
      wx.hideLoading();
      await openfile.notice(res);
      openfile.open(filePath, res.fileName);
    } catch (e) {
      wx.hideLoading();
      openfile.showError(e);
    } finally {
      this.setData({ exporting: false });
    }
  }
});
