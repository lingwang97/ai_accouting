// pages/giftedit/giftedit.js — 登记 / 修改我送出的礼
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const theme = require('../../utils/theme.js');
const samename = require('../../utils/samename.js');

const QUICK = [100, 200, 300, 500, 600, 800, 1000, 1500, 2000];

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

  onShow() {
    theme.apply(this); // 主题色跟当前礼簿事由走
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
    this._remindId = options.remindId ? decodeURIComponent(options.remindId) : '';
    this.setData({
      date: fmt.day(new Date()),
      toName: decodeURIComponent(options.toName || ''),
      toKey: decodeURIComponent(options.toKey || ''),
      // 从办事提醒「记回礼」进入：带上事由
      ...(options.eventType ? { eventType: options.eventType } : {}),
      event: decodeURIComponent(options.event || '')
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
      // 新登记且未指定对方身份：已有同名往来人时先确认是哪一位（取消即中止）
      const who = d._id || d.toKey ? {} : await this.pickSameName(d.toName.trim());
      if (!who) return;
      await req.outSave({
        _id: d._id || undefined, toName: d.toName.trim(), toKey: who.toKey || d.toKey, toTag: who.toTag || undefined, relation: d.relation, event: d.event,
        eventType: d.eventType, amount: Number(d.amount), date: d.date, remark: d.remark
      });
      if (this._remindId) {
        // 从办事提醒「记回礼」进入：保存成功后才标记提醒已处理（失败不影响送礼记录）
        try { await req.remindDone(this._remindId, true); this._remindId = ''; getApp().refreshBadge(); } catch (e) { /* 提醒仍在，可手动标记 */ }
      }
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 400);
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  },

  /**
   * 同名区分：返回 { toKey } / { toTag } / {}（没有同名或查询失败），取消返回 null
   * 只有一位仅按姓名登记的同名人时，也问一下是否同一人
   */
  async pickSameName(name) {
    let list = [];
    try {
      list = (await req.rqNameCheck(name)).list || [];
    } catch (e) { return {}; }
    if (!list.length) return {};
    if (list.length === 1 && !list[0].tag && !list[0].scanned) {
      const same = await new Promise(resolve => wx.showModal({
        title: '同名提醒',
        content: `已有「${name}」，是同一人吗？`,
        confirmText: '是同一人',
        cancelText: '新的一位',
        success: res => resolve(res.confirm ? 1 : (res.cancel ? 0 : -1)),
        fail: () => resolve(-1)
      }));
      if (same < 0) return null;
      if (same) return { toKey: list[0].key };
      const tag = await samename.askTag(name);
      return tag ? { toTag: tag } : null;
    }
    const people = list.map(p => ({
      ...p,
      label: [p.label && p.label !== name ? p.label : `${name}（${p.tag || (p.scanned ? '扫码' : '未区分')}）`, p.relation].filter(Boolean).join(' · ')
    }));
    const r = await samename.choose(name, people);
    if (!r) return null;
    return r.person ? { toKey: r.person.key } : { toTag: r.tag };
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
