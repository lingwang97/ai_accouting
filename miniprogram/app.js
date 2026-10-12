// app.js — 云开发初始化与全局状态
const MINE_TAB_INDEX = 2; // 底部"我的"菜单位置（用于待确认角标）

App({
  globalData: {
    openid: '',
    user: null,
    account: null,   // 当前用户收款账户
    tpl: null        // 打印模板
  },
  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库过低，请升级微信后使用云开发能力');
      return;
    }
    wx.cloud.init({ env: 'lingyuan-env-7gf6tlqf2a9ece4a', traceUser: true });
    this.ensureCollections();
  },

  /** 刷新"我的"角标：待确认转账笔数；未绑定收款账户的用户（付款方）不显示 */
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
    if (n > 0) {
      wx.setTabBarBadge({ index: MINE_TAB_INDEX, text: n > 99 ? '99+' : String(n), fail() {} });
    } else {
      wx.removeTabBarBadge({ index: MINE_TAB_INDEX, fail() {} });
    }
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
