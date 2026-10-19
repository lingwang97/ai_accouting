// pages/mine/mine.js — 我的：身份与设置（日常操作在「工作台」）
// 分组：收礼设置（主家信息、记账人、机构模式）/ 打印与回执 / 数据；礼簿码在工作台「出示礼簿码」
const req = require('../../utils/request.js');
const theme = require('../../utils/theme.js');
const cache = require('../../utils/cache.js');
const plan = require('../../utils/plan.js');
const perm = require('../../utils/perm.js');

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
    orgAllowed: false,  // 已开通机构版（或已在使用机构模式）
    loading: true
  },

  onShow() {
    theme.apply(this);
    // 先显示上次的数据，避免白屏
    if (!this.data.user) {
      const c = cache.get('mine');
      if (c && !wx.getStorageSync(LOGOUT_KEY)) this.setData({ ...c, loading: false }); // 冷启动时 globalData.user 尚未恢复
    }
    this.refresh();
  },

  async refresh() {
    const app = getApp();
    const saved = wx.getStorageSync('printerDevice');
    this.setData({ printerName: (saved && saved.name) || '' });
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

      const { account, role, identities, restricted, readonly, perms } = await req.accountGet();
      app.globalData.account = account;
      app.globalData.role = role;
      app.refreshTabBar(); // 记账人身份隐藏「往来」
      app.globalData.perms = perms || [];
      theme.setAccount(account);
      theme.apply(this);
      app._accountChecked = true;
      const view = {
        account, role, identities: identities || [],
        restricted: !!restricted, readonly: !!readonly,
        pm: perm.map(perms, role)
      };
      this.setData(view);
      cache.set('mine', { user: app.globalData.user, ...view });
      app.refreshTabBar();
      plan.load(true).then(p => this.setData({
        isAdmin: !!p.isAdmin,
        orgAllowed: !!(p.features && p.features.org) || !!(account && account.orgMode),
        planText: p.plan && p.plan !== 'free' ? `${p.name}${p.expiresAt ? ' · 到期 ' + require('../../utils/format.js').day(p.expiresAt) : ''}` : ''
      }));
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  goMembers() { wx.navigateTo({ url: '/pages/members/members' }); },
  goAdmin() { wx.navigateTo({ url: '/pages/admin/admin' }); },
  noop() {},

  // —— 机构模式：婚庆公司、宴会厅等一个账号办多场 ——
  async onOrgSwitch(e) {
    const on = e.detail.value;
    const a = this.data.account;
    if (!on) return this.saveOrg(false, a.orgName);
    // 打开时填写机构名称（默认沿用已填的或主家称呼）
    const name = await askOrgName(a.orgName || a.accountName);
    if (name === null) return this.setData({ 'account.orgMode': false }); // 取消：开关复位
    this.saveOrg(true, name);
  },

  /** 点「机构模式」这一行：修改机构名称 */
  async onOrgName() {
    const a = this.data.account;
    if (!a || !a.orgMode) return;
    const name = await askOrgName(a.orgName || a.accountName);
    if (name !== null) this.saveOrg(true, name);
  },

  async saveOrg(on, orgName) {
    try {
      const r = await req.setOrgMode(on, orgName);
      const account = { ...this.data.account, orgMode: r.orgMode, orgName: r.orgName };
      getApp().globalData.account = account;
      this.setData({ account });
      cache.clear(); // 工作台入口随模式变化
      wx.showToast({ title: on ? '已开启机构模式' : '已关闭机构模式', icon: 'none' });
    } catch (err) {
      this.setData({ 'account.orgMode': !on }); // 失败复位（request.js 已提示原因）
    }
  },

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
    wx.showActionSheet({
      itemList: items,
      success: async res => {
        // 记账人自己办事：填写自己的主家信息、上传自己的收款码
        if (res.tapIndex === list.length) return wx.navigateTo({ url: '/pages/account/account?own=1' });
        const target = list[res.tapIndex];
        if (!target || (this.data.account && target.aid === this.data.account._id)) return;
        try {
          await req.identitySwitch(target.aid);
          getApp().resetIdentity();
          wx.showToast({ title: '已切换', icon: 'success' });
          this.refresh();
        } catch (e) { /* toast 已提示 */ }
      }
    });
  },

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },
  goAccount() { wx.navigateTo({ url: '/pages/account/account' }); },
  goAppearance() { wx.navigateTo({ url: '/pages/appearance/appearance' }); },
  goQrcode() { wx.navigateTo({ url: '/pages/qrcode/qrcode' }); },
  goPrinter() { wx.navigateTo({ url: '/pages/printer/printer' }); },
  goStyle() { wx.navigateTo({ url: '/pages/receiptset/receiptset' }); },
  goExport() { wx.navigateTo({ url: '/pages/export/export' }); },

  /** 隐私与数据：查看说明 / 清除我的全部数据（注销） */
  onPrivacy() {
    wx.showActionSheet({
      itemList: ['隐私说明', '清除我的全部数据'],
      success: res => {
        if (res.tapIndex === 0) {
          wx.showModal({
            title: '隐私说明',
            content: '慧礼记仅保存你登记的礼簿、礼金、送礼记录和收款码图片，用于记账、回执与导出；数据存于微信云开发，仅你本人可见。宾客的姓名、礼金仅对主家和宾客本人可见。导出文件下载后即从云端删除。你可随时在此清除全部数据。',
            showCancel: false
          });
        } else {
          this.confirmPurge();
        }
      }
    });
  },

  confirmPurge() {
    wx.showModal({
      title: '清除全部数据',
      content: '将永久删除你的所有礼簿、礼金记录、送礼记录、模板、存档文件和主家信息，无法恢复。建议先在「导出礼簿」里做一次备份。如确认，请输入"清除"',
      editable: true,
      placeholderText: '输入：清除',
      confirmColor: '#FA5151',
      success: async res => {
        if (!res.confirm) return;
        if ((res.content || '').trim() !== '清除') {
          return wx.showToast({ title: '输入不正确，已取消', icon: 'none' });
        }
        wx.showLoading({ title: '正在清除…', mask: true });
        try {
          await req.exportPurge();
          await req.purgeAccount();
          wx.hideLoading();
          try {
            wx.removeStorageSync('db_inited');
            (wx.getStorageInfoSync().keys || []).filter(k => k.indexOf('qr_') === 0).forEach(k => wx.removeStorageSync(k));
          } catch (e) { /* 忽略 */ }
          wx.showModal({ title: '已清除', content: '你的数据已全部删除', showCancel: false });
          this.onLogout();
        } catch (e) {
          wx.hideLoading(); // request.js 已提示
        }
      }
    });
  },

  onLogout() {
    const app = getApp();
    app.globalData.user = null;
    // 清主家信息、角色、缓存、套餐、打印模板，并刷新底部菜单（「工作台」变回「首页」）
    app.resetIdentity();
    theme.setAccount(null); // 主题色恢复默认（含本地存储）
    try { wx.setStorageSync(LOGOUT_KEY, true); } catch (e) { /* 忽略 */ }
    this.setData({ user: null, account: null, role: 'none', restricted: false, readonly: false, pm: {}, isAdmin: false, planText: '' });
    theme.apply(this);
  }
});

/** 版本号；开发版 / 体验版附加标识，便于测试时区分 */
function versionText() {
  let env = 'release';
  try { env = wx.getAccountInfoSync().miniProgram.envVersion; } catch (e) { /* 默认正式版 */ }
  const tag = { develop: ' 开发版', trial: ' 体验版' }[env] || '';
  return `慧礼记 v${VERSION}${tag}`;
}

/** 输入机构名称；取消返回 null */
function askOrgName(def) {
  return new Promise(resolve => {
    wx.showModal({
      title: '机构名称',
      editable: true,
      content: def || '',
      placeholderText: '如：喜来登宴会厅',
      confirmText: '确定',
      success: res => resolve(res.confirm ? String(res.content || '').trim() : null),
      fail: () => resolve(null)
    });
  });
}
