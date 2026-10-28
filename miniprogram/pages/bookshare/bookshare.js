// pages/bookshare/bookshare.js — 礼簿共享：把选中的礼簿共享给家人只读查看（不能修改任何数据）
// 共享卡片 7 天内可发给多位家人；已共享的家人可改共享范围或取消共享
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const theme = require('../../utils/theme.js');

Page({
  data: {
    books: [],        // [{ _id, title, count, sumStr, on }]
    token: '',        // 已生成的共享卡片
    shareDesc: '',
    viewers: [],      // [{ _id, name, avatar, booksText, bookIds }]
    editor: null,     // 修改某位家人的共享范围 { idx, name, books: [{ _id, title, on }] }
    loading: true,
    themeStyle: ''
  },

  onShow() {
    theme.apply(this);
    this.load();
  },

  async load() {
    try {
      const [{ list }, { list: viewers }] = await Promise.all([req.bookList(), req.viewerList()]);
      const title = b => (b.hostName ? `${b.hostName} · ${b.name}` : b.name);
      const names = {};
      list.forEach(b => { names[b._id] = title(b); });
      const picked = new Set(this.data.books.filter(b => b.on).map(b => b._id));
      this.setData({
        books: list.map(b => ({ _id: b._id, title: title(b), count: b.count, sumStr: fmt.money(b.sum), archived: !!b.archived, on: picked.has(b._id) })),
        viewers: viewers.map(v => ({ ...v, avatar: require('../../utils/avatar.js').safe(v.avatar), booksText: v.bookIds.map(id => names[id] || '已删除的礼簿').join('、') }))
      });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  onToggle(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ [`books[${i}].on`]: !this.data.books[i].on, token: '' });
  },

  /** 生成共享卡片（分享按钮需要先拿到链接） */
  async onMake() {
    const picked = this.data.books.filter(b => b.on);
    if (!picked.length) return wx.showToast({ title: '请选择要共享的礼簿', icon: 'none' });
    try {
      const r = await req.inviteCreate('viewer', { bookIds: picked.map(b => b._id) });
      this._names = picked.map(b => b.title);
      this.setData({ token: r.token, shareDesc: `共享 ${picked.length} 本：${this._names.join('、')}` });
    } catch (e) { /* toast 已提示 */ }
  },

  noop() {},
  onAvatarErr(e) { const i = e.currentTarget.dataset.i; this.setData({ [`viewers[${i}].avatar`]: '' }); },

  onShareAppMessage(res) {
    // 右上角菜单转发不带邀请卡：只有点页面上的分享按钮才发邀请 / 移交 / 共享
    if (!res || res.from !== 'button') return { title: '慧礼记｜扫码随礼、自动记账、人情往来一本清', path: '/pages/index/index' };
    const acc = getApp().globalData.account;
    const names = this._names || [];
    const path = `/pages/invite/invite?token=${this.data.token}`;
    setTimeout(() => this.setData({ token: '' }), 300); // 共享卡只能 1 人使用：发出后回到「生成共享卡片」，给下一位重新生成（v3.66.7）
    return {
      title: `「${(acc && acc.accountName) || ''}」${names.length === 1 ? '的礼簿「' + names[0] + '」' : '的 ' + names.length + ' 本礼簿'}共享给你查看`,
      path
    };
  },

  // —— 已共享的家人 ——
  onEditViewer(e) {
    const idx = e.currentTarget.dataset.idx;
    const v = this.data.viewers[idx];
    this.setData({
      editor: { idx, name: v.name, books: this.data.books.map(b => ({ _id: b._id, title: b.title, on: v.bookIds.includes(b._id) })) }
    });
  },
  onEdBook(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ [`editor.books[${i}].on`]: !this.data.editor.books[i].on });
  },
  onEdCancel() { this.setData({ editor: null }); },
  async onEdSave() {
    const ed = this.data.editor;
    const ids = ed.books.filter(b => b.on).map(b => b._id);
    if (!ids.length) return wx.showToast({ title: '至少保留一本，或点「取消共享」', icon: 'none' });
    try {
      await req.memberUpdate(this.data.viewers[ed.idx]._id, { bookIds: ids });
      this.setData({ editor: null });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.load();
    } catch (err) { /* toast 已提示 */ }
  },

  onRemoveViewer(e) {
    const v = this.data.viewers[e.currentTarget.dataset.idx];
    wx.showModal({
      title: '取消共享',
      content: `「${v.name}」将不能再查看这些礼簿`,
      confirmColor: '#FA5151',
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.memberRemove(v._id);
          wx.showToast({ title: '已取消', icon: 'success' });
          this.load();
        } catch (err) { /* toast 已提示 */ }
      }
    });
  }
});
