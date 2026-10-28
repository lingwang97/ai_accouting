// pages/advanced/advanced.js — 高级功能（列表，可继续扩展）：机构模式、新礼金提醒、办事日高峰模式、回收站保留时间等
// 所有有账户身份的角色都能进入；无权限的项目仍显示并置灰，写明原因（可用性见 utils/advperm.js，云端另有校验）
// v3.70.0 去掉「工作台刷新频率」：改为智能刷新（有新转账后 10 分钟内 5 秒，见 utils/poller.js），不需要设置；高峰到期缓存见 utils/pollcfg.js
const req = require('../../utils/request.js');
const theme = require('../../utils/theme.js');
const plan = require('../../utils/plan.js');
const pollcfg = require('../../utils/pollcfg.js');
const adv = require('../../utils/advperm.js');
const cache = require('../../utils/cache.js');
const notify = require('../../utils/notify.js');

const TRASH_OPTIONS = [
  { days: 15, name: '15 天（默认）' },
  { days: 30, name: '30 天' },
  { days: 60, name: '60 天' }
];

Page({
  data: {
    themeStyle: '',
    ready: false,
    planReady: false,        // 套餐已加载：未加载前不渲染各卡片，避免先按「免费」渲染再跳变
    hasAccount: false,
    orgMode: false,
    orgName: '',
    org: { enabled: false, reason: '', contact: false, vip: false },
    gift: { enabled: false, reason: '', contact: false, vip: false },
    giftOn: false,           // 新礼金微信提醒（服务端 users.giftNotify，默认关）
    ad: { show: false },
    peak: { enabled: false, on: false, reason: '', contact: false, vip: false, leftText: '' },
    peakHours: 8,
    trash: { enabled: false, reason: '', contact: false, vip: false, max: 15 },
    trashDays: 15,
    trashOpen: false,
    trashOptions: TRASH_OPTIONS.map(o => ({ ...o, enabled: false })),
    adv: null,               // account.advGet：数量与额度、回收站天数（只有主家）
    quota: { show: false },
    saving: false
  },
  onLoad() { theme.early(this); }, // 首帧前同步套主题色（v3.70.1）

  async onShow() {
    theme.apply(this);
    this.startTick();
    const app = getApp();
    try { await app.ensureRole(); } catch (e) { /* 忽略 */ }
    const g = app.globalData;
    this.setData({ hasAccount: !!g.account, ready: true, planReady: !!plan.get(), giftOn: notify.giftOn() }); // 提醒开关先按本机缓存显示，服务端返回后再校正
    this.build();
    if (!g.account) return;
    // 套餐（记账人 / 家人跟随所服务的主家）与最新的高峰到期、提醒开关（可能在别的设备上改过）
    try {
      const [, r, adv2] = await Promise.all([
        plan.load(true), req.pollLevelGet().catch(() => null),
        g.role === 'owner' ? req.advGet().catch(() => null) : Promise.resolve(null)
      ]);
      if (r) {
        pollcfg.set(null, r.peakUntil || 0);
        notify.setGift(r.giftNotify);
        if (r.giftNotify !== undefined) this.setData({ giftOn: r.giftNotify === true });
      }
      this.setData({ adv: adv2 });
    } catch (e) { /* 忽略：按已有数据显示 */ }
    this.setData({ planReady: true });
    this.build();
  },
  onHide() { this.stopTick(); },
  onUnload() { this.stopTick(); },
  /** 高峰模式剩余时间：页面可见时每分钟重算，到期开关自动变回关 */
  startTick() {
    this.stopTick();
    this._tick = setInterval(() => {
      const g = getApp().globalData;
      if (!g.account || !this.data.planReady) return;
      const p = plan.get();
      this.setData({ peak: adv.peakItem({ role: g.role, features: (p && p.features) || {}, peakUntil: pollcfg.peakUntil() }) });
    }, 60000);
  },
  stopTick() { if (this._tick) { clearInterval(this._tick); this._tick = null; } },
  /**
   * 开关复位：用户点开关时原生 switch 自己先翻转，直接 setData 成「原来的值」与页面数据相同，视图层不会刷新，开关会停在翻转后的状态。
   * 所以先写成翻转后的值，回调里再写回原值，强制视图层刷新（v3.64.2）
   */
  resetSwitch(key, back) {
    this.setData({ [key]: !back }, () => this.setData({ [key]: back }));
  },
  /** 按当前身份与套餐重算各项可用性 */
  build() {
    const g = getApp().globalData;
    const p = plan.get();
    const features = (p && p.features) || {};
    const orgMode = !!(g.account && g.account.orgMode);
    const org = adv.orgItem({ role: g.role, orgMode, features });
    const gift = adv.giftItem({ role: g.role, perms: g.perms });
    const ad = adv.adItem({ role: g.role, plan: p && p.plan });
    const peak = adv.peakItem({ role: g.role, features, peakUntil: pollcfg.peakUntil() });
    const trash = adv.trashItem({ role: g.role, features });
    const a2 = this.data.adv;
    const trashDays = a2 && a2.trashDays ? a2.trashDays : 15;
    const quota = adv.quotaItem({ role: g.role, orgMode, adv: a2 });
    this.setData({
      org, gift, ad, peak, trash, trashDays, quota, orgMode,
      orgName: (g.account && g.account.orgName) || '',
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
    if (!this.data.org.enabled) return this.resetSwitch('orgMode', !on);
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
    if (!ok) return this.resetSwitch('orgMode', !on); // 取消：开关复位
    if (!on) return this.saveOrg(false, a.orgName);
    // 打开时填写机构名称（默认沿用已填的或主家称呼）
    const name = await askOrgName(a.orgName || a.accountName);
    if (name === null) return this.resetSwitch('orgMode', false); // 取消：开关复位
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
      this.resetSwitch('orgMode', !on); // 失败复位（request.js 已提示原因）
    }
  },

  // —— 新礼金微信提醒（默认关闭，按人保存） ——
  onGiftTap() {
    const { gift } = this.data;
    if (!gift.enabled) this.explain(gift, '新礼金微信提醒');
  },
  /** 开关：打开时必须在点击回调里先弹订阅授权（第一个 await 之前），同意后才保存为开 */
  onGiftSwitch(e) {
    const on = e.detail.value;
    if (!this.data.gift.enabled || this.data.saving) return this.resetSwitch('giftOn', !on);
    if (!on) return this.saveGift(false);
    // 注意：requestSubscribeMessage 必须由点击直接触发，前面不能有 await
    notify.subscribe().then(ok => {
      if (ok) return this.saveGift(true);
      this.resetSwitch('giftOn', false);
      // subscribe 调用失败时已弹过原因；用户在授权框点了拒绝（含「总是保持以上选择」被拒）时在这里引导
      if (notify.enabled() && !notify.subscribeFailShown()) {
        wx.showModal({
          title: '未开启提醒',
          content: '没有同意订阅，提醒没有开启。如果没有弹出授权窗口，或之前勾选过「总是保持以上选择」并选了拒绝，请点右上角「···」→ 设置 → 通知管理，打开「接收通知」，并把本提醒设为允许，然后再试。',
          showCancel: false, confirmText: '知道了'
        });
      }
    });
  },
  async saveGift(on) {
    this.setData({ saving: true });
    try {
      const r = await req.setGiftNotify(on);
      notify.setGift(r.giftNotify);
      this.setData({ giftOn: r.giftNotify === true });
      wx.showToast({ title: on ? '已开启提醒' : '已关闭提醒', icon: 'none' });
    } catch (err) {
      this.resetSwitch('giftOn', !on); // 失败复位（request 已提示原因）
    } finally {
      this.setData({ saving: false });
    }
  },

  // —— 办事日高峰模式 ——
  onPeakTap() {
    const { peak } = this.data;
    if (!peak.enabled) this.explain(peak, '办事日高峰模式');
  },
  async onPeakSwitch(e) {
    const on = e.detail.value;
    if (!this.data.peak.enabled) return this.resetSwitch('peak.on', !on);
    if (this._peakBusy) return this.resetSwitch('peak.on', !on); // 上一次还没返回：连点不重复提交（v3.69.1）
    this._peakBusy = true;
    try {
      const r = await req.setPeak(on);
      pollcfg.set(null, r.peakUntil || 0);
      this.build();
      wx.showToast({ title: on ? '已开启高峰模式' : '已关闭', icon: 'none' });
    } catch (err) {
      this.resetSwitch('peak.on', !on); // 失败：开关复位（request 已提示原因）
    } finally {
      this._peakBusy = false;
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
