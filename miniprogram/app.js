// app.js — 云开发初始化与全局状态

App({
  globalData: {
    openid: '',
    user: null,
    account: null,   // 当前用户的主家信息
    tpl: null,       // 打印模板
    recordsBookId: '', // 礼簿页要筛选的礼簿（从礼簿统计页跳转时设置）
    remindDot: false,  // 「往来」红点：有到期未处理的办事提醒
    remindVer: Date.now(), // 往来提醒版本：往来页刷新提醒后更新，云端红点缓存随之失效（v3.69.0）
    badge: 0,          // 待确认礼金数（自定义底部菜单「工作台」角标）
    bookType: '',      // 当前礼簿事由，决定主题色（utils/theme.js）
    role: null,        // 当前身份：owner | clerk | viewer；冷启动为空，用 ensureRole() 读取
    perms: null,       // 当前身份的权限列表（记账人各自不同；主家全部，见 utils/perm.js），随 role 一起写入
    identityVer: 0     // 切换身份次数；页面据此丢弃上一身份的数据
  },
  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库过低，请升级微信后使用云开发能力');
      return;
    }
    wx.cloud.init({ env: 'lingyuan-env-7gf6tlqf2a9ece4a', traceUser: true });
    this.ensureCollections();
    this.loginReady = this.restoreLogin();
  },

  /**
   * 启动时恢复登录态（静默，不注册）；主动退出过则不恢复。
   * 礼簿、往来页等待它完成后再判断是否登录，避免冷启动时误显示"请先登录"
   */
  restoreLogin() {
    if (this.globalData.user) return Promise.resolve(this.globalData.user);
    try {
      if (wx.getStorageSync('logged_out')) return Promise.resolve(null);
    } catch (e) { /* 忽略 */ }
    return new Promise(resolve => {
      wx.cloud.callFunction({
        name: 'login',
        data: { action: 'check' },
        success: res => {
          this.loginFailed = false;
          const d = res.result && res.result.code === 0 ? res.result.data : null;
          if (d && d.user) {
            this.globalData.openid = d.openid;
            this.globalData.user = d.user;
          }
          resolve(this.globalData.user);
        },
        // 网络失败：记下来，工作台显示「网络不佳，点此重试」，不把已登录的主家当成未登录宾客（v3.66.0）
        fail: () => { this.loginFailed = true; resolve(null); }
      });
    });
  },

  /** 登录检查因网络失败时重试（工作台「点此重试」） */
  retryLogin() {
    if (this.globalData.user || !this.loginFailed) return this.loginReady;
    this.loginReady = this.restoreLogin();
    return this.loginReady;
  },

  /** 刷新"我的"角标：待确认礼金笔数；未完善主家信息的用户（宾客）不显示 */
  refreshBadge() {
    if (!this.globalData.user) return Promise.resolve(0); // 宾客也有往来提醒（红点），故只要求已登录
    return new Promise(resolve => {
      wx.cloud.callFunction({
        name: 'records',
        data: { action: 'pendingStat', ...require('./utils/request.js').pollHint() }, // 轻接口：只统计待确认笔数（带身份与提醒版本，云端可复用缓存）
        success: res => {
          const d = res.result && res.result.code === 0 ? res.result.data : {};
          const n = d.count || 0;
          this.globalData.remindDot = d.remindDue === true; // 往来页红点（只算到期未处理）
          this.setBadge(this.globalData.account ? n : 0);
          resolve(n);
        },
        fail: () => resolve(0)
      });
    });
  },

  /** 切换身份 / 接受邀请后：清掉与主家相关的缓存，各页面重新加载 */
  resetIdentity() {
    this.globalData.dataDirtyAt = Date.now(); // 各页面切回时必须刷新
    this.globalData.account = null;
    this.globalData.recordsBookId = '';
    this.globalData.bookType = '';
    this.globalData.role = null;
    this.globalData.perms = null;
    this.globalData.identityVer = (this.globalData.identityVer || 0) + 1;
    this.globalData.themePrimary = null; // 主题色随身份重新读取
    require('./utils/cache.js').clear();
    require('./utils/qroff.js').clearFiles(); // 礼簿码离线副本（含收款码图片）的本机文件一并删除（v3.69.1）
    require('./utils/plan.js').reset();
    this._accountChecked = false;
    try { require('./utils/printer.js').clearTemplateCache(); } catch (e) { /* 忽略 */ }
    this.globalData.remindDot = false;
    this.setBadge(0);
  },

  /** 已主动退出登录（同步判断）：各 tab 页 onShow 先据此立即切到未登录界面，避免闪现上一个账户的内容 */
  isLoggedOut() {
    if (this.globalData.user) return false;
    try { return !!wx.getStorageSync('logged_out'); } catch (e) { return false; }
  },

  /** 当前身份角色：globalData.role 只在工作台 / 我的页刷新时写入，冷启动时向云函数读取一次 */
  ensureRole(silent) {
    if (this.globalData.role) return Promise.resolve(this.globalData.role);
    return require('./utils/request.js').accountGet(false, silent ? { silent: true } : undefined).then(r => {
      this.globalData.role = r.role || 'none';
      this.globalData.perms = r.perms || [];
      require('./utils/pollcfg.js').set(r.pollLevel, r.peakUntil || 0);
      this.globalData.account = r.account || null;
      this._accountChecked = true;
      this._fresh = { account: r.account || null, at: Date.now() }; // 刚取到的完整主家信息，页面 15 秒内可直接用一次，省一次重复调用（v3.66.2）
      this.refreshTabBar(); // 记账人身份隐藏「往来」
      return this.globalData.role;
    }).catch(() => '');
  },

  /** 取走 ensureRole 刚读到的主家信息（15 秒内、只能取一次；没有或已过期返回 undefined，调用方自己请求） */
  takeFreshAccount() {
    const f = this._fresh;
    this._fresh = null;
    return f && Date.now() - f.at < 15000 ? f.account : undefined;
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
