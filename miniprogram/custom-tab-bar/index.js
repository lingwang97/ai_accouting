// custom-tab-bar — 自定义底部菜单
// 「礼簿」「往来」未登录时页面内提示登录，登录后才显示数据；记账人身份不显示「往来」（人情往来属于本人，记账时不需要）
// 机构模式下所有人都不显示「往来」（机构办事不需要个人人情往来；关闭机构模式后恢复，数据不删）
// 第一个菜单：主家 / 记账人为「工作台」（待确认角标画在这里），宾客为「首页」
// 选中颜色跟礼簿事由走（喜事红、白事灰，见 utils/theme.js）
const theme = require('../utils/theme.js');

const TABS = [
  { path: 'pages/index/index', text: '首页', hostText: '工作台', icon: 'home', badge: true },
  { path: 'pages/records/records', text: '礼簿', icon: 'book' },
  { path: 'pages/renqing/renqing', text: '往来', icon: 'people', dot: true, hideClerk: true, hideOrg: true },
  { path: 'pages/mine/mine', text: '我的', icon: 'user' }
];

Component({
  data: {
    list: [],
    selected: '',
    badge: '',
    dot: false,
    color: theme.current().primary,
    iconOn: theme.current().icon
  },

  lifetimes: {
    attached() { this.refresh(); }
  },

  // 每个 tab 页各有一个菜单实例：页面切回时按全局状态重画，避免别的页面改过红点 / 角标后这里仍显示旧状态
  pageLifetimes: {
    show() { this.refresh(); }
  },

  methods: {
    /** 按登录状态、身份与角标数刷新（各 tab 页 onShow、登录/退出、角标变化时调用） */
    refresh() {
      const app = getApp();
      const isHost = !!(app && app.globalData.user && app.globalData.account);
      const pages = getCurrentPages();
      const cur = pages.length ? pages[pages.length - 1].route : '';
      const n = (app && app.globalData.badge) || 0;
      const t = theme.current();
      const org = !!(app && app.globalData.account && app.globalData.account.orgMode);
      this.setData({
        list: TABS.filter(x => !(x.hideClerk && app && app.globalData.role === 'clerk') && !(x.hideOrg && org))
          .map(x => ({ ...x, label: isHost && x.hostText ? x.hostText : x.text })),
        selected: cur,
        dot: !!(app && app.globalData.remindDot && app.globalData.user),
        badge: n > 0 ? (n > 99 ? '99+' : String(n)) : '',
        color: t.primary,
        iconOn: t.icon
      });
    },

    onTap(e) {
      const path = e.currentTarget.dataset.path;
      if (path !== this.data.selected) wx.switchTab({ url: '/' + path });
    }
  }
});
