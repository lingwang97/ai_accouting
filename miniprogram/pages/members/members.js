// pages/members/members.js — 记账人管理：邀请记账人、移除、退出；主家本人可"移交给主家"
// 记账人与主家权限相同（清除数据、人情往来除外）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const theme = require('../../utils/theme.js');

Page({
  data: {
    role: 'none',
    accountName: '',
    owner: null,
    list: [],
    clerkToken: '',    // 邀请记账人
    transferToken: '', // 移交：选好礼簿后生成
    showPicker: false, // 选择要移交的礼簿
    books: [],         // [{ _id, name, typeLabel, count, sumStr, on }]
    stayClerk: true,   // 移交后继续为对方记账
    transferDesc: '',  // 已生成卡片的说明
    orgMode: false,    // 机构模式：可设置岗位与负责场次
    canManage: true,   // 只负责部分场次的人员不能管理
    titles: ['礼台', '收银', '主管'],
    editor: null,      // { idx, title, books: [{ _id, name, on }] }
    joins: [],         // 主家：通过邀请卡申请加入、待同意的记账人 / 家人
    loading: true
  },

  onShow() {
    theme.apply(this); // 主题色跟当前礼簿事由走
    this.load();
  },

  async load() {
    try {
      const app = getApp();
      const r = await req.memberList();
      const account = app.globalData.account;
      const orgMode = !!(account && account.orgMode);
      let bookName = {};
      if (orgMode && r.canManage !== false) {
        try {
          const { list } = await req.bookList();
          this._books = list;
          list.forEach(b => { bookName[b._id] = b.hostName || b.name; });
        } catch (e) { /* 忽略 */ }
      }
      this.setData({
        role: r.role,
        owner: r.owner || null,
        orgMode,
        canManage: r.canManage !== false,
        accountName: (account && account.accountName) || '',
        list: (r.list || []).map(m => ({
          ...m,
          timeStr: m.createdAt ? fmt.day(m.createdAt) : '',
          booksText: m.bookIds && m.bookIds.length ? m.bookIds.map(id => bookName[id] || '已删除场次').join('、') : '全部场次'
        }))
      });
      if (r.role === 'owner') {
        try {
          const j = await req.memberPending();
          this.setData({ joins: (j.list || []).map(x => ({ ...x, booksText: (x.books || []).join('、'), timeStr: x.createdAt ? fmt.day(x.createdAt) : '' })) });
        } catch (e) { /* 忽略 */ }
      }
      if (r.canManage === false) return;
      // 预先生成记账人邀请（分享按钮需要同步拿到链接）；同一次进入只生成一次
      if (this.data.clerkToken) return;
      const clerk = await req.inviteCreate('clerk');
      this.setData({ clerkToken: clerk.token });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  /** 主家同意 / 拒绝加入申请 */
  onJoin(e) {
    const { idx, ok } = e.currentTarget.dataset;
    const j = this.data.joins[idx];
    if (!j) return;
    const what = j.role === 'viewer' ? '查看共享的礼簿（只读）' : '为你记账（确认收礼、登记现金、导出等）';
    wx.showModal({
      title: ok ? '同意加入' : '拒绝申请',
      content: ok ? `同意「${j.name}」${what}？` : `拒绝「${j.name}」的申请？`,
      confirmText: ok ? '同意' : '拒绝',
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.memberApprove(j._id, ok);
          wx.showToast({ title: ok ? '已同意' : '已拒绝', icon: 'success' });
          require('../../utils/cache.js').set('dashboard', null);
          this.load();
        } catch (err) { /* toast 已提示 */ }
      }
    });
  },

  /** 改记账名称：自己的（主家 / 记账人）或可管理时改别人的 */
  onRename(e) {
    const { idx, owner } = e.currentTarget.dataset;
    const target = owner ? this.data.owner : this.data.list[idx];
    if (!target) return;
    wx.showModal({
      title: '记账人姓名 / 礼台编号',
      editable: true,
      content: target.name || '',
      placeholderText: '如：李华、礼台1号，回执和小票上显示',
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.setHandlerName(res.content, owner ? undefined : (target.me ? undefined : target._id));
          wx.showToast({ title: '已修改', icon: 'success' });
          this.load();
        } catch (err) { /* toast 已提示 */ }
      }
    });
  },

  // —— 机构版：设置岗位与负责场次 ——
  onEditMember(e) {
    const idx = e.currentTarget.dataset.idx;
    const m = this.data.list[idx];
    const ids = m.bookIds || [];
    this.setData({
      editor: {
        idx,
        name: m.name,
        title: m.title || '',
        books: (this._books || []).filter(b => !b.archived || ids.includes(b._id))
          .map(b => ({ _id: b._id, name: b.hostName ? `${b.hostName} · ${b.name}` : b.name, date: b.date || '', on: ids.includes(b._id) }))
      }
    });
  },
  onEdTitle(e) {
    const t = e.currentTarget.dataset.t;
    this.setData({ 'editor.title': this.data.editor.title === t ? '' : t });
  },
  onEdBook(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ [`editor.books[${i}].on`]: !this.data.editor.books[i].on });
  },
  onEdCancel() { this.setData({ editor: null }); },
  async onEdSave() {
    const ed = this.data.editor;
    const m = this.data.list[ed.idx];
    try {
      await req.memberUpdate(m._id, { title: ed.title, bookIds: ed.books.filter(b => b.on).map(b => b._id) });
      this.setData({ editor: null });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.load();
    } catch (err) { /* toast 已提示 */ }
  },

  onRemove(e) {
    const m = this.data.list[e.currentTarget.dataset.idx];
    wx.showModal({
      title: '移除记账人',
      content: `移除后「${m.name}」将不能再为「${this.data.accountName}」记账，已登记的礼金不受影响`,
      confirmColor: '#FA5151',
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.memberRemove(m._id);
          wx.showToast({ title: '已移除', icon: 'success' });
          this.load();
        } catch (err) { /* toast 已提示 */ }
      }
    });
  },

  /** 记账人退出（不再为这位主家记账） */
  onLeave() {
    const account = getApp().globalData.account;
    wx.showModal({
      title: '退出记账',
      content: `确定不再为「${this.data.accountName}」记账？`,
      success: async res => {
        if (!res.confirm || !account) return;
        try {
          await req.memberLeave(account._id);
          getApp().resetIdentity();
          wx.showToast({ title: '已退出', icon: 'success' });
          setTimeout(() => wx.switchTab({ url: '/pages/mine/mine' }), 500);
        } catch (err) { /* toast 已提示 */ }
      }
    });
  },

  // —— 移交：先选礼簿，再生成卡片 ——
  async onPickBooks() {
    try {
      const { list } = await req.bookList(); // 含已归档的礼簿，也可以移交
      const all = list;
      this.setData({
        showPicker: true,
        transferToken: '',
        books: all.map(b => ({
          _id: b._id, name: b.name, typeLabel: scenes.label(b.type), count: b.count || 0,
          sumStr: fmt.money(b.sum || 0), archived: !!b.archived, on: false
        }))
      });
    } catch (e) { /* toast 已提示 */ }
  },
  onToggleBook(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ [`books[${i}].on`]: !this.data.books[i].on, transferToken: '' });
  },
  onPickAll() {
    const all = this.data.books.some(b => !b.on);
    this.setData({ books: this.data.books.map(b => ({ ...b, on: all })), transferToken: '' });
  },
  onStayClerk(e) { this.setData({ stayClerk: e.detail.value, transferToken: '' }); },
  onCancelPick() { this.setData({ showPicker: false, transferToken: '' }); },

  /** 生成移交卡片（分享按钮需要先拿到链接） */
  async onMakeTransfer() {
    const picked = this.data.books.filter(b => b.on);
    if (!picked.length) return wx.showToast({ title: '请选择要移交的礼簿', icon: 'none' });
    try {
      const r = await req.inviteCreate('transfer', { bookIds: picked.map(b => b._id), stayClerk: this.data.stayClerk });
      this._transferNames = picked.map(b => b.name);
      this.setData({
        transferToken: r.token,
        transferDesc: r.full
          ? '全部礼簿整体移交：主家信息、收款码、已印好的礼簿码一起转给对方'
          : `移交 ${picked.length} 本：${this._transferNames.join('、')}；其余礼簿留在你这里`
      });
    } catch (e) { /* toast 已提示 */ }
  },

  /** 分享卡片：data-type 区分邀请记账人 / 移交主家 */
  onShareAppMessage(res) {
    const type = (res && res.target && res.target.dataset && res.target.dataset.type) || 'clerk';
    const name = this.data.accountName;
    if (type === 'transfer') {
      const names = this._transferNames || [];
      return {
        title: names.length === 1 ? `礼簿「${names[0]}」移交给你，请确认接收` : `「${name}」的 ${names.length || ''} 本礼簿移交给你，请确认接收`,
        path: `/pages/invite/invite?token=${this.data.transferToken}`
      };
    }
    return {
      title: `邀请你为「${name}」记账`,
      path: `/pages/invite/invite?token=${this.data.clerkToken}`
    };
  }
});
