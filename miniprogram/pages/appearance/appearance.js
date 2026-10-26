// pages/appearance/appearance.js — 外观设置：主家选择主题色，实时预览工作台、按钮与底部菜单
const req = require('../../utils/request.js');
const theme = require('../../utils/theme.js');

// 预览用的底部菜单
const TABS = [
  { icon: 'home', label: '工作台' },
  { icon: 'book', label: '礼簿' },
  { icon: 'people', label: '往来' },
  { icon: 'user', label: '我的' }
];

Page({
  data: {
    colors: theme.PRESET_COLORS,
    primary: theme.DEFAULT,
    saved: theme.DEFAULT,  // 已保存的主题色，未改动时不可保存
    pv: theme.make(theme.DEFAULT), // 预览主题 { primary, soft, icon }；先给默认值，首帧图标路径不为空
    pvStyle: '',           // 预览区域的 CSS 变量
    tabs: TABS,
    saving: false,
    themeStyle: ''
  },

  onShow() {
    theme.apply(this);
    const account = getApp().globalData.account;
    const t = account && account.theme;
    const primary = t && t.chosen ? t.primary : theme.DEFAULT;
    this.setData({ saved: primary });
    this.preview(primary);
  },

  /** 按所选颜色刷新预览 */
  preview(primary) {
    const pv = theme.make(primary);
    this.setData({ primary: pv.primary, pv, pvStyle: theme.styleOf(pv) });
  },

  onPickColor(e) {
    this.preview(e.currentTarget.dataset.c);
  },

  async onSave() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      const { account } = await req.setTheme(this.data.primary);
      getApp().globalData.account = account;
      theme.setAccount(account); // 主题色立即生效
      theme.apply(this);
      this.setData({ saved: this.data.primary });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      // request.js 已 toast
    } finally {
      this.setData({ saving: false });
    }
  }
});
