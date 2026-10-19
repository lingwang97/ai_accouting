// pages/admin/admin.js — 系统设置（仅管理员）：预热调度配置、付费订阅手动开通（预留）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const theme = require('../../utils/theme.js');

const INTERVALS = [5, 10, 15, 30];
const FUNC_LABEL = {
  login: '登录', account: '主家信息', records: '礼簿 / 工作台', payment: '随礼 / 确认',
  books: '礼簿管理', renqing: '人情往来', export: '导出'
};

Page({
  data: {
    loaded: false,
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
  onSubOpenid(e) { this.setData({ subOpenid: e.detail.value, hostIdx: -1 }); },
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
    this.setData({ hostIdx: i, subOpenid: this.data.hosts[i].ownerOpenid });
  },
  onSubDays(e) { this.setData({ subDays: e.detail.value }); },
  onPlan(e) { this.setData({ planIdx: Number(e.detail.value) }); },

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
