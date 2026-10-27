// pages/invite/invite.js — 接受邀请：成为记账人 / 接收主家移交
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const theme = require('../../utils/theme.js');

Page({
  data: {
    token: '',
    info: null,
    themeStyle: '',
    errMsg: '',
    loggedIn: false,
    accepting: false,
    displayName: ''   // 记账名称（成为记账人时填写，回执和小票上显示）
  },

  async onLoad(options) {
    const token = options.token || '';
    this.setData({ token });
    if (!token) return this.setData({ errMsg: '邀请链接无效' });
    await this.loadInfo(token);
  },

  /** 读取邀请信息；网络失败可点此重试（v3.66.0，以前会显示「邀请不存在或已失效」） */
  async loadInfo(token) {
    try {
      const info = await req.inviteInfo(token, { silent: true });
      if (Array.isArray(info.books)) info.books = info.books.map(b => (b.sum === undefined ? b : { ...b, sumStr: fmt.money(b.sum) })); // 记账人 / 共享卡不带金额
      this.setData({ info });
      // 家人共享沿用微信昵称（需等邀请信息返回才知道类型）；记账人不预填
      const app = getApp();
      await app.loginReady;
      if (app.globalData.user && !this.data.displayName && info.type !== 'clerk') this.setData({ displayName: app.globalData.user.nickname || '' });
      if (info.voided) this.setData({ errMsg: '该移交邀请已作废，请让对方重新发起' });
      else if (info.used && info.type === 'transfer') this.setData({ errMsg: '该邀请已被使用，请让对方重新邀请' });
      else if (info.type !== 'transfer' && info.left === 0) this.setData({ errMsg: '邀请已被使用，请联系主家重新生成' });
      else if (info.expired) this.setData({ errMsg: '邀请已过期，请让对方重新邀请' });
    } catch (e) {
      if (req.isNetErr(e)) this.setData({ errMsg: req.errText(e) + '，没能读取邀请', errNet: true });
      else this.setData({ errMsg: (e && e.biz && e.message) || '邀请不存在或已失效', errNet: false });
    }
  },
  onRetryLoad() {
    if (!this.data.errNet || this._reloading) return;
    this._reloading = true;
    this.setData({ errMsg: '', errNet: false });
    const done = () => { this._reloading = false; };
    this.loadInfo(this.data.token).then(done, done);
  },

  async onShow() {
    const app = getApp();
    this.setData({ themeStyle: theme.styleOf(theme.current()) });
    await app.loginReady;
    this.setData({ loggedIn: !!app.globalData.user });
    // 家人共享沿用微信昵称；记账人必须自己填写真实姓名，不预填昵称
    if (app.globalData.user && !this.data.displayName && this.data.info && this.data.info.type !== 'clerk') this.setData({ displayName: app.globalData.user.nickname || '' });
  },

  /** 未登录：先登录，登录后自动回到本页 */
  goLogin() {
    getApp().globalData.pendingInvite = this.data.token;
    wx.navigateTo({ url: '/pages/login/login' });
  },

  onDisplayName(e) { this.setData({ displayName: e.detail.value }); },

  async onAccept() {
    if (this.data.accepting) return;
    const dn = (this.data.displayName || '').trim();
    if (this.data.info && this.data.info.type === 'clerk' && (dn.length < 2 || /^(微信用户|记账人|wx|用户)\d*$/i.test(dn))) {
      return wx.showToast({ title: '请填写你的真实姓名（2～12 个字）', icon: 'none' });
    }
    this.setData({ accepting: true });
    try {
      const r = await req.inviteAccept(this.data.token, (this.data.displayName || '').trim());
      const app = getApp();
      app.globalData.pendingInvite = '';
      app.resetIdentity();
      if (r.pending) {
        // 记账人 / 家人共享：主家同意后才生效；记账人第一次使用先看快速介绍
        const intro = r.type !== 'viewer' && !wx.getStorageSync('guide_seen');
        return wx.showModal({
          title: '已提交申请',
          content: `已向「${r.accountName}」提交申请，主家同意后你就可以${r.type === 'viewer' ? '查看共享的礼簿' : '记账'}了。`,
          showCancel: false,
          success: () => (intro ? wx.redirectTo({ url: '/pages/welcome/welcome?role=clerk' }) : wx.switchTab({ url: '/pages/index/index' }))
        });
      }
      wx.showModal({
        title: r.type === 'transfer' ? '已接收为主家' : (r.type === 'viewer' ? '已接受共享' : '已成为记账人'),
        content: r.type === 'transfer'
          ? `${r.partial ? r.count + ' 本礼簿' : '「' + r.accountName + '」的礼簿'}已转到你名下。请到「我的 → 主家信息」确认收款码是你自己的微信收款码。`
          : (r.type === 'viewer' ? `你现在可以查看「${r.accountName}」共享的礼簿了（只读）。` : `你现在可以为「${r.accountName}」记账了。`)
            + (r.switched === false ? '你还有自己的礼簿，请在「我的 → 切换身份」里切换。' : ''),
        showCancel: false,
        // 记账人 / 家人共享直接进工作台开始干活（v3.65.2）；接收移交的新主家去「我的」核对收款码
        success: () => wx.switchTab({ url: r.type === 'transfer' ? '/pages/mine/mine' : '/pages/index/index' })
      });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ accepting: false });
    }
  }
});
