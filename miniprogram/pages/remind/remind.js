// pages/remind/remind.js — 亲友办事提醒：手动添加 / 修改（对方姓名、事由、办事日期、提前几天）
// 保存时请求一次订阅消息（配置了 REMIND_TMPL_ID 时），到提醒日由 warmer 云函数推送服务通知；
// 未订阅也会在「往来」顶部提醒
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const theme = require('../../utils/theme.js');
const { REMIND_TMPL_ID } = require('../../config.js');

Page({
  data: {
    _id: '',
    name: '',
    personKey: '', // 从往来明细进入时带上对方身份
    eventType: 'wedding',
    event: '',
    date: '',
    before: 1,
    note: '',
    today: '',
    scenes: scenes.SCENES.map(s => ({ type: s.type, label: s.label })),
    befores: [{ v: 0, t: '当天' }, { v: 1, t: '提前 1 天' }, { v: 3, t: '提前 3 天' }, { v: 7, t: '提前 7 天' }],
    pushOn: !!REMIND_TMPL_ID,
    saving: false
  },

  onShow() {
    theme.apply(this); // 主题色跟当前礼簿事由走
  },

  onLoad(options) {
    const app = getApp();
    this.setData({ today: fmt.day(new Date()) });
    if (options.edit && app.globalData.editRemind) {
      const r = app.globalData.editRemind;
      app.globalData.editRemind = null;
      wx.setNavigationBarTitle({ title: '修改提醒' });
      this.setData({
        _id: r._id, name: r.name, personKey: r.personKey || '', eventType: r.eventType || 'other',
        event: r.event || '', date: r.date, before: r.before === undefined ? 1 : r.before, note: r.note || ''
      });
      return;
    }
    this.setData({
      name: decodeURIComponent(options.name || ''),
      personKey: decodeURIComponent(options.key || ''),
      note: decodeURIComponent(options.note || '')
    });
  },

  onInput(e) { this.setData({ [e.currentTarget.dataset.k]: e.detail.value }); },
  onType(e) { this.setData({ eventType: e.currentTarget.dataset.t }); },
  onBefore(e) { this.setData({ before: e.currentTarget.dataset.v }); },
  onDate(e) { this.setData({ date: e.detail.value }); },

  /** 保存：先在点击里同步请求订阅（微信要求），再提交 */
  onSave() {
    if (this.data.saving) return;
    if (!(this.data.name || '').trim()) return wx.showToast({ title: '请填写对方姓名', icon: 'none' });
    if (!this.data.date) return wx.showToast({ title: '请选择办事日期', icon: 'none' });
    if (!REMIND_TMPL_ID) return this.submit(false);
    wx.requestSubscribeMessage({
      tmplIds: [REMIND_TMPL_ID],
      success: res => this.submit(res[REMIND_TMPL_ID] === 'accept'),
      fail: () => this.submit(false)
    });
  },

  async submit(subscribed) {
    this.setData({ saving: true });
    try {
      const d = this.data;
      await req.remindSave({
        _id: d._id || undefined, name: d.name.trim(), personKey: d.personKey, eventType: d.eventType,
        event: d.event, date: d.date, before: d.before, note: d.note
      }, subscribed);
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  },

  onDelete() {
    wx.showModal({
      title: '删除提醒',
      content: `删除「${this.data.name}」的办事提醒？`,
      confirmColor: '#FA5151',
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.remindDelete(this.data._id);
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 500);
        } catch (e) { /* toast 已提示 */ }
      }
    });
  }
});
