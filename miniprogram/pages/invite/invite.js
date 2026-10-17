// pages/invite/invite.js — 接受邀请：成为记账人 / 接收主家移交
const req = require('../../utils/request.js');

Page({
  data: {
    token: '',
    info: null,
    errMsg: '',
    loggedIn: false,
    accepting: false,
    displayName: ''   // 记账名称（成为记账人时填写，回执和小票上显示）
  },

  async onLoad(options) {
    const token = options.token || '';
    this.setData({ token });
    if (!token) return this.setData({ errMsg: '邀请链接无效' });
    try {
      const info = await req.inviteInfo(token);
      this.setData({ info });
      if (info.voided) this.setData({ errMsg: '该移交邀请已作废，请让对方重新发起' });
      else if (info.used && info.type === 'transfer') this.setData({ errMsg: '该邀请已被使用，请让对方重新邀请' });
      else if (info.type !== 'transfer' && info.left === 0) this.setData({ errMsg: '这张邀请卡的人数已满，请让对方重新邀请' });
      else if (info.expired) this.setData({ errMsg: '邀请已过期，请让对方重新邀请' });
    } catch (e) {
      this.setData({ errMsg: e.message || '邀请不存在或已失效' });
    }
  },

  async onShow() {
    const app = getApp();
    await app.loginReady;
    this.setData({ loggedIn: !!app.globalData.user });
    if (app.globalData.user && !this.data.displayName) this.setData({ displayName: app.globalData.user.nickname || '' });
  },

  /** 未登录：先登录，登录后自动回到本页 */
  goLogin() {
    getApp().globalData.pendingInvite = this.data.token;
    wx.navigateTo({ url: '/pages/login/login' });
  },

  onDisplayName(e) { this.setData({ displayName: e.detail.value }); },

  async onAccept() {
    if (this.data.accepting) return;
    this.setData({ accepting: true });
    try {
      const r = await req.inviteAccept(this.data.token, (this.data.displayName || '').trim());
      const app = getApp();
      app.globalData.pendingInvite = '';
      app.resetIdentity();
      if (r.pending) {
        // 记账人 / 家人共享：主家同意后才生效
        return wx.showModal({
          title: '已提交申请',
          content: `已向「${r.accountName}」提交申请，主家同意后你就可以${r.type === 'viewer' ? '查看共享的礼簿' : '记账'}了。`,
          showCancel: false,
          success: () => wx.switchTab({ url: '/pages/index/index' })
        });
      }
      wx.showModal({
        title: r.type === 'transfer' ? '已接收为主家' : (r.type === 'viewer' ? '已接受共享' : '已成为记账人'),
        content: r.type === 'transfer'
          ? `${r.partial ? r.count + ' 本礼簿' : '「' + r.accountName + '」的礼簿'}已转到你名下。请到「我的 → 主家信息」确认收款码是你自己的微信收款码。`
          : (r.type === 'viewer' ? `你现在可以查看「${r.accountName}」共享的礼簿了（只读）。` : `你现在可以为「${r.accountName}」记账了。`),
        showCancel: false,
        success: () => wx.switchTab({ url: r.type === 'viewer' ? '/pages/index/index' : '/pages/mine/mine' })
      });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ accepting: false });
    }
  }
});
