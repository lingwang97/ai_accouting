// pages/welcome/welcome.js — 首次登录快速介绍（3 屏，可跳过）；role=clerk 显示记账人版本
const theme = require('../../utils/theme.js');

const SLIDES = {
  host: [
    { icon: 'qrcode', title: '扫码随礼、自动记账', sub: '宾客扫礼簿码登记转账，确认后自动入簿' },
    { icon: 'cash', title: '礼台记账、多人协作', sub: '现金当场登记，邀请记账人分工确认' },
    { icon: 'export', title: '对账导出、人情往来', sub: '一键对账导出，回礼到期提醒不遗漏' }
  ],
  clerk: [
    { icon: 'cash', title: '礼台记账', sub: '现金、微信当场登记，自动打印小票' },
    { icon: 'check', title: '确认收到', sub: '宾客转账后核对到账，一键确认入簿' },
    { icon: 'printer', title: '补打与对账', sub: '小票随时补打，散场按支付方式对账' }
  ]
};

Page({
  data: {
    role: 'host',
    slides: SLIDES.host,
    current: 0,
    themeStyle: ''
  },

  onLoad(options) {
    theme.early(this); // 首帧前同步套主题色（v3.70.1）
    const role = options.role === 'clerk' ? 'clerk' : 'host';
    this.setData({ role, slides: SLIDES[role] });
    try { wx.setStorageSync('guide_seen', true); } catch (e) { /* 忽略 */ }
  },

  onShow() {
    theme.apply(this);
  },

  onChange(e) {
    this.setData({ current: e.detail.current });
  },

  onNext() {
    this.setData({ current: Math.min(this.data.current + 1, this.data.slides.length - 1) });
  },

  /** 跳过 / 先看看 / 开始记账：回首页 */
  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  goAccount() {
    wx.redirectTo({ url: '/pages/account/account' });
  }
});
