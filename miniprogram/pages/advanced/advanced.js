// pages/advanced/advanced.js — 高级功能（列表，可继续扩展）：机构模式、工作台刷新屏幕（频率）
// 所有有账户身份的角色都能进入；无权限的项目仍显示并置灰，写明原因（可用性见 utils/advperm.js，云端另有校验）
// 工作台刷新屏幕默认收起（pollOpen）；刷新频率按人保存在服务端（account.setPollLevel → users.pollLevel），本机缓存见 utils/pollcfg.js
const req = require('../../utils/request.js');
const theme = require('../../utils/theme.js');
const plan = require('../../utils/plan.js');
const pollcfg = require('../../utils/pollcfg.js');
const adv = require('../../utils/advperm.js');
const cache = require('../../utils/cache.js');

const SHORT = { off: '标准', low: '8 秒', mid: '5 秒', high: '3 秒' };
const TRASH_OPTIONS = [
  { days: 15, name: '15 天（默认）' },
  { days: 30, name: '30 天' },
  { days: 60, name: '60 天' }
];
const OPTIONS = [
  { key: 'off', name: '标准（默认）', desc: '10 秒起，长时间没有新转账会自动放慢，最慢 1 分钟一次，最省流量' },
  { key: 'low', name: '较快 · 8 秒', desc: '固定每 8 秒刷新一次' },
  { key: 'mid', name: '快 · 5 秒', desc: '固定每 5 秒刷新一次' },
  { key: 'high', name: '最快 · 3 秒', desc: '固定每 3 秒刷新一次，办事高峰时使用' }
];

Page({
  data: {
    themeStyle: '',
    ready: false,
    hasAccount: false,
    orgMode: false,
    orgName: '',
    org: { enabled: false, reason: '', contact: false, vip: false },
    poll: { enabled: false, reason: '', contact: false, vip: false },
    ad: { show: false },
    peak: { enabled: false, on: false, reason: '', contact: false, vip: false, leftText: '' },
    peakHours: 8,
    trash: { enabled: false, reason: '', contact: false, vip: false, max: 15 },
    trashDays: 15,
    trashOpen: false,
    trashOptions: TRASH_OPTIONS.map(o => ({ ...o, enabled: false })),
    adv: null,               // account.advGet：数量与额度、回收站天数（只有主家）
    quota: { show: false },
    level: 'off',
    levelName: '标准',
    pollOpen: false,
    options: OPTIONS.map(o => ({ ...o, enabled: false })),
    saving: false
  },
  async onShow() {
    theme.apply(this);
    const app = getApp();
    try { await app.ensureRole(); } catch (e) { /* 忽略 */ }
    const g = app.globalData;
    this.setData({ hasAccount: !!g.account, ready: true });
    this.build();
    if (!g.account) return;
    // 套餐（记账人 / 家人跟随所服务的主家）与最新刷新设置（可能在别的设备上改过）
    const [, r, adv2] = await Promise.all([
      plan.load(true), req.pollLevelGet().catch(() => null),
      g.role === 'owner' ? req.advGet().catch(() => null) : Promise.resolve(null)
    ]);
    if (r) pollcfg.set(r.pollLevel, r.peakUntil || 0);
    this.setData({ adv: adv2 });
    this.build();
  },
  /** 按当前身份与套餐重算各项可用性 */
  build() {
    const g = getApp().globalData;
    const p = plan.get();
    const features = (p && p.features) || {};
    const orgMode = !!(g.account && g.account.orgMode);
    const org = adv.orgItem({ role: g.role, orgMode, features });
    const poll = adv.pollItem({ role: g.role, perms: g.perms, features });
    const ad = adv.adItem({ role: g.role, plan: p && p.plan });
    const peak = adv.peakItem({ role: g.role, features, peakUntil: pollcfg.peakUntil() });
    const trash = adv.trashItem({ role: g.role, features });
    const a2 = this.data.adv;
    const trashDays = a2 && a2.trashDays ? a2.trashDays : 15;
    const quota = adv.quotaItem({ role: g.role, orgMode, adv: a2 });
    const saved = pollcfg.level();
    const level = poll.enabled && adv.pollOptionEnabled(poll, saved) ? saved : 'off';
    this.setData({
      org, poll, ad, peak, trash, trashDays, quota, orgMode, levelName: SHORT[level],
      orgName: (g.account && g.account.orgName) || '',
      level,
      options: OPTIONS.map(o => ({ ...o, enabled: adv.pollOptionEnabled(poll, o.key) })),
      trashOptions: TRASH_OPTIONS.map(o => ({ ...o, enabled: adv.trashOptionEnabled(trash, o.days) }))
    });
  },
  /** 置灰项被点：弹窗说明原因；需要开通套餐的带「联系我们」，其余只有「知道了」 */
  explain(item, title) {
    if (item.contact) {
      wx.showModal({
        title, content: item.reason, confirmText: '联系我们', cancelText: '知道了',
        success: r => { if (r.confirm) wx.navigateTo({ url: '/pages/contact/contact' }); }
      });
    } else wx.showModal({ title, content: item.reason, showCancel: false, confirmText: '知道了' });
  },

  // —— 机构模式：婚庆公司、宴会厅等一个账号办多场 ——
  onOrgTap() {
    const { org } = this.data;
    if (!org.enabled) this.explain(org, '机构模式');
  },
  async onOrgSwitch(e) {
    const on = e.detail.value;
    const a = getApp().globalData.account || {};
    if (!this.data.org.enabled) return this.setData({ orgMode: !on });
    // 开关会改变记账人的负责范围：先说明
    const ok = await new Promise(resolve => wx.showModal({
      title: on ? '开启机构模式' : '关闭机构模式',
      content: on
        ? '开启后：记账人按「礼台人员」设置可负责多个场次，各自出示本场礼簿码；底部「往来」隐藏。记账人负责的场次恢复为机构模式下的设置。'
        : '关闭后：每位记账人只负责一本礼簿（按你在非机构模式下给他选的那本，没选过的跟随当前礼簿）；底部「往来」恢复显示。',
      confirmText: on ? '开启' : '关闭',
      success: r => resolve(r.confirm),
      fail: () => resolve(false)
    }));
    if (!ok) return this.setData({ orgMode: !on }); // 取消：开关复位
    if (!on) return this.saveOrg(false, a.orgName);
    // 打开时填写机构名称（默认沿用已填的或主家称呼）
    const name = await askOrgName(a.orgName || a.accountName);
    if (name === null) return this.setData({ orgMode: false }); // 取消：开关复位
    this.saveOrg(true, name);
  },
  /** 修改机构名称（仅已开启时显示） */
  async onOrgName() {
    const a = getApp().globalData.account;
    if (!a || !a.orgMode || !this.data.org.enabled) return;
    const name = await askOrgName(a.orgName || a.accountName);
    if (name !== null) this.saveOrg(true, name);
  },
  async saveOrg(on, orgName) {
    try {
      const r = await req.setOrgMode(on, orgName);
      const app = getApp();
      app.globalData.account = { ...app.globalData.account, orgMode: r.orgMode, orgName: r.orgName };
      cache.clear(); // 工作台入口随模式变化
      app.refreshTabBar(); // 机构模式不显示「往来」
      this.build();
      wx.showToast({ title: on ? '已开启机构模式' : '已关闭机构模式', icon: 'none' });
    } catch (err) {
      this.setData({ orgMode: !on }); // 失败复位（request.js 已提示原因）
    }
  },

  // —— 办事日高峰模式 ——
  onPeakTap() {
    const { peak } = this.data;
    if (!peak.enabled) this.explain(peak, '办事日高峰模式');
  },
  async onPeakSwitch(e) {
    const on = e.detail.value;
    if (!this.data.peak.enabled) return this.build();
    try {
      const r = await req.setPeak(on);
      pollcfg.set(pollcfg.level(), r.peakUntil || 0);
      this.build();
      wx.showToast({ title: on ? '已开启高峰模式' : '已关闭', icon: 'none' });
    } catch (err) {
      this.build(); // 失败：开关复位（request 已提示原因）
    }
  },

  // —— 回收站保留时间 ——
  onTrashHead() {
    const { trash, trashOpen } = this.data;
    if (!trash.enabled) return this.explain(trash, '回收站保留时间');
    this.setData({ trashOpen: !trashOpen });
  },
  async onTrashPick(e) {
    const days = Number(e.currentTarget.dataset.days);
    const { trash, trashDays, saving } = this.data;
    if (saving) return;
    if (!adv.trashOptionEnabled(trash, days)) return this.explain(trash, '回收站保留时间');
    if (days === trashDays) return;
    this.setData({ saving: true });
    try {
      const r = await req.setTrashDays(days);
      this.setData({ trashDays: r.trashDays, adv: { ...(this.data.adv || {}), trashDays: r.trashDays } });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) { /* request 已提示 */ } finally {
      this.setData({ saving: false });
    }
  },

  /** 数量额度：达到上限时点击说明 */
  onQuotaTap() {
    const q = this.data.quota;
    if (q.full) this.explain({ contact: true, reason: q.reason }, '数量额度');
  },

  /** 去广告：未开通时点击说明如何开通 */
  onAdTap() {
    if (!this.data.ad.member) this.explain({ contact: true, reason: '开通会员后，主家与记账人使用的页面不再显示广告' }, '去广告');
  },

  // —— 工作台刷新屏幕 ——
  /** 标题行：无权限弹原因；否则展开 / 收起档位 */
  onPollHead() {
    const { poll, pollOpen } = this.data;
    if (!poll.enabled) return this.explain(poll, '工作台刷新屏幕');
    this.setData({ pollOpen: !pollOpen });
  },
  async onPick(e) {
    const key = e.currentTarget.dataset.key;
    const { poll, level, saving } = this.data;
    if (saving) return;
    if (!adv.pollOptionEnabled(poll, key)) return this.explain(poll, '工作台刷新屏幕');
    if (key === level) return;
    this.setData({ saving: true });
    try {
      const r = await req.setPollLevel(key);
      pollcfg.set(r.pollLevel);
      this.setData({ level: r.pollLevel, levelName: SHORT[r.pollLevel] || '标准' });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) { /* request 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});

/** 输入机构名称；取消返回 null */
function askOrgName(def) {
  return new Promise(resolve => {
    wx.showModal({
      title: '机构名称',
      editable: true,
      content: def || '',
      placeholderText: '如：喜来登宴会厅',
      confirmText: '确定',
      success: res => resolve(res.confirm ? String(res.content || '').trim() : null),
      fail: () => resolve(null)
    });
  });
}
