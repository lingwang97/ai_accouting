// pages/start/start.js — 登录后先选身份：办事收礼（主家）/ 去随礼（宾客）/ 帮别人记账（记账人）
// 主家进入创建向导；宾客回首页扫码；记账人说明需要主家发邀请卡
const theme = require('../../utils/theme.js');
const setup = require('../../utils/setup.js');

Page({
  data: {
    clerkTip: false, // 选了「帮别人记账」：显示说明
    themeStyle: ''
  },

  onLoad() { theme.early(this); }, // 首帧前同步套主题色（v3.70.1）

  onShow() {
    theme.apply(this);
  },

  onHost() {
    setup.setIntent('host');
    wx.redirectTo({ url: '/pages/setup/setup' });
  },

  onGuest() {
    setup.setIntent('guest');
    wx.switchTab({ url: '/pages/index/index' });
  },

  onClerk() {
    setup.setIntent('clerk');
    this.setData({ clerkTip: true });
  },

  goClerkGuide() { wx.navigateTo({ url: '/pages/guide/guide?tab=clerk' }); },
  goHome() { wx.switchTab({ url: '/pages/index/index' }); }
});
