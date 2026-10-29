// pages/orgsummary/orgsummary.js — 机构版：多场次汇总（每场份数、合计、待确认、现金 / 微信、礼台人员），按月份筛选
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');

Page({
  data: {
    months: [],      // ['全部', '2026-10', ...]
    monthIdx: 0,
    list: [],
    total: { count: 0, sumStr: '0.00', pending: 0 },
    staff: [],
    tab: 'books',    // books 按场次 | staff 按人员
    loading: true,
    themeStyle: ''
  },

  async onLoad() {
    theme.early(this); // 首帧前同步套主题色（v3.70.1）
    if (!(await perm.guard('export', '你没有对账与导出的权限', { viewer: true }))) return; // 文案同 records.orgSummary
    // 最近 12 个月
    const months = ['全部'];
    const d = new Date();
    for (let i = 0; i < 12; i++) {
      const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
      months.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
    }
    this.setData({ months });
  },

  onShow() {
    theme.apply(this);
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    try {
      const month = this.data.monthIdx > 0 ? this.data.months[this.data.monthIdx] : '';
      const r = await req.orgSummary(month);
      this.setData({
        list: r.list.map(b => ({
          ...b,
          typeLabel: scenes.label(b.type),
          sumStr: fmt.money(b.sum),
          cashStr: fmt.money(b.cash),
          wechatStr: fmt.money(b.wechat),
          staffText: b.staff.map(s => `${s.name} ${s.count}份`).join('、'),
          dutyText: b.onDuty.map(s => s.name + (s.title ? `(${s.title})` : '')).join('、')
        })),
        total: { count: r.total.count, sumStr: fmt.money(r.total.sum), pending: r.total.pending },
        staff: r.staff.map(s => ({ ...s, sumStr: fmt.money(s.sum) }))
      });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  onMonth(e) {
    this.setData({ monthIdx: Number(e.detail.value) });
    this.load();
  },
  onTab(e) { this.setData({ tab: e.currentTarget.dataset.t }); },
  onOpen(e) { wx.navigateTo({ url: `/pages/bookdetail/bookdetail?id=${e.currentTarget.dataset.id}` }); }
});
