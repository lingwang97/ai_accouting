// pages/advanced/advanced.js — 高级功能（列表，可继续扩展）；目前只有「待确认刷新频率」
// 刷新频率按人保存在服务端（account.setPollLevel → users.pollLevel），本机缓存见 utils/pollcfg.js；
// 只有主家和有「确认收礼」权限的记账人能设置；套餐 features.fastRefresh 为 false 时高档不可选（会员功能）
const req = require('../../utils/request.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');
const plan = require('../../utils/plan.js');
const pollcfg = require('../../utils/pollcfg.js');

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
    allowed: false,   // 有权限设置
    member: true,     // 套餐含高频刷新（false 显示「会员功能」）
    level: 'off',
    options: OPTIONS,
    saving: false
  },
  async onShow() {
    theme.apply(this);
    const app = getApp();
    try { await app.ensureRole(); } catch (e) { /* 忽略 */ }
    const g = app.globalData;
    const allowed = !!g.account && g.role !== 'viewer' && perm.can('confirm');
    this.setData({ allowed, level: pollcfg.level(), ready: true });
    if (!allowed) return;
    // 套餐与最新设置（可能在别的设备上改过）
    const [p, r] = await Promise.all([plan.load(true), req.pollLevelGet().catch(() => null)]);
    if (r) pollcfg.set(r.pollLevel);
    this.setData({ member: plan.has('fastRefresh'), level: pollcfg.level() });
    if (p && !plan.has('fastRefresh') && pollcfg.level() !== 'off') this.setData({ level: 'off' });
  },
  async onPick(e) {
    const key = e.currentTarget.dataset.key;
    const { allowed, member, level, saving } = this.data;
    if (!allowed || saving || key === level) return;
    if (key !== 'off' && !member) return wx.showToast({ title: '会员功能，暂不可用', icon: 'none' });
    this.setData({ saving: true });
    try {
      const r = await req.setPollLevel(key);
      pollcfg.set(r.pollLevel);
      this.setData({ level: r.pollLevel });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) { /* request 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});
