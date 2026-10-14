// app.js — 云开发初始化与全局状态

App({
  globalData: {
    openid: '',
    user: null,
    account: null,   // 当前用户的主家信息
    tpl: null,       // 打印模板
    recordsBookId: '', // 礼簿页要筛选的礼簿（从礼簿统计页跳转时设置）
    badge: 0           // 待确认礼金数（自定义底部菜单「我的」角标）
  },
  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库过低，请升级微信后使用云开发能力');
      return;
    }
    wx.cloud.init({ env: 'lingyuan-env-7gf6tlqf2a9ece4a', traceUser: true });
    this.ensureCollections();
  },

  /** 刷新"我的"角标：待确认礼金笔数；未完善主家信息的用户（宾客）不显示 */
  refreshBadge() {
    if (!this.globalData.account) return Promise.resolve(0);
    return new Promise(resolve => {
      wx.cloud.callFunction({
        name: 'records',
        data: { action: 'pending' },
        success: res => {
          const n = (res.result && res.result.code === 0 && res.result.data.count) || 0;
          this.setBadge(n);
          resolve(n);
        },
        fail: () => resolve(0)
      });
    });
  },

  setBadge(n) {
    this.globalData.badge = n;
    this.refreshTabBar();
  },

  /** 刷新当前页的自定义底部菜单（登录状态、角标） */
  refreshTabBar() {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    const bar = page && typeof page.getTabBar === 'function' && page.getTabBar();
    if (bar) bar.refresh();
  },

  /** 首次启动自动初始化数据库集合（幂等），成功后写入本地标记不再调用 */
  ensureCollections() {
    try {
      if (wx.getStorageSync('db_inited')) return;
      wx.cloud.callFunction({
        name: 'init',
        success: res => {
          if (res.result && res.result.code === 0) {
            wx.setStorageSync('db_inited', true);
            console.log('数据库集合初始化完成', res.result.data);
          }
        },
        fail: e => console.warn('init 云函数调用失败（可能尚未部署）', e)
      });
    } catch (e) { /* 忽略本地存储异常 */ }
  }
});
