// pages/remind/remind.js — 亲友办事提醒：手动添加 / 修改（对方姓名、事由、办事日期、提醒时间：具体到哪天几点）
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
    remindDay: '',    // 提醒时间：日期（北京时间）
    remindTime: '20:00', // 提醒时间：几点几分
    presets: [],      // 快捷选项（按办事日期计算，已过去的不显示）
    note: '',
    location: '',     // 办事地点（选填）
    today: '',
    scenes: scenes.SCENES.map(s => ({ type: s.type, label: s.label })),
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
        event: r.event || '', date: r.date, note: r.note || '', location: r.location || '',
        // 旧版提醒没有具体时间：按提醒日 9:00
        remindDay: (r.remindStr || '').slice(0, 10) || r.notifyDay || r.date,
        remindTime: (r.remindStr || '').slice(11) || '09:00'
      });
      this._customTime = true;
      this.refreshPresets();
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
  /** 选了办事日期：没手动改过提醒时间时，默认"前一天 20:00"（已过去则当天 8:00，再不行用现在之后） */
  onDate(e) {
    this.setData({ date: e.detail.value });
    this.refreshPresets();
    if (!this._customTime) {
      const p = this.data.presets[0];
      if (p) this.setData({ remindDay: p.day, remindTime: p.time });
    }
  },
  onRemindDay(e) { this._customTime = true; this.setData({ remindDay: e.detail.value }); this.markPreset(); },
  onRemindTime(e) { this._customTime = true; this.setData({ remindTime: e.detail.value }); this.markPreset(); },
  onPreset(e) {
    const p = this.data.presets[e.currentTarget.dataset.i];
    this._customTime = true;
    this.setData({ remindDay: p.day, remindTime: p.time });
    this.markPreset();
  },
  /** 快捷选项：前一天 20:00、当天 8:00、提前 3 天 9:00（已过去的不显示） */
  refreshPresets() {
    const d = this.data.date;
    if (!d) return this.setData({ presets: [] });
    const shift = n => {
      const t = new Date(d + 'T00:00:00');
      t.setDate(t.getDate() + n);
      return fmt.day(t);
    };
    const now = Date.now();
    const presets = [
      { t: '前一天 20:00', day: shift(-1), time: '20:00' },
      { t: '当天 8:00', day: d, time: '08:00' },
      { t: '提前 3 天 9:00', day: shift(-3), time: '09:00' }
    ].filter(p => new Date(`${p.day}T${p.time}:00`).getTime() > now);
    this.setData({ presets });
    this.markPreset();
  },
  markPreset() {
    const { remindDay, remindTime } = this.data;
    this.setData({ presets: this.data.presets.map(p => ({ ...p, on: p.day === remindDay && p.time === remindTime })) });
  },

  /** 保存：先在点击里同步请求订阅（微信要求），再提交 */
  onSave() {
    if (this.data.saving) return;
    if (!(this.data.name || '').trim()) return wx.showToast({ title: '请填写对方姓名', icon: 'none' });
    if (!this.data.date) return wx.showToast({ title: '请选择办事日期', icon: 'none' });
    if (!this.data.remindDay || !this.data.remindTime) return wx.showToast({ title: '请选择提醒时间', icon: 'none' });
    if (new Date(`${this.data.remindDay}T${this.data.remindTime}:00`).getTime() < Date.now()) return wx.showToast({ title: '提醒时间已过，请重新选择', icon: 'none' });
    if (this.data.remindDay > this.data.date) return wx.showToast({ title: '提醒时间不能晚于办事日期', icon: 'none' });
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
        event: d.event, date: d.date, remindAt: `${d.remindDay} ${d.remindTime}`, note: d.note, location: d.location
      }, subscribed);
      getApp().refreshBadge(); // 往来红点立即更新
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
          getApp().refreshBadge();
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 500);
        } catch (e) { /* toast 已提示 */ }
      }
    });
  }
});
