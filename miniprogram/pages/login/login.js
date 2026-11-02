// pages/login/login.js — 登录注册（UC1）
const req = require('../../utils/request.js');
const theme = require('../../utils/theme.js');
const avatarUtil = require('../../utils/avatar.js');

Page({
  data: {
    nickname: '',
    avatar: '',
    submitting: false,
    agreed: false, // 我已阅读并同意《隐私说明》：每次进入登录页都不勾选，由用户自己勾选（v3.84.2 起不再记住上次的勾选）
    themeStyle: ''
  },

  onLoad() {
    theme.early(this); // 首帧前同步套主题色（v3.70.1）
    this.setData({ agreed: false });
    try { wx.removeStorageSync('privacyAgreed'); } catch (e) { /* v3.84.0~v3.84.1 留下的本地勾选记录，已不再使用 */ }
  },

  onShow() { this.setData({ themeStyle: theme.styleOf(theme.current()) }); theme.applyNav(); }, // 白事礼簿的灰色主题与其他页一致

  onChooseAvatar(e) {
    if (!this.data.agreed) return; // 防御：未同意时不接收头像
    this.setData({ avatar: e.detail.avatarUrl });
  },

  /** 勾选 / 取消勾选《隐私说明》 */
  toggleAgree() { this.setAgreed(!this.data.agreed); },
  setAgreed(v) {
    this.setData({ agreed: !!v });
  },
  /** 未同意时弹窗请用户选择；返回是否已同意（点头像 / 昵称 / 登录都走这里） */
  askAgree() {
    if (this.data.agreed) return Promise.resolve(true);
    return new Promise(resolve => {
      wx.showModal({
        title: '温馨提示',
        content: '请先阅读并同意《隐私说明》',
        confirmText: '同意',
        cancelText: '取消',
        success: res => {
          if (res.confirm) this.setAgreed(true);
          resolve(!!res.confirm);
        },
        fail: () => resolve(false)
      });
    });
  },
  /** 点头像 / 昵称框：同意后才能进入微信的头像、昵称选择 */
  async onNeedAgree() {
    if (await this.askAgree()) wx.showToast({ title: '已同意，请再点一次设置', icon: 'none' });
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
  goPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }); },

  async onSubmit() {
    if (this.data.submitting) return;
    if (!(await this.askAgree())) return; // 未同意《隐私说明》不登录
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
