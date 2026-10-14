// pages/bookedit/bookedit.js — 新建 / 编辑礼簿；事由类型变化时询问是否套用场景模板
const req = require('../../utils/request.js');
const scenes = require('../../utils/scenes.js');
const sceneApply = require('../../utils/sceneApply.js');
const printer = require('../../utils/printer.js');

Page({
  data: {
    id: '',
    name: '',
    type: 'wedding',
    date: '',
    location: '',
    origType: '',
    scenes: scenes.SCENES.map(s => ({ type: s.type, label: s.label })),
    saving: false
  },

  async onLoad(options) {
    if (!options.id) {
      wx.setNavigationBarTitle({ title: '新建礼簿' });
      return;
    }
    try {
      const { list } = await req.bookList();
      const b = list.find(x => x._id === options.id);
      if (b) this.setData({ id: b._id, name: b.name, type: b.type, date: b.date, location: b.location || '', origType: b.type });
    } catch (e) { /* toast 已提示 */ }
  },

  onName(e) { this.setData({ name: e.detail.value }); },
  onLocation(e) { this.setData({ location: e.detail.value }); },
  onDate(e) { this.setData({ date: e.detail.value }); },
  onType(e) { this.setData({ type: e.currentTarget.dataset.t }); },

  async onSave() {
    if (this.data.saving) return;
    const name = (this.data.name || '').trim();
    if (!name) return wx.showToast({ title: '请填写礼簿名称', icon: 'none' });
    this.setData({ saving: true });
    try {
      const { id, type, date, location, origType } = this.data;
      const { book } = await req.bookSave({ _id: id || undefined, name, type, date, location });
      printer.clearTemplateCache(); // 新建即设为当前礼簿 / 事由类型可能变化
      wx.showToast({ title: id ? '已保存' : '已创建并设为当前', icon: 'success' });
      // 未自定义样式的礼簿自动按事由类型显示；改了事由类型时询问是否重新套用
      if (id && type !== origType) await sceneApply.askApply(type, book._id);
      setTimeout(() => wx.navigateBack(), 300);
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ saving: false });
    }
  }
});
