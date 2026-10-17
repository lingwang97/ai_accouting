// pages/login/login.js — 登录注册（UC1）
const req = require('../../utils/request.js');

Page({
  data: {
    nickname: '',
    avatar: '',
    submitting: false
  },

  onChooseAvatar(e) {
    this.setData({ avatar: e.detail.avatarUrl });
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const nickname = (this.data.nickname || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      const data = await req.login({ nickname, avatar: this.data.avatar });
      const app = getApp();
      app.globalData.openid = data.openid;
      app.globalData.user = data.user;
      try { wx.removeStorageSync('logged_out'); } catch (e) { /* 忽略 */ }
      wx.showToast({ title: data.isNew ? '注册成功' : '欢迎回来', icon: 'success' });
      const token = app.globalData.pendingInvite;
      setTimeout(() => {
        if (token) wx.redirectTo({ url: `/pages/invite/invite?token=${token}` });
        else wx.switchTab({ url: '/pages/mine/mine' });
      }, 600);
    } catch (e) {
      // request.js 已 toast
    } finally {
      this.setData({ submitting: false });
    }
  }
});
