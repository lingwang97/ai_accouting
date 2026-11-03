// pages/myreceipts/myreceipts.js — 宾客：我的随礼记录（等待确认 / 主家未确认收到 / 已取消 / 已入簿，可查看电子回执）
// 列表与操作在共用组件 components/my-gifts 里（往来页「随礼记录」栏同一个），本页只管主题、下拉刷新与分享
const theme = require('../../utils/theme.js');
const mygifts = require('../../utils/mygifts.js');

Page({
  data: { loaded: false, themeStyle: '' },

  onLoad() { theme.early(this); }, // 首帧前同步套主题色（v3.70.1）

  onShow() {
    this.setData({ themeStyle: theme.styleOf(theme.current()) });
    theme.applyNav();
    const mg = this.selectComponent('#mg');
    if (mg) mg.reload(); // 首次进入由组件自己加载；从回执页、随礼页回来时刷新
  },

  onLoaded() { if (!this.data.loaded) this.setData({ loaded: true }); },
  /** 上滑加载更多（v3.85.1：分标签分页） */
  onReachBottom() {
    const mg = this.selectComponent('#mg');
    if (mg) mg.loadMore();
  },
  onPullDownRefresh() {
    const mg = this.selectComponent('#mg');
    (mg ? mg.reload() : Promise.resolve()).then(() => wx.stopPullDownRefresh(), () => wx.stopPullDownRefresh());
  },

  /** 宾客转化：我家也要办事收礼 → 首页（登录后创建礼簿） */
  goHostEntry() { wx.switchTab({ url: '/pages/index/index' }); },
  /** 转发：「分享给主家」按钮转发登记摘要，其余落地首页（宾客扫码随礼，主家创建礼簿） */
  onShareAppMessage(e) {
    return mygifts.shareOf(e) || { title: '慧礼记｜扫码随礼、自动记账、人情往来一本清', path: '/pages/index/index' };
  },
  onShareTimeline() {
    return { title: '慧礼记｜办事收礼，扫码随礼自动记账' };
  }
});
