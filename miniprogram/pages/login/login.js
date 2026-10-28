// pages/login/login.js — 登录注册（UC1）
const req = require('../../utils/request.js');
const theme = require('../../utils/theme.js');
const avatarUtil = require('../../utils/avatar.js');

Page({
  data: {
    nickname: '',
    avatar: '',
    submitting: false,
    themeStyle: ''
  },

  onShow() { this.setData({ themeStyle: theme.styleOf(theme.current()) }); }, // 白事礼簿的灰色主题与其他页一致

  onChooseAvatar(e) {
    this.setData({ avatar: e.detail.avatarUrl });
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },
  // 点键盘上的「微信昵称」后，最终值可能在失焦 / 审核回调时才给出（iOS 偶发 bindinput 取到旧值），这里再取一次
  onNicknameBlur(e) {
    const v = e && e.detail && e.detail.value;
    if (typeof v === 'string' && v !== this.data.nickname) this.setData({ nickname: v });
  },
  onNicknameReview(e) {
    const d = (e && e.detail) || {};
    if (d.pass === false) wx.showToast({ title: '昵称不合规', icon: 'none' });
  },
  onAvatarError() { this.setData({ avatar: '' }); },

  async onSubmit() {
    if (this.data.submitting) return;
    const nickname = (this.data.nickname || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      // 头像是临时文件，先传云存储换成 fileID 再存库；传失败不影响登录（之后可在「我的」点头像重选）
      let avatar = '';
      if (this.data.avatar) {
        try { avatar = await avatarUtil.upload(this.data.avatar); } catch (e) { wx.showToast({ title: '头像上传失败', icon: 'none' }); }
      }
      const data = await req.login({ nickname, avatar });
      const app = getApp();
      app.globalData.openid = data.openid;
      app.globalData.user = data.user;
      try { wx.removeStorageSync('logged_out'); } catch (e) { /* 忽略 */ }
      wx.showToast({ title: data.isNew ? '注册成功' : '欢迎回来', icon: 'success' });
      const token = app.globalData.pendingInvite;
      setTimeout(() => {
        if (token) wx.redirectTo({ url: `/pages/invite/invite?token=${token}` });
        else if (data.isNew) wx.redirectTo({ url: '/pages/start/start' }); // 新用户：先选身份（办事收礼 / 去随礼 / 帮别人记账）
        else wx.switchTab({ url: '/pages/index/index' }); // 老用户：首页按身份显示工作台或扫码随礼
      }, 600);
    } catch (e) {
      // request.js 已 toast
    } finally {
      this.setData({ submitting: false });
    }
  }
});
