// custom-tab-bar — 自定义底部菜单
// 「礼簿」只对已登录的主家显示；宾客（未登录）只看到 首页 / 往来 / 我的
// 原生 tabBar 无法单独隐藏某一项，因此改为自定义；「我的」待确认角标也在此绘制
const TABS = [
  { path: 'pages/index/index', text: '首页', icon: 'tab-home' },
  { path: 'pages/records/records', text: '礼簿', icon: 'tab-record', loginOnly: true },
  { path: 'pages/renqing/renqing', text: '往来', icon: 'tab-people' },
  { path: 'pages/mine/mine', text: '我的', icon: 'tab-mine', badge: true }
];

Component({
  data: {
    list: [],
    selected: '',
    badge: ''
  },

  lifetimes: {
    attached() { this.refresh(); }
  },

  methods: {
    /** 按登录状态与角标数刷新（各 tab 页 onShow、登录/退出、角标变化时调用） */
    refresh() {
      const app = getApp();
      const loggedIn = !!(app && app.globalData.user);
      const pages = getCurrentPages();
      const cur = pages.length ? pages[pages.length - 1].route : '';
      const n = (app && app.globalData.badge) || 0;
      this.setData({
        list: TABS.filter(t => !t.loginOnly || loggedIn),
        selected: cur,
        badge: n > 0 ? (n > 99 ? '99+' : String(n)) : ''
      });
    },

    onTap(e) {
      const path = e.currentTarget.dataset.path;
      if (path !== this.data.selected) wx.switchTab({ url: '/' + path });
    }
  }
});
