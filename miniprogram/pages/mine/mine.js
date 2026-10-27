// pages/mine/mine.js — 我的：身份与设置（日常操作在「工作台」）
// 分组：收礼设置（主家信息、记账人、机构模式）/ 打印与回执 / 数据；礼簿码在工作台「出示礼簿码」
const req = require('../../utils/request.js');
const theme = require('../../utils/theme.js');
const cache = require('../../utils/cache.js');
const plan = require('../../utils/plan.js');
const perm = require('../../utils/perm.js');
const fresh = require('../../utils/fresh.js');

const { VERSION } = require('../../config.js');

const LOGOUT_KEY = 'logged_out'; // 主动退出标记，login 页登录成功后清除

Page({
  data: {
    user: null,
    account: null,
    role: 'none',       // owner 主家本人 | clerk 记账人
    restricted: false,  // 只能看到部分礼簿（数据范围受限）
    readonly: false,    // 家人共享：只读
    pm: {},             // 当前身份的权限 { info: true, ... }（主家全部为 true）
    identities: [],
    printerName: '',
    versionText: versionText(),
    themeStyle: '',
    isAdmin: false,
    planText: '',       // 当前套餐（专业版显示到期日）
    loading: true
  },

  onShow() {
    this.setData({ primary: theme.apply(this).primary });
    // 在「隐私与数据」页清除数据后回到这里：界面按退出状态重置
    if (wx.getStorageSync(LOGOUT_KEY) && this.data.user) this.onLogout();
    // 先显示上次的数据，避免白屏
    if (!this.data.user) {
      let c = cache.get('mine');
      // 旧版缓存没有权限表：按身份补算；记账人权限尚未取到时丢弃缓存，避免菜单被隐藏
      if (c && !c.pm) {
        const g = getApp().globalData;
        c = c.role === 'owner' || g.perms ? { ...c, pm: perm.map(g.perms, c.role) } : null;
      }
      if (c && !wx.getStorageSync(LOGOUT_KEY)) this.setData({ ...c, loading: false }); // 冷启动时 globalData.user 尚未恢复
    }
    // 打印机名称取本地存储，每次显示都更新；账户信息 45 秒内且期间没有写操作（改称呼 / 切身份 / 主题等）时不重复请求
    const saved = wx.getStorageSync('printerDevice');
    this.setData({ printerName: (saved && saved.name) || '' });
    const g = getApp().globalData;
    const idChanged = this._idVer !== g.identityVer;
    if (fresh.needs(this) || !this.data.user || !this.data.account || idChanged || wx.getStorageSync(LOGOUT_KEY)) this.refresh();
  },

  async refresh() {
    const app = getApp();
    const at = Date.now();
    this._idVer = app.globalData.identityVer;
    try {
      // 恢复登录态（重启小程序后 globalData 为空）；主动退出过则不自动恢复
      if (!app.globalData.user && !wx.getStorageSync(LOGOUT_KEY)) {
        await app.loginReady;
      }
      if (!app.globalData.user && !wx.getStorageSync(LOGOUT_KEY)) {
        const { openid, user } = await req.loginCheck();
        app.globalData.openid = openid;
        app.globalData.user = user;
      }
      this.setData({ user: app.globalData.user });
      if (!app.globalData.user) {
        this.setData({ loading: false });
        return;
      }

      // 套餐与主家信息并行取（v3.66.0，原先依次等待）
      const planP = plan.load(true);
      const { account, role, identities, restricted, readonly, perms, pollLevel } = await req.accountGet();
      app.globalData.account = account;
      app.globalData.role = role;
      app.refreshTabBar(); // 记账人身份隐藏「往来」
      app.globalData.perms = perms || [];
      require('../../utils/pollcfg.js').set(pollLevel);
      theme.setAccount(account);
      this.setData({ primary: theme.apply(this).primary });
      app._accountChecked = true;
      const view = {
        account, role, identities: identities || [],
        restricted: !!restricted, readonly: !!readonly,
        pm: perm.map(perms, role)
      };
      this.setData(view);
      cache.set('mine', { user: app.globalData.user, ...view });
      app.refreshTabBar();
      planP.then(p => this.setData({
        isAdmin: !!p.isAdmin,
        planText: p.plan && p.plan !== 'free' ? `${p.name}${p.expiresAt ? ' · 到期 ' + require('../../utils/format.js').day(p.expiresAt) : ''}` : ''
      }));
      fresh.mark(this, at);
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  goMembers() { wx.navigateTo({ url: '/pages/members/members' }); },
  goAdmin() { wx.navigateTo({ url: '/pages/admin/admin' }); },

  /** 长按版本号：显示本人 openid（配置管理员、排查问题用） */
  async onShowOpenid() {
    const app = getApp();
    let openid = app.globalData.openid || '';
    if (!openid) {
      try {
        openid = (await req.loginCheck()).openid || '';
        app.globalData.openid = openid;
      } catch (e) { /* toast 已提示 */ }
    }
    if (!openid) return;
    wx.showModal({
      title: '我的 openid',
      content: openid,
      confirmText: '复制',
      success: res => res.confirm && wx.setClipboardData({ data: openid })
    });
  },

  /** 转发给好友 / 分享到朋友圈：落地首页（宾客扫码随礼，主家创建礼簿） */
  onShareAppMessage() {
    return { title: '慧礼记｜扫码随礼、自动记账、人情往来一本清', path: '/pages/index/index' };
  },
  onShareTimeline() {
    return { title: '慧礼记｜办事收礼，扫码随礼自动记账' };
  },

  /** 切换身份：自己的主家 / 为某位主家记账 */
  onSwitchIdentity() {
    const list = this.data.identities;
    const hasOwn = list.some(x => x.role === 'owner');
    const items = list.map(x => (x.aid === (this.data.account && this.data.account._id) ? '✓ ' : '') +
      (x.role === 'owner' ? `我的礼簿（${x.name}）` : (x.role === 'viewer' ? `查看「${x.name}」的礼簿（家人共享）` : `为「${x.name}」记账`)));
    if (!hasOwn) items.push('＋ 新建我自己的礼簿');
    this.pickIdentity(items, 0, idx => this.doSwitch(list, idx));
  },
  /** 操作菜单最多 6 项：超出时每页 5 项 +「更多…」 */
  pickIdentity(items, start, done) {
    const page = items.length - start > 6 ? items.slice(start, start + 5).concat('更多…') : items.slice(start);
    wx.showActionSheet({
      itemList: page,
      success: res => {
        if (items.length - start > 6 && res.tapIndex === 5) return this.pickIdentity(items, start + 5, done);
        done(start + res.tapIndex);
      }
    });
  },
  async doSwitch(list, tapIndex) {
    // 记账人自己办事：走创建向导，建自己的主家信息与礼簿
    if (tapIndex === list.length) return wx.navigateTo({ url: '/pages/setup/setup' });
    const target = list[tapIndex];
    if (!target || (this.data.account && target.aid === this.data.account._id)) return;
    try {
      await req.identitySwitch(target.aid);
      getApp().resetIdentity();
      wx.showToast({ title: '已切换', icon: 'success' });
      this.refresh();
    } catch (e) { /* toast 已提示 */ }
  },

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },
  goAccount() { wx.navigateTo({ url: '/pages/account/account' }); },
  goSetup() { wx.navigateTo({ url: '/pages/setup/setup' }); }, // 主家创建向导
  goAppearance() { wx.navigateTo({ url: '/pages/appearance/appearance' }); },
  goQrcode() { wx.navigateTo({ url: '/pages/qrcode/qrcode' }); },
  goPrinter() { wx.navigateTo({ url: '/pages/printer/printer' }); },
  goStyle() { wx.navigateTo({ url: '/pages/receiptset/receiptset' }); },
  goExport() { wx.navigateTo({ url: '/pages/export/export' }); },
  goTrash() { wx.navigateTo({ url: '/pages/trash/trash' }); }, // 回收站（主家本人）
  /** 使用教程：按身份打开对应分页（未完善主家信息的按宾客） */
  goAdvanced() { wx.navigateTo({ url: '/pages/advanced/advanced' }); },
  goContact() { wx.navigateTo({ url: '/pages/contact/contact' }); },

  goGuide() {
    const { role, account } = this.data;
    const tab = role === 'clerk' ? 'clerk' : (account ? 'host' : 'guest');
    wx.navigateTo({ url: '/pages/guide/guide?tab=' + tab });
  },

  goPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }); }, // 隐私与数据（含清除全部数据）

  onLogout() {
    const app = getApp();
    require('../../utils/setup.js').clearAll(); // 创建向导的草稿与身份选择只属于这个账号
    app.globalData.user = null;
    // 清主家信息、角色、缓存、套餐、打印模板，并刷新底部菜单（「工作台」变回「首页」）
    app.resetIdentity();
    theme.setAccount(null); // 主题色恢复默认（含本地存储）
    try { wx.setStorageSync(LOGOUT_KEY, true); } catch (e) { /* 忽略 */ }
    this.setData({ user: null, account: null, role: 'none', restricted: false, readonly: false, pm: {}, isAdmin: false, planText: '' });
    this.setData({ primary: theme.apply(this).primary });
  }
});

/** 版本号；开发版 / 体验版附加标识，便于测试时区分 */
function versionText() {
  let env = 'release';
  try { env = wx.getAccountInfoSync().miniProgram.envVersion; } catch (e) { /* 默认正式版 */ }
  const tag = { develop: ' 开发版', trial: ' 体验版' }[env] || '';
  return `慧礼记 v${VERSION}${tag}`;
}
