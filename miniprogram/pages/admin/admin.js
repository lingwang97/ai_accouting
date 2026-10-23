// pages/admin/admin.js — 系统设置（仅管理员）：预热调度配置、付费订阅手动开通（预留）
const req = require('../../utils/request.js');
const openfile = require('../../utils/openfile.js');
const fmt = require('../../utils/format.js');
const theme = require('../../utils/theme.js');
const config = require('../../config.js');

const INTERVALS = [5, 10, 15, 30];
const FUNC_LABEL = {
  login: '登录', account: '主家信息', records: '礼簿 / 工作台', payment: '随礼 / 确认',
  books: '礼簿管理', renqing: '人情往来', export: '导出'
};

Page({
  data: {
    loaded: false,
    // 数据清除
    purgeTab: 'account', purgeOpenid: '', purgeGuest: false, purgePv: null, purgeBackup: null, purgeBackedUp: false,
    launched: true, wipeKeepAdmins: true, wipeRows: null, wiping: false, // 清除全部测试数据（未上线时可用）
    backingUp: false, purging: false, bookKeyword: '', purgeBooks: [], orphanRows: null, orphanLoading: false, logs: [],
    warmup: null,
    funcs: [],          // [{ name, label, on }]
    intervals: INTERVALS,
    statusText: '',
    plans: [],          // [{ key, name, featuresText }]
    planIdx: 1,
    subOpenid: '',
    subDays: '30',
    hostKeyword: '',
    hosts: [],          // 搜索结果 [{ ownerOpenid, accountName, orgName, planName, expiresStr }]
    hostIdx: -1,        // 选中的主家
    saving: false,
    indexing: false,
    ads: null,          // 广告位配置
    adSlots: [],        // [{ key, label, on }]
    indexResults: [],   // [{ col, name, ok, existed, msg }]
    indexSummary: '',
    pf: null, pfLoading: false, // 上线前检查结果
    fontLoading: false, // 上传导出字体中
    themeStyle: ''
  },

  onShow() { this.setData({ primary: theme.apply(this).primary }); },

  async onLoad() {
    try {
      const d = await req.adminGet();
      const plans = Object.keys(d.plans).map(k => ({
        key: k,
        name: d.plans[k].name || k,
        featuresText: Object.entries(d.plans[k].features || {}).map(([f, v]) => `${f}: ${v === 0 ? '不限' : v}`).join('，')
      }));
      this.setData({
        loaded: true,
        launched: !!d.launched,
        warmup: d.warmup,
        funcs: d.warmable.map(n => ({ name: n, label: FUNC_LABEL[n] || n, on: d.warmup.functions.includes(n) })),
        statusText: statusText(d.status),
        plans,
        planIdx: Math.max(0, plans.findIndex(p => p.key !== 'free')),
        ads: d.ads,
        adSlots: Object.keys(d.adSlots).map(k => ({ key: k, label: d.adSlots[k], on: !!d.ads.slots[k] }))
      });
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  onEnabled(e) { this.setData({ 'warmup.enabled': e.detail.value }); },
  onMode(e) { this.setData({ 'warmup.mode': e.currentTarget.dataset.v }); },
  onInterval(e) { this.setData({ 'warmup.intervalMin': Number(e.currentTarget.dataset.v) }); },
  onFunc(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ [`funcs[${i}].on`]: !this.data.funcs[i].on });
  },

  async onSaveWarmup() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      const warmup = { ...this.data.warmup, functions: this.data.funcs.filter(f => f.on).map(f => f.name) };
      const r = await req.adminSetWarmup(warmup);
      this.setData({ warmup: r.warmup });
      wx.showToast({ title: '已保存，下次触发生效', icon: 'none' });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  },

  // —— 广告位（流量主） ——
  onAdsEnabled(e) { this.setData({ 'ads.enabled': e.detail.value }); },
  onAdsUnit(e) { this.setData({ 'ads.bannerUnit': e.detail.value.trim() }); },
  onAdsFuneral(e) { this.setData({ 'ads.hideFuneral': e.detail.value }); },
  onAdsPaid(e) { this.setData({ 'ads.paidHide': e.detail.value }); },
  onAdSlot(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ [`adSlots[${i}].on`]: !this.data.adSlots[i].on });
  },
  async onSaveAds() {
    const slots = {};
    this.data.adSlots.forEach(s => { slots[s.key] = s.on; });
    try {
      const r = await req.adminSetAds({ ...this.data.ads, slots });
      this.setData({ ads: r.ads });
      require('../../utils/ads.js').reset();
      wx.showToast({ title: '已保存（各端 10 分钟内生效）', icon: 'none' });
    } catch (e) { /* toast 已提示 */ }
  },

  // —— 上线前检查：密钥来源、必需集合、WX_APPSECRET、版本号；fix=true 时建缺失集合 ——
  async onPreflight(e) {
    if (this.data.pfLoading) return;
    const fix = !!(e && e.currentTarget && e.currentTarget.dataset.fix);
    this.setData({ pfLoading: true });
    try {
      const r = await req.adminPreflight(fix);
      const SRC = { env: '环境变量 PERSON_KEY_SECRET', db: '已自动生成并保存在数据库', default: '内置默认值（数据库读取失败时的兜底，请排查）', '': '尚未使用（人情往来页首次打开时自动生成）' };
      const keyText = (SRC[r.key.source] !== undefined ? SRC[r.key.source] : r.key.source) + (r.key.createdAt ? '，创建于 ' + fmt.day(r.key.createdAt) : '');
      this.setData({
        pf: {
          keyText, keyOk: r.key.source === 'env' || r.key.source === 'db' || (!r.key.source && !r.key.generated),
          missing: r.missing, colsOk: !r.missing.length, total: r.cols.length,
          appSecret: r.hasAppSecret, version: config.VERSION, permCols: r.permCols.join('、'),
          fontsOk: !r.fonts || r.fonts.ready, fontsMissing: r.fonts ? r.fonts.fonts.filter(f => !f.uploaded).map(f => f.label).join('、') : ''
        }
      });
      if (fix) wx.showToast({ title: r.missing.length ? '仍有集合缺失' : '集合已齐全', icon: 'none' });
    } catch (err) { /* toast 已提示 */ } finally {
      this.setData({ pfLoading: false });
    }
  },

  // —— 导出字体：一次性上传到云存储（fontsetup 云函数，管理员） ——
  async onFontsUpload() {
    if (this.data.fontLoading) return;
    this.setData({ fontLoading: true });
    wx.showLoading({ title: '上传中，请稍候', mask: true });
    try {
      await req.adminFontsUpload();
      wx.hideLoading();
      wx.showToast({ title: '字体已上传', icon: 'success' });
      this.onPreflight();
    } catch (e) {
      wx.hideLoading();
      // 云函数没部署 / 超时 / 无权限：给明确指引
      wx.showModal({ title: '上传失败', content: (e && e.message && e.message !== 'biz error') ? e.message : '请确认已部署 fontsetup 云函数后重试', showCancel: false, confirmText: '知道了' });
    } finally {
      this.setData({ fontLoading: false });
    }
  },

  // —— 数据库索引：一键创建（已存在的跳过） ——
  async onIndexes() {
    if (this.data.indexing) return;
    this.setData({ indexing: true, indexResults: [], indexSummary: '' });
    try {
      const r = await req.adminIndexes();
      this.setData({
        indexResults: r.results,
        indexSummary: r.failed ? `${r.failed} 条失败，见下方原因` : `全部完成：新建 ${r.created} 条，其余已存在`
      });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ indexing: false });
    }
  },

  // —— 订阅（预留）：手动开通 / 延期 / 取消 ——
  // 换了账户：之前的清除预览与备份作废
  onSubOpenid(e) { this.setData({ subOpenid: e.detail.value, hostIdx: -1, purgePv: null, purgeBackup: null, purgeBackedUp: false }); },
  onHostKeyword(e) { this.setData({ hostKeyword: e.detail.value }); },
  async onFindHosts() {
    const k = (this.data.hostKeyword || '').trim();
    if (!k) return wx.showToast({ title: '请输入主家称呼', icon: 'none' });
    try {
      const { list } = await req.adminFindHosts(k);
      this.setData({ hosts: list.map(h => ({ ...h, expiresStr: h.expiresAt ? fmt.day(h.expiresAt) : '' })), hostIdx: -1 });
      if (!list.length) wx.showToast({ title: '没有找到', icon: 'none' });
    } catch (e) { /* toast 已提示 */ }
  },
  onPickHost(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({ hostIdx: i, subOpenid: this.data.hosts[i].ownerOpenid, purgePv: null, purgeBackup: null, purgeBackedUp: false });
  },
  onSubDays(e) { this.setData({ subDays: e.detail.value }); },
  onPlan(e) { this.setData({ planIdx: Number(e.detail.value) }); },

  // —— 数据清除（不可恢复：预览 → 备份 → 输入名称确认） ——
  onPurgeTab(e) {
    const t = e.currentTarget.dataset.t;
    this.setData({ purgeTab: t });
    if (t === 'logs') this.loadLogs();
  },
  onPurgeOpenid(e) { this.setData({ purgeOpenid: e.detail.value, purgePv: null, purgeBackup: null, purgeBackedUp: false }); },
  onPurgeGuest(e) { this.setData({ purgeGuest: e.detail.value, purgePv: null }); },
  onPurgeBackedUp(e) { this.setData({ purgeBackedUp: e.detail.value }); },
  purgeTarget() { return (this.data.purgeOpenid || this.data.subOpenid || '').trim(); },

  async onPurgePreview() {
    const openid = this.purgeTarget();
    if (!openid) return wx.showToast({ title: '请先选择或填写账户', icon: 'none' });
    try {
      const pv = await req.adminPurgePreview(openid, this.data.purgeGuest);
      this._pvOpenid = openid; // 备份、清除都以预览时的账户为准
      this.setData({ purgePv: pv, purgeBackup: null, purgeBackedUp: false });
    } catch (e) { this.setData({ purgePv: null }); }
  },

  /** 备份：生成该账户的全量 Excel（云端保留 7 天），并打开 */
  async onPurgeBackup() {
    if (this.data.backingUp || !this.data.purgePv || !this._pvOpenid) return;
    this.setData({ backingUp: true });
    try {
      const r = await req.adminBackup(this._pvOpenid);
      this.setData({ purgeBackup: r, purgeBackedUp: true });
      try {
        const path = await openfile.download(r.fileID, r.fileName);
        openfile.open(path, r.fileName);
      } catch (e) { /* 下载失败不影响：云端已保留 7 天 */ }
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ backingUp: false });
    }
  },

  /** 执行：输入主家称呼确认 */
  onPurgeRun() {
    const pv = this.data.purgePv;
    if (!pv || this.data.purging) return;
    wx.showModal({
      title: '输入名称确认',
      editable: true,
      placeholderText: `请输入「${pv.name}」`,
      confirmText: '清除',
      confirmColor: '#FA5151',
      success: async res => {
        if (!res.confirm) return;
        if ((res.content || '').trim() !== pv.name) return wx.showToast({ title: '名称不一致，未清除', icon: 'none' });
        this.setData({ purging: true });
        try {
          // 有备份带 backupId；没备份需打开「不需要备份」才带 skipBackup
          const bk = this.data.purgeBackup && this.data.purgeBackup.backupId;
          const r = await req.adminPurge({
            ownerOpenid: this._pvOpenid, confirmName: pv.name, guestRecords: this.data.purgeGuest, backedUp: this.data.purgeBackedUp,
            ...(bk ? { backupId: bk } : { skipBackup: !!this.data.purgeBackedUp })
          });
          const total = r.removed.reduce((t, x) => t + x.count, 0);
          wx.showModal({ title: '已清除', content: `共删除 ${total} 条数据、${r.files} 个文件。数据较多时如未删完，可再执行一次。`, showCancel: false });
          this.setData({ purgePv: null, purgeOpenid: '', purgeBackedUp: false, purgeBackup: null });
        } catch (e) { /* toast 已提示 */ } finally {
          this.setData({ purging: false });
        }
      }
    });
  },

  onBookKeyword(e) { this.setData({ bookKeyword: e.detail.value }); },
  async onBookSearch() {
    const k = (this.data.bookKeyword || '').trim();
    if (!k) return wx.showToast({ title: '请输入礼簿名称', icon: 'none' });
    try {
      const { list } = await req.adminBookPreview(k);
      this.setData({ purgeBooks: list });
      if (!list.length) wx.showToast({ title: '没有找到', icon: 'none' });
    } catch (e) { /* toast 已提示 */ }
  },
  onPurgeBook(e) {
    const b = this.data.purgeBooks[Number(e.currentTarget.dataset.i)];
    if (!b) return;
    wx.showModal({
      title: '删除礼簿',
      editable: true,
      placeholderText: `输入「${b.name}」确认，将删除 ${b.count} 条礼金`,
      confirmText: '删除',
      confirmColor: '#FA5151',
      success: async res => {
        if (!res.confirm) return;
        if ((res.content || '').trim() !== b.name) return wx.showToast({ title: '名称不一致，未删除', icon: 'none' });
        try {
          await req.adminPurgeBook(b._id, b.name);
          wx.showToast({ title: '已删除', icon: 'success' });
          this.onBookSearch();
        } catch (err) { /* toast 已提示 */ }
      }
    });
  },

  async onOrphanPreview() {
    this.setData({ orphanLoading: true });
    try {
      const { rows } = await req.adminOrphanPreview();
      this.setData({ orphanRows: rows });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ orphanLoading: false });
    }
  },
  onOrphanPurge() {
    wx.showModal({
      title: '清理无主数据',
      content: '将删除扫描到的全部无主数据，不可恢复。',
      confirmText: '清理',
      confirmColor: '#FA5151',
      success: async res => {
        if (!res.confirm) return;
        this.setData({ purging: true });
        try {
          const { rows, files } = await req.adminOrphanPurge();
          wx.showModal({ title: '已清理', content: `共删除 ${rows.reduce((t, x) => t + x.count, 0)} 条数据、${files} 个文件。`, showCancel: false });
          this.setData({ orphanRows: null });
        } catch (e) { /* toast 已提示 */ } finally {
          this.setData({ purging: false });
        }
      }
    });
  },

  // —— 清除全部测试数据（上线前一次性）——
  onWipeKeep(e) { this.setData({ wipeKeepAdmins: e.detail.value, wipeRows: null }); },
  async onWipePreview() {
    try {
      const { rows } = await req.adminWipePreview(this.data.wipeKeepAdmins);
      this.setData({ wipeRows: rows });
    } catch (e) { /* toast 已提示 */ }
  },
  onWipeAll() {
    if (this.data.wiping) return;
    wx.showModal({
      title: '清除全部测试数据',
      editable: true,
      placeholderText: '请输入「清除全部测试数据」',
      confirmText: '清除',
      confirmColor: '#FA5151',
      success: res => {
        if (!res.confirm) return;
        const text = (res.content || '').trim();
        if (text !== '清除全部测试数据') return wx.showToast({ title: '输入不一致，未清除', icon: 'none' });
        this.runWipe(text, 0);
      }
    });
  },
  /** 数据多时云函数分批返回 done=false，自动继续，直到删完 */
  async runWipe(text, total) {
    this.setData({ wiping: true });
    wx.showLoading({ title: '清除中…', mask: true });
    try {
      const r = await req.adminWipeAll(text, this.data.wipeKeepAdmins);
      total += r.removed.reduce((t, x) => t + x.count, 0);
      if (!r.done) return this.runWipe(text, total);
      wx.hideLoading();
      wx.showModal({ title: '已清除', content: `共删除 ${total} 条测试数据。确认已清理干净后，可点「标记正式上线」永久关闭此功能。`, showCancel: false });
      this.setData({ wipeRows: null, wiping: false });
      require('../../utils/cache.js').clear();
    } catch (e) {
      wx.hideLoading();
      this.setData({ wiping: false });
    }
  },
  onMarkLaunched() {
    wx.showModal({
      title: '标记正式上线',
      content: '标记后「清除全部测试数据」将永久关闭，无法在小程序里恢复。确定已完成测试数据清理？',
      confirmText: '标记',
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.adminMarkLaunched();
          this.setData({ launched: true, purgeTab: 'account' });
          wx.showToast({ title: '已标记上线', icon: 'success' });
        } catch (e) { /* toast 已提示 */ }
      }
    });
  },

  async loadLogs() {
    try {
      const { list } = await req.adminLogs();
      const T = { purgeAccount: '清除账户', purgeBook: '删除礼簿', purgeOrphans: '清理无主数据', wipeAll: '清除全部测试数据', markLaunched: '标记正式上线' };
      this.setData({
        logs: list.map(l => ({
          _id: l._id,
          title: `${T[l.action] || l.action}${l.name ? '「' + l.name + '」' : ''}`,
          timeStr: fmt.dateTime(l.at),
          detail: (l.removed || []).map(x => `${x.label} ${x.count}`).join('、') || '无数据'
        }))
      });
    } catch (e) { /* toast 已提示 */ }
  },

  async onSetPlan() {
    const p = this.data.plans[this.data.planIdx];
    if (!p) return;
    const openid = (this.data.subOpenid || '').trim();
    if (!openid) return wx.showToast({ title: '请填写主家 openid', icon: 'none' });
    try {
      const r = await req.adminSetPlan(openid, p.key, Number(this.data.subDays) || 30);
      const host = this.data.hosts[this.data.hostIdx];
      wx.showModal({
        title: '已生效',
        content: `${host ? '「' + host.accountName + '」' : ''}当前套餐：${r.planName || r.plan}${r.expiresAt ? '，到期 ' + fmt.dateTime(r.expiresAt) : ''}。对方重新进入「我的」即可看到；开通机构版后在「主家信息」底部打开机构模式。`,
        showCancel: false
      });
      if (host) this.onFindHosts(); // 刷新列表里的套餐显示
    } catch (e) { /* toast 已提示 */ }
  }
});

function statusText(s) {
  if (!s || !s.at) return '尚未运行（请确认已上传 warmer 的定时触发器）';
  const t = fmt.dateTime(s.at);
  if (s.skipped) return `${t} · 未预热：${s.skipped}`;
  return `${t} · 已预热 ${(s.called || []).join('、') || '无'}`;
}
