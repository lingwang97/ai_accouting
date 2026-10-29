// pages/booktheme/booktheme.js — 传统礼簿 PDF：选择主题（预设 / 基于预设修改 / 自定义；白事只能改字体角饰水印标题落款）→ 确认后导出
// 所有入口（礼簿管理、导出页）的「传统礼簿 PDF」都先到这里；校验与云函数一致，云函数另有兜底
const req = require('../../utils/request.js');
const openfile = require('../../utils/openfile.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');
const pt = require('./pdftheme.js');
const plan = require('../../utils/plan.js');
const vip = require('../../utils/vip.js');

const VIP_TIP = '该功能为会员功能，开通后可使用';

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
    defTip: '',              // 没保存过主题时的默认说明（按礼簿类型）
    cust: Object.assign({}, pt.DEFAULT_CUSTOM),
    fun: Object.assign({}, pt.DEFAULT_FUNERAL),
    pv: null,                // 封面预览 { bg, border, text, title, footer, mark }
    custErr: '',
    back: Object.assign({}, pt.DEFAULT_BACK), // 尾页设置
    bind: 'none',                              // 装订：none | single | double
    binds: pt.BINDS,
    bindTip: pt.BIND_TIPS.none,
    exporting: false,
    premiumOk: true,         // 套餐是否开放会员主题（features.pdfThemePremium；缺项视为开放）
    lockTip: '',             // 套餐未开放时的说明
    presets: pt.LIST,
    fonts: pt.FONTS, patterns: pt.PATTERNS, marks: pt.MARKS,
    fPatterns: pt.FUNERAL_PATTERNS, fMarks: pt.FUNERAL_MARKS, fFooters: pt.FUNERAL_FOOTERS,
    mainColors: pt.MAIN_COLORS, accentColors: pt.ACCENT_COLORS,
    themeStyle: '',
    cur: 0,                  // 示意图当前页：0 封面 / 1 内页 / 2 封底
    pg: null,                // 内页示意
    bk: null,                // 封底示意
    signers: null,           // 封底记账人姓名（云端 bookPreviewData；只有姓名）
    pvRows: pt.SAMPLE,       // 内页示意用的前几位宾客（云端 bookPreviewData，拿不到用示例）
    pvSample: false,
    previewing: false,       // 正在生成预览 PDF
    pvLock: false            // 预览完成后 3 秒内不能再点（防连点）
  },

  // 键盘弹起时隐藏固定底栏（避免底栏被顶到输入框上方遮挡；未在真机验证，输入框另设 cursor-spacing 兜底）
  onKbOn() { if (!this.data.kb) this.setData({ kb: true }); },
  onKbOff() { if (this.data.kb) this.setData({ kb: false }); },

  onLoad(options) {
    theme.early(this); // 首帧前同步套主题色（v3.70.1）
    this.setData({ id: options.bookId || '' });
    this.load();
  },

  onShow() { theme.apply(this); },

  async load() {
    try {
      const [{ list }] = await Promise.all([req.bookList(), getApp().ensureRole(), plan.load()]);
      const premiumOk = plan.has('pdfThemePremium');
      const book = list.find(b => b._id === this.data.id);
      if (!book) {
        wx.showToast({ title: '礼簿不存在', icon: 'none' });
        return setTimeout(() => wx.navigateBack({ fail() {} }), 1200);
      }
      const isFuneral = book.type === 'funeral';
      const saved = book.pdfCustom || null;
      // 没保存过主题：按礼簿类型预选默认主题和水印（v3.55.0）；保存过的原样显示
      const fresh = !book.pdfTheme;
      let def = fresh && !isFuneral ? pt.defaultSelection(book.type) : null;
      // 会员主题未开放：默认主题是会员主题时，预选免费的「中国红金」（与云端降级一致）
      if (def && !premiumOk && !pt.FREE_KEYS.includes(def.themeKey)) def = { ...def, themeKey: pt.DEFAULT_KEY, name: '中国红金', base: '', cust: null, mark: '' };
      let defTip = '';
      if (fresh) {
        const lb = pt.TYPE_LABELS[book.type] || pt.TYPE_LABELS.other;
        const mk = pt.typeDefault(book.type).mark;
        defTip = isFuneral ? `按「${lb}」默认：素灰${mk ? '，水印「' + mk + '」' : ''}，可在下方修改`
          : `按「${lb}」默认选了「${def.name}」${def.mark ? '，水印「' + def.mark + '」' : '，无水印'}，可更换或修改`;
      }
      this.setData({
        premiumOk,
        presets: pt.LIST.map(p => ({ ...p, locked: !premiumOk && !pt.FREE_KEYS.includes(p.key) })),
        fonts: pt.FONTS.map(f => ({ ...f, locked: !premiumOk && f.k !== 'sans' })),
        book, isFuneral, defTip,
        canSave: perm.can('books'),
        themeKey: isFuneral ? 'custom' : (def ? def.themeKey : (book.pdfTheme || pt.DEFAULT_KEY)),
        base: def ? def.base : (book.pdfBase || ''),
        back: Object.assign({}, pt.DEFAULT_BACK, book.pdfBack || {}),
        bind: book.pdfBind || 'none',
        bindTip: pt.BIND_TIPS[book.pdfBind || 'none'],
        cust: Object.assign({}, pt.DEFAULT_CUSTOM, isFuneral ? {} : (def && def.cust ? def.cust : (saved || {}))),
        fun: Object.assign({}, pt.DEFAULT_FUNERAL, isFuneral && fresh ? { mark: pt.typeDefault('funeral').mark } : {}, isFuneral && saved ? saved : {})
      });
      this.refresh();
      this.loadRows();
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  /** 内页示意用的真实前几位宾客（与「预览」PDF 同一份数据）；失败 / 没有数据用示例，不打扰用户 */
  async loadRows() {
    try {
      const r = await req.exportPreviewData(this.data.id);
      if (r && r.rows && r.rows.length) this.setData({ pvRows: r.rows, pvSample: !!r.sample, signers: r.signers || null });
      this.refresh();
    } catch (e) { /* 用示例 */ }
  },

  onSwipe(e) { this.setData({ cur: e.detail.current }); },
  onTab(e) { this.setData({ cur: Number(e.currentTarget.dataset.i) }); },

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
    const book = d.book || {};
    const pv = colors ? Object.assign({}, colors, {
      title: e.title || book.name || '', footer: e.footer || '', mark: e.mark || '',
      corners: this.cornersOf(e.pattern),
      info: [book.hostName ? `主家：${book.hostName}` : '', book.date ? `日期：${book.date}` : ''].filter(Boolean)
    }) : null;
    const upd = { custErr: err, pv, lockTip: this.lockTip() };
    if (pv) { upd.pg = this.pageOf(e, d.isFuneral ? pt.GREY.main : e.main); upd.bk = this.backOf(e, pv); }
    this.setData(upd);
  },

  /** 角饰示意：用字符近似（实际为矢量图形）；无 / 双线不画 */
  cornersOf(pattern) {
    if (pattern === 'line') return ['┏', '┓', '┗', '┛'];
    const ch = pt.CORNER_CHARS[pattern];
    return ch ? [ch, ch, ch, ch] : null;
  },

  /** 内页示意：右起 12 列，前几位宾客的姓名与大写金额；装订边在一侧留白（首页为奇数页，装订边在右） */
  pageOf(e, line) {
    const d = this.data;
    const slots = [];
    for (let i = 0; i < 12; i++) {
      const r = d.pvRows[i];
      if (!r) { slots.push({ i, name: [], amt: [], yen: '' }); continue; }
      const name = Array.from(String(r.name || '')).slice(0, 6);
      const amt = Array.from(pt.amountUpper(r.amount)).slice(0, 10);
      slots.push({ i, name, amt, yen: `￥${Number(r.amount)}` });
    }
    const gut = d.bind === 'none' ? 0 : 8;
    return {
      line: line || '#555555',
      head: (d.book && d.book.name) || '',
      slots,
      grid: `left:3%;right:${3 + gut}%`,
      gut: 'right:0'
    };
  },

  /** 封底示意：按尾页设置显示 / 隐藏各项（落款：自定义 > 封面落款 > 事由默认吉语；'-' 表示不要） */
  backOf(e, pv) {
    const d = this.data, b = d.back, book = d.book || {};
    if (!b.on) return { foot: '', sign: '' };
    const foot = b.footer === '-' ? '' : (b.footer || e.footer || (d.isFuneral ? '' : pt.BACK_FOOTER[book.type] || ''));
    // 签名：本礼簿经手人姓名（云端 bookPreviewData 返回，只有姓名）；没有则显示留空签字栏
    const sg = d.signers || {}, ns = sg.names || [];
    const sign = ns.length ? `记账人：${ns.join('　')}${sg.total > ns.length ? `等 ${sg.total} 人` : ''}` : '记账人（签字）';
    return { foot, sign };
  },

  /** 套餐未开放会员项时的说明：免费可用项 + 当前选择里有会员项则提示导出会降级 */
  lockTip() {
    const d = this.data;
    if (d.premiumOk) return '';
    const used = [];
    if (d.isFuneral) { if (d.fun.font !== 'sans') used.push(1); }
    else if (d.themeKey === 'custom' || !pt.FREE_KEYS.includes(d.themeKey)) used.push(1);
    const b = d.back || {};
    if (!(b.on && !b.footer && b.sign && b.brand)) used.push(1);
    return '免费版可用「中国红金、桃粉、天蓝、素灰」，其余主题、自定义配色、宋体 / 毛笔字体、尾页设置需开通会员。'
      + (used.length ? '当前选择含会员项，导出时将按免费样式生成。' : '');
  },

  onPickTheme(e) {
    const k = e.currentTarget.dataset.k;
    if (!this.data.premiumOk && (k === 'custom' || !pt.FREE_KEYS.includes(k))) return vip.explain('PDF 主题', VIP_TIP);
    this.setData({ themeKey: k, base: k === 'custom' ? this.data.base : '', defTip: '' });
    this.refresh();
  },

  /** 基于当前预设继续修改：把预设展开成自定义项（快照） */
  onEditPreset() {
    const k = this.data.themeKey;
    if (k === 'custom') return;
    if (!this.data.premiumOk) return vip.explain('PDF 主题', VIP_TIP);
    this.setData({ cust: pt.expand(k), base: k, themeKey: 'custom' });
    this.refresh();
  },

  onCust(e) {
    if (!this.data.premiumOk) return vip.explain('PDF 主题', VIP_TIP);
    const { f, v } = e.currentTarget.dataset;
    this.setData({ ['cust.' + f]: v });
    this.refresh();
  },

  onCustInput(e) {
    if (!this.data.premiumOk) return;
    const f = e.currentTarget.dataset.f;
    let v = String(e.detail.value || '');
    if (f === 'main' || f === 'accent') v = v.toUpperCase();
    this.setData({ ['cust.' + f]: v });
    this.refresh();
  },

  onFun(e) {
    const { f, v } = e.currentTarget.dataset;
    if (f === 'font' && v !== 'sans' && !this.data.premiumOk) return vip.explain('PDF 字体', VIP_TIP);
    this.setData({ ['fun.' + f]: v });
    this.refresh();
  },

  onFunInput(e) {
    this.setData({ ['fun.' + e.currentTarget.dataset.f]: String(e.detail.value || '').replace(/[\u0000-\u001f\u007f]/g, '') });
    this.refresh();
  },

  /** 尾页设置属会员功能：套餐未开放时，点击说明原因 */
  onBackLocked() { if (!this.data.premiumOk) vip.explain('尾页设置', VIP_TIP); },

  onBackSwitch(e) {
    if (!this.data.premiumOk) return this.onBackLocked();
    this.setData({ ['back.' + e.currentTarget.dataset.f]: !!e.detail.value });
    this.refresh();
  },

  onBackFooter(e) { if (!this.data.premiumOk) return this.onBackLocked(); this.setData({ 'back.footer': e.currentTarget.dataset.v }); this.refresh(); },

  onBackInput(e) {
    if (!this.data.premiumOk) return;
    this.setData({ 'back.footer': String(e.detail.value || '').replace(/[\u0000-\u001f\u007f]/g, '') });
    this.refresh();
  },

  onBind(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ bind: k, bindTip: pt.BIND_TIPS[k] });
    this.refresh();
  },

  /** 导出 / 预览共用的主题参数；自定义配色不合法时提示并返回 null */
  buildParams() {
    const d = this.data;
    const params = { bookId: d.id, pdfBack: d.back, pdfBind: d.bind };
    if (d.isFuneral) {
      params.pdfTheme = 'custom';
      params.pdfCustom = d.fun;
    } else {
      params.pdfTheme = d.themeKey;
      if (d.themeKey === 'custom') {
        if (d.custErr) { wx.showToast({ title: d.custErr, icon: 'none' }); return null; }
        params.pdfCustom = d.cust;
        params.pdfBase = d.base;
      }
    }
    return params;
  },

  /** 预览：云端用同一套排版生成封面 + 内页 + 封底的小 PDF（不保存主题）；生成中禁用，完成后 3 秒内不能再点 */
  async onPreview() {
    const d = this.data;
    if (d.exporting || d.previewing || d.pvLock || !d.book) return;
    const params = this.buildParams();
    if (!params) return;
    this.setData({ previewing: true });
    wx.showLoading({ title: '正在生成预览…', mask: true });
    try {
      const res = await req.exportPreview(params);
      const filePath = await openfile.download(res.fileID, res.fileName);
      req.exportCleanup(res.fileID).catch(() => {});
      wx.hideLoading();
      await openfile.notice(res);
      openfile.open(filePath, res.fileName);
    } catch (e) {
      wx.hideLoading();
      const msg = (e && e.message) || '';
      if (msg && msg !== 'download failed') wx.showModal({ title: '预览未成功', content: msg, showCancel: false });
    } finally {
      this.setData({ previewing: false, pvLock: true });
      setTimeout(() => this.setData({ pvLock: false }), 3000);
    }
  },

  /** 确认导出：校验 → 云端保存主题（有权限时）并生成 → 下载打开 */
  async onConfirm() {
    const d = this.data;
    if (d.exporting || d.previewing || !d.book) return;
    const params = this.buildParams();
    if (!params) return;
    params.format = 'book';
    this.setData({ exporting: true });
    wx.showLoading({ title: '约需半分钟…', mask: true }); // 导出一般 10～30 秒，礼金多时接近 1 分钟（v3.65.2 提示预计时间）
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
