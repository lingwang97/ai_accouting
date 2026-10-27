// pages/privacy/privacy.js — 隐私与数据：隐私说明 + 导出入口 + 清除我的全部数据（v3.52.0，原在「我的」页）
const req = require('../../utils/request.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');

const LOGOUT_KEY = 'logged_out'; // 与 mine / index 一致：主动退出（含清除数据）标记，login 页登录成功后清除

// 隐私说明正文（与 docs/提审与隐私说明.md 保持一致）
const SECTIONS = [
  { t: '我们保存哪些信息', b: '慧礼记只保存你登记的礼簿、礼金、送礼记录和收款码图片，用于记账、回执、人情往来统计与导出。登录时使用微信昵称和头像显示个人信息。往来人在系统内以加密标识关联，不显示微信号。' },
  { t: '谁能看到', b: '数据存放在微信云开发，仅你和你授权的记账人（礼台人员）、家人可见。宾客的姓名、礼金仅对主家和宾客本人可见。' },
  { t: '文件与临时数据', b: '导出文件下载后立即从云端删除，未下载的临时文件超过 24 小时会被自动清理。归档礼簿时生成的存档 PDF 会长期保留，随礼簿删除或清除数据一并删除。' },
  { t: '删除与保留', b: '删除的礼簿在回收站保留 15 天，之后永久删除。你可随时在本页下方清除全部数据（含回收站）。宾客在他人礼簿中的随礼记录属于主家的礼簿档案，如需删除请联系主家作废。' },
  { t: '设备权限', b: '相册（仅写入）用于保存礼簿码、台卡和电子回执；蓝牙用于连接热敏打印机；相册选图用于上传收款码。均在你使用对应功能时才会申请。' },
  { t: '微信服务通知', b: '微信服务通知（订阅消息）只在你点「允许」后发送，每次允许只发一条：主家 / 记账人开启「新礼金提醒」后，宾客转账时收到提醒；宾客随礼时允许「入簿通知」后，主家确认收到时收到一条入簿通知，点开查看电子回执。不用于营销。' },
  { t: '客服与反馈', b: '联系客服、提交反馈时你提供的文字、截图以及微信自带的机型 / 版本信息，由微信客服 / 反馈通道处理，仅用于答复和定位问题，小程序不另行收集。' }
];

Page({
  data: { themeStyle: '', sections: SECTIONS, user: null, role: 'none', canExport: false },

  onShow() {
    theme.apply(this);
    this.load();
  },

  async load() {
    const app = getApp();
    try {
      if (!app.globalData.user && !wx.getStorageSync(LOGOUT_KEY)) await app.loginReady;
    } catch (e) { /* 未登录也能看隐私说明 */ }
    const g = app.globalData;
    const user = wx.getStorageSync(LOGOUT_KEY) ? null : g.user;
    const role = g.role || 'none';
    const pm = perm.map(g.perms, role);
    // 导出入口条件与「我的」一致：已完善主家信息，且有导出权限或家人共享
    this.setData({ user: user || null, role, canExport: !!(user && g.account && (pm.export || role === 'viewer')) });
  },

  goExport() { wx.navigateTo({ url: '/pages/export/export' }); },

  confirmPurge() {
    wx.showModal({
      title: '清除全部数据',
      content: '将永久删除你的所有礼簿、礼金记录、送礼记录、模板、存档文件和主家信息，无法恢复。建议先在「导出与备份」里做一次备份。如确认，请输入"清除"',
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
          this.logoutLocal();
          wx.showModal({ title: '已清除', content: '你的数据已全部删除', showCancel: false });
          this.setData({ user: null, role: 'none', canExport: false });
          wx.switchTab({ url: '/pages/mine/mine' }); // 回「我的」，mine 的 onShow 会按退出状态重置界面
        } catch (e) {
          wx.hideLoading(); // request.js 已提示
        }
      }
    });
  },

  /** 本机退出登录（同 mine.onLogout） */
  logoutLocal() {
    const app = getApp();
    require('../../utils/setup.js').clearAll();
    app.globalData.user = null;
    app.resetIdentity();
    theme.setAccount(null);
    try { wx.setStorageSync(LOGOUT_KEY, true); } catch (e) { /* 忽略 */ }
  }
});
