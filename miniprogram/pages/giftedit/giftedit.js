// pages/giftedit/giftedit.js — 登记 / 修改我送出的礼
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');

const QUICK = [200, 500, 600, 800, 1000, 1888];

Page({
  data: {
    _id: '',
    toName: '',
    toKey: '', // 从往来明细页进入时带上对方身份，避免同名混淆
    relation: '',
    event: '',
    eventType: 'wedding',
    amount: '',
    date: '',
    remark: '',
    relations: scenes.RELATIONS,
    scenes: scenes.SCENES.map(s => ({ type: s.type, label: s.label })),
    quick: QUICK,
    saving: false
  },

  onLoad(options) {
    const app = getApp();
    if (options.edit && app.globalData.editGift) {
      const g = app.globalData.editGift;
      app.globalData.editGift = null;
      wx.setNavigationBarTitle({ title: '修改送礼记录' });
      this.setData({
        _id: g._id, toName: g.toName, toKey: g.toKey || '', relation: g.relation || '', event: g.event || '',
        eventType: g.eventType || 'other', amount: String(g.amount), date: g.date, remark: g.remark || ''
      });
      return;
    }
    this.setData({
      date: fmt.day(new Date()),
      toName: decodeURIComponent(options.toName || ''),
      toKey: decodeURIComponent(options.toKey || '')
    });
  },

  onInput(e) { this.setData({ [e.currentTarget.dataset.k]: e.detail.value }); },
  onRelation(e) {
    const r = e.currentTarget.dataset.r;
    this.setData({ relation: this.data.relation === r ? '' : r });
  },
  onType(e) { this.setData({ eventType: e.currentTarget.dataset.t }); },
  onQuick(e) { this.setData({ amount: String(e.currentTarget.dataset.v) }); },
  onDate(e) { this.setData({ date: e.detail.value }); },

  async onSave() {
    if (this.data.saving) return;
    const d = this.data;
    if (!d.toName.trim()) return wx.showToast({ title: '请填写对方姓名', icon: 'none' });
    if (!(Number(d.amount) > 0)) return wx.showToast({ title: '请填写正确金额', icon: 'none' });
    this.setData({ saving: true });
    try {
      await req.outSave({
        _id: d._id || undefined, toName: d.toName.trim(), toKey: d.toKey, relation: d.relation, event: d.event,
        eventType: d.eventType, amount: Number(d.amount), date: d.date, remark: d.remark
      });
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 400);
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  },

  onDelete() {
    wx.showModal({
      title: '删除记录',
      content: '确定删除这条送礼记录？',
      confirmColor: '#FA5151',
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.outDelete(this.data._id);
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 400);
        } catch (e) { /* toast 已提示 */ }
      }
    });
  }
});
