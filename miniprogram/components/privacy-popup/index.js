// components/privacy-popup — 全局隐私授权弹窗（v3.84.0）
// 页面 wxml 里放一个 <privacy-popup />，页面显示时登记为当前弹窗（utils/privacy.js）；
// 微信触发「需要隐私授权」时展示：同意按钮 open-type="agreePrivacyAuthorization"，拒绝则功能不可用、其他照常。
// 与登录状态无关，宾客页也可用。
const privacy = require('../../utils/privacy.js');
const theme = require('../../utils/theme.js');

Component({
  data: { visible: false, themeStyle: '', canContract: false, contractName: '用户隐私保护指引' },
  lifetimes: {
    attached() { this._rs = []; privacy.setCurrent(this); },
    detached() {
      privacy.clearCurrent(this);
      this.resolveAll({ event: 'disagree' });
    }
  },
  pageLifetimes: {
    show() { privacy.setCurrent(this); },
    hide() { privacy.clearCurrent(this); }
  },
  methods: {
    noop() {},
    /** 由 utils/privacy.js 调用 */
    open(resolve) {
      if (typeof resolve === 'function') (this._rs = this._rs || []).push(resolve);
      if (this.data.visible) return;
      let themeStyle = '';
      try { themeStyle = theme.styleOf(theme.current()); } catch (e) { /* 用默认色 */ }
      this.setData({ visible: true, themeStyle, canContract: typeof wx.openPrivacyContract === 'function' });
      if (typeof wx.getPrivacySetting === 'function') {
        try {
          wx.getPrivacySetting({
            success: r => { if (r && r.privacyContractName) this.setData({ contractName: r.privacyContractName }); },
            fail: () => {}
          });
        } catch (e) { /* 忽略 */ }
      }
    },
    resolveAll(res) {
      const list = this._rs || [];
      this._rs = [];
      list.forEach(fn => { try { fn(res); } catch (e) { /* 忽略 */ } });
    },
    onAgree() {
      privacy.setLocalAgreed(true);
      this.resolveAll({ buttonId: 'agree-btn', event: 'agree' });
      this.setData({ visible: false });
    },
    onDisagree() {
      this.resolveAll({ event: 'disagree' });
      this.setData({ visible: false });
    },
    openContract() {
      wx.openPrivacyContract({ fail: () => wx.showToast({ title: '暂时无法打开', icon: 'none' }) });
    },
    goPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }); }
  }
});
