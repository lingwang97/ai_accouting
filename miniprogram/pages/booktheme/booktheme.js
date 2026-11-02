// pages/booktheme/booktheme.js — 传统礼簿 PDF：选择主题（预设 / 基于预设修改 / 自定义；白事只能改字体角饰水印标题落款）→ 确认后导出
// 所有入口（礼簿管理、导出页）的「传统礼簿 PDF」都先到这里；校验与云函数一致，云函数另有兜底
const req = require('../../utils/request.js');
const openfile = require('../../utils/openfile.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');
const pt = require('./pdftheme.js');
const plan = require('../../utils/plan.js');
const vip = require('../../utils/vip.js');
const imgc = require('../../utils/imgcompress.js');
const orgtext = require('../../utils/orgtext.js');
const pvfont = require('../../utils/pvfont.js');

const VIP_TIP = '该功能为会员功能，开通后可使用';

const PAGE = {
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
    deco: '',                // 封面纹样（'' 按事由默认；见 pdftheme.DECOS）
    decos: pt.DECOS,
    coverSet: false,         // 本礼簿是否已设封面照片
    coverUrl: '',            // 封面照片预览地址（临时链接 / 刚选的本地图）
    coverShape: 'rect',      // 相框形状：rect | oval
    shapes: pt.COVER_SHAPES,
    layouts: pt.COVER_LAYOUTS, scrims: pt.COVER_SCRIMS, prints: pt.COVER_PRINTS, focusCells: pt.FOCUS_CELLS,
    coverLayout: 'left',     // 封面照片版式：left 左图右文 / full 整页（v3.80.0）
    coverScrim: 'gradient',  // 整页时文字托底：gradient 渐变 / block 色块
    coverCrop: { x: 0.5, y: 0.5, z: 1 }, // 裁剪位置与缩放（x、y 0~1，z 1~3；旧版九宫格焦点云端读取时已映射）
    cropOpen: false, cropEdit: { x: 0.5, y: 0.5, z: 1 }, cropFrame: { w: 400, h: 400 }, cropImg: '', cropZ: 100, bandTop: 37, // 裁剪编辑器
    effMark: '', markName: '无',
    coverPrint: 'keep',      // 本次导出 / 预览的打印方式：keep 保留 / fade 淡化 / none 去照片（不保存）
    photoQ: '',              // 刚选的照片分辨率提示
    photoDim: null,          // { w, h }
    photoOk: true,           // 套餐是否开放封面照片（features.coverPhoto；缺项视为开放）
    photoBusy: false,        // 正在上传 / 保存照片
    binds: pt.BINDS,
    bindTip: pt.BIND_TIPS.none,
    exporting: false,
    pvOpen: true,            // 吸顶示意图是否展开（小屏可收起）
    dirty: false,            // 有未保存的样式改动（导出或「保存样式」后清除）
    saving: false,           // 正在「只保存样式」
    sheet: '',               // 确认面板：'' | 'export' | 'preview'
    org: false,              // 机构模式：礼簿称场次
    fontName: '黑体', effFont: 'sans',
    pvf: { main: '', sub: '', mark: '' }, // 示意图字体（font-family 样式；没加载到为空 = 系统字体）
    pvLoading: false, pvFail: false, pvNone: false,
    tryFont: '',             // 会员字体试看（只改示意图，不选中；切标签 / 选别的字体即恢复）
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
    this._pvLoaded = {};
    this.setData({ id: options.bookId || '' });
    this.load();
  },

  onShow() { theme.apply(this); },

  async load() {
    try {
      const [{ list }] = await Promise.all([req.bookList(), getApp().ensureRole(), plan.load()]);
      const premiumOk = plan.has('pdfThemePremium');
      const acc = getApp().globalData.account;
      const org = !!(acc && acc.orgMode);
      const photoOk = plan.has('coverPhoto');
      const book = list.find(b => b._id === this.data.id);
      if (!book) {
        wx.showToast({ title: orgtext.t('礼簿不存在', org), icon: 'none' });
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
        premiumOk, photoOk, org,
        deco: book.pdfDeco || '',
        decos: isFuneral ? pt.FUNERAL_DECOS : pt.DECOS,
        coverSet: !!book.coverPhoto,
        coverShape: (book.coverPhoto && book.coverPhoto.shape) || 'rect',
        coverLayout: (book.coverPhoto && book.coverPhoto.layout) || 'left',
        coverScrim: (book.coverPhoto && book.coverPhoto.scrim) || 'gradient',
        coverCrop: pt.sanitizeCrop(book.coverPhoto && book.coverPhoto.crop),
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
      if (book.coverPhoto && !isFuneral) this.loadCover();
      this._base = this.snap(); // 进页面时的样式快照，之后改动才算「未保存」
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  /** 封面照片预览的临时链接（取不到不影响使用，只是示意图里不显示照片） */
  async loadCover() {
    try {
      const r = await req.bookCoverUrl(this.data.id);
      if (r && r.url) {
        this.setData({ coverUrl: r.url, coverShape: r.shape || 'rect' });
        this.refresh();
        if (!this.data.dirty) this._base = this.snap();
      }
    } catch (e) { /* 忽略 */ }
  },

  /** 内页示意用的真实前几位宾客（与「预览」PDF 同一份数据）；失败 / 没有数据用示例，不打扰用户 */
  async loadRows() {
    try {
      const r = await req.exportPreviewData(this.data.id);
      if (r && r.rows && r.rows.length) this.setData({ pvRows: r.rows, pvSample: !!r.sample, signers: r.signers || null });
      this.refresh();
    } catch (e) { /* 用示例 */ }
  },

  onSwipe(e) { this.setData({ cur: e.detail.current, tryFont: '' }); this._pvRetry = true; this.syncPvFonts(); },
  onTab(e) { this.setData({ cur: Number(e.currentTarget.dataset.i), tryFont: '' }); this._pvRetry = true; this.syncPvFonts(); },

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
    const deco = pt.decoOf(d.deco, book.type);
    const photo = !d.isFuneral && d.coverSet && d.coverUrl && d.coverPrint !== 'none' ? d.coverUrl : '';
    const full = !!photo && d.coverLayout === 'full';
    const pv = colors ? Object.assign({}, colors, {
      deco, decoTxt: full ? '' : (pt.DECO_TXT[deco] || ''), band: full ? '' : (pt.DECO_BAND[deco] || ''),
      photo, full, left: !!photo && !full, photoStyle: this.photoStyle(photo, full), scrim: d.coverScrim, fade: d.coverPrint === 'fade', shape: d.coverShape,
      title: e.title || book.name || '', footer: e.footer || '', mark: e.mark || '',
      corners: this.cornersOf(e.pattern),
      info: [book.hostName ? `主家：${book.hostName}` : '', book.date ? `日期：${book.date}` : ''].filter(Boolean)
    }) : null;
    const ef = e.font || 'sans';
    const upd = { custErr: err, pv, lockTip: this.lockTip(), effFont: ef, fontName: (pt.FONTS.find(f => f.k === ef) || {}).n || '黑体', effMark: e.mark || '', markName: e.mark || '无', cropAdj: !pt.isDefaultCrop(d.coverCrop) };
    if (pv) { upd.pg = this.pageOf(e, d.isFuneral ? pt.GREY.main : e.main); upd.bk = this.backOf(e, pv); }
    this.setData(upd);
    this.syncPvFonts();
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
    const who = orgtext.t('记账人', d.org); // 机构模式写「礼台人员」（与云端封底一致）
    const sign = ns.length ? `${who}：${ns.join('　')}${sg.total > ns.length ? `等 ${sg.total} 人` : ''}` : `${who}（签字）`;
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

  onDeco(e) {
    this.setData({ deco: e.currentTarget.dataset.k });
    this.refresh();
  },

  onShape(e) {
    const k = e.currentTarget.dataset.k;
    if (k === this.data.coverShape) return;
    this.setData({ coverShape: k });
    this.refresh();
  },

  onLayout(e) {
    const k = e.currentTarget.dataset.k;
    if (k === this.data.coverLayout) return;
    this.setData({ coverLayout: k });
    this.updateQ();
    this.refresh();
  },

  onScrim(e) {
    const k = e.currentTarget.dataset.k;
    if (k === this.data.coverScrim) return;
    this.setData({ coverScrim: k });
    this.refresh();
  },


  /** 打印方式只作用于本次导出 / 预览，不保存 */
  onPrint(e) {
    this.setData({ coverPrint: e.currentTarget.dataset.k });
    this.refresh();
  },

  /** 刚选的照片分辨率提示（三档）；整页版式要求更高 */
  updateQ() {
    const d = this.data;
    if (!d.photoDim) return this.setData({ photoQ: '' });
    const t = pt.photoTier(d.photoDim.w, d.photoDim.h, d.coverLayout);
    this.setData({ photoQ: `照片 ${d.photoDim.w}×${d.photoDim.h} 像素，${t.n}${t.k === 'high' ? '' : d.coverLayout === 'full' ? '（整页建议短边 1100 以上，最好 1600 以上）' : '（建议短边 600 以上）'}` });
  },

  /** 首次上传前的隐私提示（以后不再弹） */
  photoTip() {
    let seen = false;
    try { seen = !!wx.getStorageSync('coverPhotoTip'); } catch (e) { /* 忽略 */ }
    if (seen) return Promise.resolve(true);
    return new Promise(resolve => {
      wx.showModal({
        title: '封面照片提示',
        content: '照片会印在导出的传统礼簿 PDF 封面上。PDF 转发给别人后，对方也能看到这张照片，请确认照片里的人同意。',
        confirmText: '继续', cancelText: '取消',
        success: r => {
          if (r.confirm) { try { wx.setStorageSync('coverPhotoTip', 1); } catch (e) { /* 忽略 */ } }
          resolve(!!r.confirm);
        },
        fail: () => resolve(false)
      });
    });
  },

  /** 选择 / 更换封面照片：压缩 -> 上传 covers/ -> 云端校验、审核并保存（旧照片由云端删除） */
  async onPickPhoto() {
    const d = this.data;
    if (d.photoBusy || d.isFuneral || !d.canSave) return;
    if (!d.photoOk && !d.coverSet) return vip.explain('封面照片', VIP_TIP);
    if (!(await this.photoTip())) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: async res => {
        const f = res.tempFiles[0];
        this.setData({ photoBusy: true });
        wx.showLoading({ title: '正在上传…', mask: true });
        let fileID = '';
        let kept = false; // 网络失败且核对是否已保存也失败：不删文件（v3.83.3）
        try {
          const path = await imgc.cover(f.tempFilePath, f.size);
          if (!path) { wx.hideLoading(); wx.showToast({ title: '照片太大，请换一张', icon: 'none' }); return; }
          const up = await new Promise((resolve, reject) => wx.cloud.uploadFile({
            cloudPath: `covers/book-${getApp().globalData.openid}-${Date.now()}.jpg`,
            filePath: path, success: resolve, fail: reject
          }));
          fileID = up.fileID;
          const done = () => {
            wx.hideLoading();
            this.setData({ coverSet: true, coverUrl: path, coverCrop: { ...pt.CROP_DEFAULT }, photoDim: null });
            this.refresh();
            this.warnSmall(path);
          };
          try {
            await req.bookSetCover(d.id, fileID, d.coverShape, { layout: d.coverLayout, scrim: d.coverScrim, crop: pt.CROP_DEFAULT }); // 新照片裁剪位置回到默认
          } catch (e) {
            if (!req.isNetErr(e)) throw e; // 云端明确拒绝（格式 / 审核 / 权限）：照旧删文件
            // v3.83.3：网络失败时云端可能已经保存了，先核对；核对也失败就不删（宁可留一个文件，也不让礼簿指向已删的照片）
            let saved = null;
            try { saved = !!(await req.bookCoverUrl(d.id, fileID)).is; } catch (e2) { saved = null; }
            if (saved === true) return done();
            if (saved === null) kept = true;
            throw e;
          }
          done();
        } catch (e) {
          wx.hideLoading();
          if (fileID && !kept) wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {}); // 确认没保存的文件尽量删掉（网络错误的提示已由 request.js 弹出）
          if (!fileID) wx.showToast({ title: '上传失败', icon: 'none' });
        } finally {
          this.setData({ photoBusy: false });
        }
      },
      fail: err => {
        if (String((err && err.errMsg) || '').includes('cancel')) return;
        wx.showToast({ title: '无法选择图片', icon: 'none' });
      }
    });
  },

  /** 照片太小打印会模糊：短边不足 600 像素时提醒（不拦截） */
  warnSmall(path) {
    wx.getImageInfo({
      src: path,
      success: r => {
        this.setData({ photoDim: { w: r.width, h: r.height } });
        this.updateQ();
        if (pt.photoTier(r.width, r.height, this.data.coverLayout).k === 'low') wx.showToast({ title: '照片较小，打印可能不清晰', icon: 'none' });
      }
    });
  },

  onRemovePhoto() {
    const d = this.data;
    if (d.photoBusy || !d.coverSet) return;
    wx.showModal({
      title: '移除照片',
      content: '移除后封面不再显示照片，云端的照片文件也会一并删除。',
      confirmText: '移除',
      success: async r => {
        if (!r.confirm) return;
        this.setData({ photoBusy: true });
        try {
          await req.bookSetCover(d.id, '');
          this.setData({ coverSet: false, coverUrl: '', photoDim: null, photoQ: '' });
          this.refresh();
        } catch (e) { /* toast 已提示 */ } finally { this.setData({ photoBusy: false }); }
      }
    });
  },

  noop() {},
  onTogglePv() { this.setData({ pvOpen: !this.data.pvOpen }); },

  /** 会员字体试看提示：第一次弹窗说明（本地记一次），之后只轻提示，不再打断看示意图（v3.83.2） */
  tryHint() {
    let seen = false;
    try { seen = !!wx.getStorageSync('tryFontTip'); } catch (e) { /* 忽略 */ }
    if (seen) return wx.showToast({ title: '会员字体，仅试看', icon: 'none' });
    try { wx.setStorageSync('tryFontTip', 1); } catch (e) { /* 忽略 */ }
    vip.explain('PDF 字体', VIP_TIP);
  },

  /** 字体在「内页」标签选择（全书通用）；预设主题下选字体先转为「在预设基础上修改」 */
  onFontPick(e) {
    const v = e.currentTarget.dataset.v;
    const d = this.data;
    this._pvRetry = true; // 切字体时，之前加载失败的预览字体重试一次
    if (v !== 'sans' && !d.premiumOk) { // 会员字体：示意图可以试看，但不能选中（导出仍按免费样式）
      this.setData({ tryFont: v });
      this.refresh();
      return this.tryHint();
    }
    if (d.tryFont) this.setData({ tryFont: '' }); // 选了可用的字体：结束试看，示意图回到已选字体
    if (v === this.effective().font) return this.refresh();
    if (d.isFuneral) { this.setData({ 'fun.font': v }); return this.refresh(); }
    if (d.themeKey !== 'custom') {
      if (!d.premiumOk) return vip.explain('PDF 主题', VIP_TIP);
      this.setData({ cust: pt.expand(d.themeKey), base: d.themeKey, themeKey: 'custom', defTip: '' });
    }
    this.setData({ 'cust.font': v });
    this.refresh();
  },

  /** 水印字在「内页」标签选择（封面、封底、内页都画，整页照片封面除外）；预设主题下选水印先转为「在预设基础上修改」，会员限制与字体一致；白事直接改 */
  onMarkPick(e) {
    const v = e.currentTarget.dataset.v;
    const d = this.data;
    if (v === (this.effective().mark || '')) return;
    if (d.isFuneral) { this.setData({ 'fun.mark': v }); return this.refresh(); }
    if (d.themeKey !== 'custom') {
      if (!d.premiumOk) return vip.explain('PDF 主题', VIP_TIP);
      this.setData({ cust: pt.expand(d.themeKey), base: d.themeKey, themeKey: 'custom', defTip: '' });
    }
    this.setData({ 'cust.mark': v });
    this.refresh();
  },

  /** 示意图封面里照片的位置与大小（与 PDF 同一个 cropGeom；示意封面 700rpx 宽对应页宽 841.89pt）；还不知道照片尺寸时返回空，用居中裁剪兜底 */
  photoStyle(photo, full) {
    const d = this.data;
    if (!photo || !d.photoDim) return '';
    const box = full ? pt.COVER_BOX.full : pt.COVER_BOX.left;
    const k = 700 / pt.PAGE_PT.w;
    const g = pt.cropGeom(d.photoDim.w, d.photoDim.h, box.w, box.h, d.coverCrop);
    return `position:absolute;left:${(-g.ox * k).toFixed(1)}rpx;top:${(-g.oy * k).toFixed(1)}rpx;width:${(g.iw * k).toFixed(1)}rpx;height:${(g.ih * k).toFixed(1)}rpx;`;
  },

  /** 照片尺寸（image 组件 bindload 给出的原始宽高；网络图片也能取到，不需要域名白名单） */
  /** 照片读不到（临时链接过期 / 网络）：清掉预览地址并提示重新选择 */
  onPhotoErr() {
    if (this.data.photoDim || !this.data.coverUrl) return;
    this.setData({ coverUrl: '' });
    this.refresh();
    wx.showToast({ title: '照片加载失败，请重新选择', icon: 'none' });
  },
  onPhotoLoad(e) {
    const { width, height } = e.detail || {};
    if (!(width > 0 && height > 0)) return;
    this.setData({ photoDim: { w: width, h: height } });
    this.refresh();
  },

  // ===== 裁剪编辑器（自写 touch 手势：单指平移、双指缩放；滑块 / ± / 九宫格为兜底与快捷） =====
  /** 编辑器里裁剪框与照片的位置（单位 rpx，框最大 560 x 620，比例与 PDF 一致） */
  cropRender(edit) { // edit：新的裁剪位置；与界面更新合并成一次 setData（拖动时每帧一次，v3.83.2），不传则用当前 cropEdit
    const d = this.data;
    const e = edit || d.cropEdit;
    const full = d.coverLayout === 'full';
    const box = full ? pt.COVER_BOX.full : pt.COVER_BOX.left;
    const maxH = this._maxH || 620;
    let fw = 560, fh = fw * box.h / box.w;
    if (fh > maxH) { fh = maxH; fw = fh * box.w / box.h; }
    const g = pt.cropGeom(d.photoDim.w, d.photoDim.h, fw, fh, e);
    this._cf = { fw, fh };
    const upd = { cropImg: `position:absolute;left:${(-g.ox).toFixed(1)}rpx;top:${(-g.oy).toFixed(1)}rpx;width:${g.iw.toFixed(1)}rpx;height:${g.ih.toFixed(1)}rpx;` };
    if (edit) upd.cropEdit = edit;
    const w = Math.round(fw), h = Math.round(fh);
    if (d.cropFrame.w !== w || d.cropFrame.h !== h) upd.cropFrame = { w, h };
    const z = Math.round(e.z * 100);
    if (d.cropZ !== z) upd.cropZ = z;
    const bt = full ? (d.coverScrim === 'block' ? 37 : 40) : 0;
    if (d.bandTop !== bt) upd.bandTop = bt;
    this.setData(upd);
  },
  onOpenCrop() {
    const d = this.data;
    if (!d.coverSet || d.isFuneral || d.photoBusy) return;
    if (!d.coverUrl) return wx.showToast({ title: '照片加载失败，请重新选择', icon: 'none' });
    if (!d.photoDim) return wx.showToast({ title: '照片还在加载', icon: 'none' });
    let k = 2, wh = 0;
    try { const w = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); k = 750 / w.windowWidth; wh = w.windowHeight; } catch (e) { /* 取不到按 iPhone 6 宽度 */ }
    this._k = k || 2;
    // 裁剪框高度按窗口高度限制（v3.83.2）：面板最高 94vh，减去标题 / 提示 / 缩放条 / 九宫格 / 按钮栏等约 790rpx；小屏最低 260rpx，再矮面板自己滚动（按钮栏固定在底部）
    this._maxH = wh ? Math.max(260, Math.min(620, Math.round(wh * this._k * 0.94 - 790))) : 620;
    this._g = null;
    this.setData({ cropOpen: true, cropEdit: pt.sanitizeCrop(d.coverCrop) });
    this.cropRender();
  },
  onCropCancel() { this.setData({ cropOpen: false }); },
  onCropDone() {
    this.setData({ cropOpen: false, coverCrop: pt.sanitizeCrop(this.data.cropEdit) });
    this.refresh();
  },
  onCropReset() { this.cropRender({ ...pt.CROP_DEFAULT }); },
  cropZoom(z) {
    const d = this.data, f = this._cf;
    this.cropRender(pt.zoomAt(d.cropEdit, z, d.photoDim.w, d.photoDim.h, f.fw, f.fh));
  },
  onCropZ(e) { this.cropZoom(Number(e.detail.value) / 100); },
  onCropPlus() { this.cropZoom(this.data.cropEdit.z + 0.2); },
  onCropMinus() { this.cropZoom(this.data.cropEdit.z - 0.2); },
  /** 九宫格快捷：位置直接到 0 / 0.5 / 1，缩放不变，之后还可以继续拖动微调 */
  onCropCell(e) {
    const { x, y } = e.currentTarget.dataset;
    const c = this.data.cropEdit;
    this.cropRender(pt.sanitizeCrop({ x: Number(x) / 2, y: Number(y) / 2, z: c.z }));
  },
  /** 手势：按当前 touches 数量重新取基准（单指 -> 双指 -> 抬起一指回到单指，iOS / 安卓的 touches 变化顺序不同，都能接上） */
  cropBase(ts) {
    if (ts.length >= 2) {
      const dx = ts[0].clientX - ts[1].clientX, dy = ts[0].clientY - ts[1].clientY;
      this._g = { mode: 'pinch', dist: Math.sqrt(dx * dx + dy * dy) || 1, z: this.data.cropEdit.z, crop: { ...this.data.cropEdit } };
    } else if (ts.length === 1) {
      this._g = { mode: 'pan', x: ts[0].clientX, y: ts[0].clientY };
    } else {
      this._g = null;
    }
  },
  onCropStart(e) { this.cropBase(e.touches || []); },
  onCropMove(e) {
    const ts = e.touches || [];
    const g = this._g;
    const want = ts.length >= 2 ? 'pinch' : 'pan';
    if (!g || g.mode !== want) return this.cropBase(ts);
    const d = this.data, f = this._cf;
    if (want === 'pan') {
      const dx = (ts[0].clientX - g.x) * this._k, dy = (ts[0].clientY - g.y) * this._k;
      g.x = ts[0].clientX; g.y = ts[0].clientY;
      this.cropRender(pt.panBy(d.cropEdit, dx, dy, d.photoDim.w, d.photoDim.h, f.fw, f.fh));
    } else {
      const dx = ts[0].clientX - ts[1].clientX, dy = ts[0].clientY - ts[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      this.cropRender(pt.zoomAt(g.crop, g.z * dist / g.dist, d.photoDim.w, d.photoDim.h, f.fw, f.fh));
    }
  },
  onCropEnd(e) { this.cropBase(e.touches || []); },

  /** 示意图字体：按 PDF 的分工套用（标题 / 落款 / 姓名用主字体，小字与金额用 sub，水印见 pvfont.keysFor）；加载中轻提示，失败回退系统字体 */
  async syncPvFonts() {
    const e = this.effective();
    const main = this.data.tryFont || e.font || 'sans';
    const mark = e.mark || '';
    const keys = pvfont.keysFor(main, mark);
    const sig = `${main}|${mark}`;
    const retry = !!this._pvRetry; this._pvRetry = false; // 切标签 / 切字体时才重试上次失败的字体，避免每次编辑都重复请求
    if (sig === this._pvSig && !(retry && this._pvBad)) return;
    this._pvSig = sig; this._pvBad = false;
    if (keys.some(k => this._pvLoaded[k] === undefined)) this.setData({ pvLoading: true });
    const fam = {};
    await Promise.all(keys.map(async k => { fam[k] = await pvfont.load(k, this._pvLoaded); }));
    if (sig !== this._pvSig) return; // 期间又换了字体，以最新的为准
    const noneFont = pvfont.state() === 'none'; // 管理员还没上传预览字体（不是加载故障）
    const mainFam = fam[main];
    const subFam = main === 'brush' ? fam.sans : mainFam;
    const markFam = (mark === '囍' || main === 'brush') ? fam.serif : mainFam;
    this._pvBad = !noneFont && keys.some(k => !fam[k]);
    this.setData({
      pvLoading: false, pvNone: noneFont, pvFail: this._pvBad,
      pvf: { main: pvfont.css(mainFam), sub: pvfont.css(subFam), mark: pvfont.css(markFam) }
    });
  },

  /** 草稿快照：主题 / 纹样 / 尾页 / 装订 / 封面照片展示设置（这些在导出或「保存样式」时才保存）；与进页面时一致就不算改动 */
  snap() {
    const d = this.data;
    return JSON.stringify([d.themeKey, d.base, d.cust, d.fun, d.back, d.bind, d.deco, d.coverShape, d.coverLayout, d.coverScrim, d.coverCrop]);
  },
  touch() {
    const dirty = this.snap() !== this._base;
    if (dirty === this.data.dirty) return;
    this.setData({ dirty });
    try {
      if (dirty && this.data.canSave) wx.enableAlertBeforeUnload({ message: '样式还没保存，确定离开吗？' });
      else if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    } catch (e) { /* 低版本没有该接口：不提示 */ }
  },
  clean() {
    this._base = this.snap();
    if (this.data.dirty) this.setData({ dirty: false });
    try { if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload(); } catch (e) { /* 忽略 */ }
  },

  /** 预览：设了封面照片才弹确认面板（选打印方式），否则直接预览 */
  onPreview() {
    const d = this.data;
    if (d.exporting || d.previewing || d.pvLock || d.saving || !d.book) return;
    if (d.coverSet && !d.isFuneral) return this.setData({ sheet: 'preview' });
    this.doPreview();
  },
  /** 导出：先弹确认面板（打印方式只用于本次 + 保存说明） */
  onExport() {
    const d = this.data;
    if (d.exporting || d.previewing || d.saving || !d.book) return;
    this.setData({ sheet: 'export' });
  },
  onSheetClose() { this.setData({ sheet: '' }); },
  onSheetOk() {
    const k = this.data.sheet;
    this.setData({ sheet: '' });
    if (k === 'export') this.doExport();
    else if (k === 'preview') this.doPreview();
  },

  /** 只保存样式（不导出）：需要「管理礼簿」权限，云端再校验一次 */
  async onSaveStyle() {
    const d = this.data;
    if (!d.canSave || d.saving || d.exporting || d.previewing || !d.book) return;
    const params = this.buildParams();
    if (!params) return;
    params.format = 'book';
    params.saveOnly = true;
    this.setData({ saving: true });
    try {
      await req.exportFile(params);
      this.clean();
      wx.showToast({ title: '样式已保存', icon: 'success' });
    } catch (e) {
      wx.showModal({ title: '保存未成功', content: (e && e.message) || '请稍后重试', showCancel: false });
    } finally {
      this.setData({ saving: false });
    }
  },

  /** 导出 / 预览 / 只保存样式共用的参数；自定义配色不合法时提示并返回 null（封面照片展示设置作为草稿一并提交，云端校验后：有权限时保存，否则只用于本次） */
  buildParams() {
    const d = this.data;
    const params = { bookId: d.id, pdfBack: d.back, pdfBind: d.bind, pdfDeco: d.deco, coverPrint: d.coverSet ? d.coverPrint : 'keep' };
    if (d.coverSet && !d.isFuneral) Object.assign(params, { coverShape: d.coverShape, coverLayout: d.coverLayout, coverScrim: d.coverScrim, coverCrop: d.coverCrop });
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
  async doPreview() {
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
  async doExport() {
    const d = this.data;
    if (d.exporting || d.previewing || d.saving || !d.book) return;
    const params = this.buildParams();
    if (!params) return;
    params.format = 'book';
    this.setData({ exporting: true });
    wx.showLoading({ title: '约需半分钟…', mask: true }); // 导出一般 10～30 秒，礼金多时接近 1 分钟（v3.65.2 提示预计时间）
    try {
      const res = await req.exportFile(params);
      if (d.canSave) this.clean(); // 导出时云端已把样式保存到礼簿
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
};

// 这些操作会改动草稿：操作后对比快照，有变化才标记「未保存」（被会员限制拦下的不算）
['onPickTheme', 'onEditPreset', 'onCust', 'onCustInput', 'onFun', 'onFunInput', 'onBackSwitch', 'onBackFooter', 'onBackInput',
  'onBind', 'onDeco', 'onShape', 'onLayout', 'onScrim', 'onCropDone', 'onFontPick', 'onMarkPick'].forEach(n => {
  const f = PAGE[n];
  PAGE[n] = function (e) { const r = f.call(this, e); this.touch(); return r; };
});

Page(PAGE);
