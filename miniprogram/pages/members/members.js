// pages/members/members.js — 记账人管理：邀请记账人（选负责的礼簿与权限）、设置礼簿与权限、移除、退出；主家本人可"移交给主家"
// 每位记账人各自设置：负责的礼簿（或全部礼簿，含以后新建的）+ 权限（见 utils/perm.js）；只能授予自己拥有的礼簿和权限
// 非机构模式：每位记账人只负责一本礼簿（单选，存 soloBookId）；机构模式才能多选、选全部礼簿
const req = require('../../utils/request.js');
const perm = require('../../utils/perm.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const theme = require('../../utils/theme.js');
const avatarUtil = require('../../utils/avatar.js');

Page({
  data: {
    role: 'none',
    accountName: '',
    owner: null,
    list: [],
    clerkToken: '',    // 邀请记账人
    inviteBooks: [],   // 邀请记账人：可选礼簿 [{ _id, name, on }]，默认勾选当前礼簿
    inviteAll: false,  // 邀请为「全部礼簿」记账人（含以后新建的）
    invitePerms: [],   // 邀请记账人：可授予的权限 [{ key, name, on }]（只列自己拥有的），默认 DEFAULT ∩ 我的权限
    inviteTpl: '',     // 当前勾选与哪个模板一致（高亮模板）
    tplNames: Object.keys(perm.TEMPLATES), // 一键模板：礼台记账员 / 管理助手
    myPerms: [],       // 我的权限（主家为全部）
    myAllBooks: false, // 我负责全部礼簿：才能邀请 / 设置「全部礼簿」
    inviteDesc: '',
    quotaMsg: '',      // 记账人名额已满的提示（免费版）
    transferToken: '', // 移交：选好礼簿后生成
    showPicker: false, // 选择要移交的礼簿
    books: [],         // [{ _id, name, typeLabel, count, sumStr, on }]
    stayClerk: true,   // 移交后继续为对方记账
    transferDesc: '',  // 已生成卡片的说明
    orgMode: false,    // 机构模式：可设置岗位与负责场次
    canManage: true,   // 有「邀请与管理记账人」权限
    titles: ['礼台', '收银', '主管'],
    editor: null,      // { idx, title, all, books: [{ _id, name, on }], perms: [{ key, name, on }], tpl }
    joins: [],         // 主家：通过邀请卡申请加入、待同意的记账人 / 家人
    loading: true
  },

  onShow() {
    this.setData({ primary: theme.apply(this).primary }); // 主题色跟当前礼簿事由走
    this.load();
  },

  async load() {
    try {
      const app = getApp();
      const r = await req.memberList();
      const account = app.globalData.account;
      const orgMode = !!(account && account.orgMode);
      const isOwner = r.role === 'owner';
      const myPerms = isOwner ? perm.ALL : (r.myPerms || []);
      this._permNames = Object.assign({}, perm.NAMES, r.permNames || {});
      let bookName = {};
      let activeBookId = '';
      if (r.canManage !== false) {
        try {
          const res = await req.bookList();
          this._books = res.list;
          activeBookId = res.activeBookId;
          res.list.forEach(b => { bookName[b._id] = b.hostName ? `${b.hostName} · ${b.name}` : b.name; });
        } catch (e) { /* 忽略 */ }
      }
      wx.setNavigationBarTitle({ title: orgMode ? '礼台人员' : '记账人' }); // 机构模式称「礼台人员」
      this.setData({
        role: r.role,
        owner: r.owner ? { ...r.owner, avatar: avatarUtil.safe(r.owner.avatar) } : null,
        orgMode,
        canManage: r.canManage !== false,
        myPerms,
        myAllBooks: isOwner || !!r.myAllBooks,
        accountName: (account && account.accountName) || '',
        list: (r.list || []).map(m => ({
          ...m,
          avatar: avatarUtil.safe(m.avatar),
          timeStr: m.createdAt ? fmt.day(m.createdAt) : '',
          booksText: !orgMode ? (bookName[m.soloBookId] || '已删除的礼簿')
            : m.allBooks || !(m.bookIds && m.bookIds.length) ? '全部礼簿' : m.bookIds.map(id => bookName[id] || '已删除的礼簿').join('、'),
          permCount: (m.perms || []).length
        }))
      });
      if (r.role === 'owner') {
        try {
          const j = await req.memberPending();
          this.setData({ joins: (j.list || []).map(x => ({ ...x, avatar: avatarUtil.safe(x.avatar), booksText: (x.books || []).join('、'), timeStr: x.createdAt ? fmt.day(x.createdAt) : '' })) });
        } catch (e) { /* 忽略 */ }
      }
      if (r.canManage === false) return;
      // 预先生成记账人邀请（分享按钮需要同步拿到链接）；同一次进入只生成一次
      // 邀请记账人：可选礼簿（未归档），默认当前礼簿；同一次进入只初始化一次
      if (!this.data.invitePerms.length) {
        // 可授予的权限：只列自己拥有的；默认勾选 DEFAULT ∩ 我的权限
        const invitePerms = this.permItems(perm.DEFAULT);
        this.setData({ invitePerms, inviteTpl: this.tplOf(invitePerms) });
      }
      if ((!this.data.myAllBooks || !orgMode) && this.data.inviteAll) this.setData({ inviteAll: false, clerkToken: '' });
      // 非机构模式只能单选：切换模式后多选的只留一本（优先当前礼簿）
      if (!orgMode && this.data.inviteBooks.filter(b => b.on).length > 1) {
        const keep = this.data.inviteBooks.find(b => b.on && b._id === activeBookId) || this.data.inviteBooks.find(b => b.on);
        this.setData({ inviteBooks: this.data.inviteBooks.map(b => ({ ...b, on: b === keep })), clerkToken: '' });
      }
      if (!this.data.inviteBooks.length && this._books) {
        this.setData({
          inviteBooks: this._books.filter(b => !b.archived)
            .map(b => ({ _id: b._id, name: bookName[b._id], on: b._id === activeBookId }))
        });
      }
      if (this.data.clerkToken) return;
      await this.makeClerkInvite();
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  // —— 权限勾选（邀请卡、设置弹窗共用） ——
  /** 可授予的权限列表：只列自己拥有的，on 表示已勾选 */
  permItems(selected) {
    const names = this._permNames || perm.NAMES;
    return perm.ALL.filter(k => this.data.myPerms.includes(k))
      .map(k => ({ key: k, name: names[k] || k, on: (selected || []).includes(k) }));
  },
  /** 当前勾选与哪个模板一致（模板按我的权限取交集） */
  tplOf(items) {
    const on = items.filter(x => x.on).map(x => x.key).sort().join(',');
    return this.data.tplNames.find(n => perm.TEMPLATES[n].filter(k => this.data.myPerms.includes(k)).sort().join(',') === on) || '';
  },

  /** 按所选礼簿与权限生成记账人邀请（分享按钮需要同步拿到链接，选择变化后重新生成） */
  async makeClerkInvite() {
    const ids = this.data.inviteBooks.filter(b => b.on).map(b => b._id);
    if (!this.data.inviteAll && !ids.length) return this.setData({ clerkToken: '', inviteDesc: '请至少选择一本礼簿' });
    const perms = this.data.invitePerms.filter(x => x.on).map(x => x.key);
    const seq = (this._inviteSeq || 0) + 1;
    this._inviteSeq = seq;
    try {
      const r = await req.inviteCreate('clerk', this.data.inviteAll ? { allBooks: true, perms } : { bookIds: ids, perms }, { silent: true });
      if (seq !== this._inviteSeq) return; // 已有更新的选择
      const n = (r.perms || perms).length;
      this.setData({
        quotaMsg: '',
        clerkToken: r.token,
        inviteDesc: (r.allBooks ? '负责全部礼簿（含以后新建的）' : `只负责：${r.books.map(b => b.name).join('、')}`) + ` · ${n} 项权限`
      });
    } catch (e) {
      if (seq !== this._inviteSeq) return;
      // 记账人名额已满（免费版 3 位）：页面里说明并带「联系我们」，分享按钮保持置灰；其他业务错误弹提示
      const msg = (e && e.biz && e.message) || '';
      if (req.isQuotaMsg(msg)) this.setData({ clerkToken: '', quotaMsg: msg, inviteDesc: '' });
      else { this.setData({ clerkToken: '', quotaMsg: '' }); if (msg) wx.showToast({ title: msg, icon: 'none' }); }
    }
  },
  onInvitePerm(e) {
    const i = e.currentTarget.dataset.i;
    const invitePerms = this.data.invitePerms.map((x, j) => (j === i ? { ...x, on: !x.on } : x));
    this.setData({ invitePerms, inviteTpl: this.tplOf(invitePerms), clerkToken: '' });
    this.makeClerkInvite();
  },
  onInviteTpl(e) {
    const invitePerms = this.permItems(perm.TEMPLATES[e.currentTarget.dataset.t]);
    this.setData({ invitePerms, inviteTpl: this.tplOf(invitePerms), clerkToken: '' });
    this.makeClerkInvite();
  },
  onInviteBook(e) {
    const i = e.currentTarget.dataset.i;
    if (!this.data.orgMode) {
      // 非机构模式：单选一本
      this.setData({ inviteBooks: this.data.inviteBooks.map((b, j) => ({ ...b, on: j === i })), clerkToken: '' });
    } else {
      this.setData({ [`inviteBooks[${i}].on`]: !this.data.inviteBooks[i].on, inviteAll: false, clerkToken: '' });
    }
    this.makeClerkInvite();
  },
  onInviteAll() {
    if (!this.data.myAllBooks || !this.data.orgMode) return;
    this.setData({ inviteAll: !this.data.inviteAll, clerkToken: '' });
    this.makeClerkInvite();
  },

  /** 主家同意 / 拒绝加入申请 */
  onJoin(e) {
    const { idx, ok } = e.currentTarget.dataset;
    const j = this.data.joins[idx];
    if (!j) return;
    const what = j.role === 'viewer' ? '查看共享的礼簿（只读）' : '为你记账（确认收礼、礼台记账、导出等）';
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
      title: '记账人姓名',
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

  // —— 设置负责的礼簿与权限（机构版另可设岗位） ——
  onEditMember(e) {
    const idx = e.currentTarget.dataset.idx;
    const m = this.data.list[idx];
    if (!m || m.me) return; // 不能设置自己
    const solo = !this.data.orgMode;
    const ids = solo ? [m.soloBookId] : (m.bookIds || []);
    const perms = this.permItems(m.perms || []);
    this.setData({
      editor: {
        idx,
        name: m.name,
        title: m.title || '',
        // 我不是「全部礼簿」时不能改对方的「全部礼簿」：原样保留，不降级
        all: solo ? false : this.data.myAllBooks ? (!!m.allBooks || !ids.length) : !!m.allBooks,
        books: (this._books || []).filter(b => !b.archived || ids.includes(b._id))
          .map(b => ({ _id: b._id, name: b.hostName ? `${b.hostName} · ${b.name}` : b.name, date: b.date || '', on: ids.includes(b._id) })),
        perms,
        tpl: this.tplOf(perms)
      }
    });
  },
  onEdPerm(e) {
    const i = e.currentTarget.dataset.i;
    const perms = this.data.editor.perms.map((x, j) => (j === i ? { ...x, on: !x.on } : x));
    this.setData({ 'editor.perms': perms, 'editor.tpl': this.tplOf(perms) });
  },
  onEdTpl(e) {
    const perms = this.permItems(perm.TEMPLATES[e.currentTarget.dataset.t]);
    this.setData({ 'editor.perms': perms, 'editor.tpl': this.tplOf(perms) });
  },
  onEdTitle(e) {
    const t = e.currentTarget.dataset.t;
    this.setData({ 'editor.title': this.data.editor.title === t ? '' : t });
  },
  onEdBook(e) {
    const i = e.currentTarget.dataset.i;
    if (!this.data.orgMode) {
      // 非机构模式：单选一本
      return this.setData({ 'editor.books': this.data.editor.books.map((b, j) => ({ ...b, on: j === i })), 'editor.all': false });
    }
    if (!this.data.myAllBooks && this.data.editor.all) return; // 对方负责全部礼簿，我无权改
    this.setData({ [`editor.books[${i}].on`]: !this.data.editor.books[i].on, 'editor.all': false });
  },
  onEdAll() {
    if (!this.data.myAllBooks || !this.data.orgMode) return;
    this.setData({ 'editor.all': !this.data.editor.all });
  },
  onEdCancel() { this.setData({ editor: null }); },
  async onEdSave() {
    const ed = this.data.editor;
    const m = this.data.list[ed.idx];
    try {
      const picked = ed.books.filter(b => b.on).map(b => b._id);
      if (!ed.all && !picked.length) return wx.showToast({ title: '请选择负责的礼簿', icon: 'none' });
      // 我看不到的礼簿不在列表里：保留对方原有的，不随这次保存改动（非机构模式只负责选中的一本）
      const hidden = !this.data.orgMode ? [] : (m.bookIds || []).filter(id => !(this._books || []).some(b => b._id === id));
      const bookIds = ed.all ? [] : picked.slice(0, this.data.orgMode ? 100 : 1).concat(hidden);
      // 我没有的权限不在列表里：保留对方原有的，不随这次保存改动
      const perms = ed.perms.filter(x => x.on).map(x => x.key)
        .concat((m.perms || []).filter(k => !this.data.myPerms.includes(k)));
      await req.memberUpdate(m._id, { title: this.data.orgMode ? ed.title : undefined, bookIds, allBooks: ed.all, perms });
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
    // 右上角菜单转发不带邀请卡：只有点页面上的分享按钮才发邀请 / 移交 / 共享
    if (!res || res.from !== 'button') return { title: '慧礼记｜扫码随礼、自动记账、人情往来一本清', path: '/pages/index/index' };
    const type = (res && res.target && res.target.dataset && res.target.dataset.type) || 'clerk';
    const name = this.data.accountName;
    if (type === 'transfer') {
      const names = this._transferNames || [];
      return {
        title: names.length === 1 ? `礼簿「${names[0]}」移交给你，请确认接收` : `「${name}」的 ${names.length || ''} 本礼簿移交给你，请确认接收`,
        path: `/pages/invite/invite?token=${this.data.transferToken}`
      };
    }
    const path = `/pages/invite/invite?token=${this.data.clerkToken}`;
    // 邀请卡只能 1 人使用：发出后马上换一张新的，避免下次又发出同一张（v3.66.7）
    this.setData({ clerkToken: '' });
    setTimeout(() => this.makeClerkInvite(), 300);
    return {
      title: `邀请你为「${name}」记账`,
      path
    };
  },

  noop() {},
  /** 头像加载失败：回落默认头像 */
  onAvatarErr(e) { const p = e.currentTarget.dataset.p; if (p) this.setData({ [p]: '' }); },

  goContact() { wx.navigateTo({ url: '/pages/contact/contact' }); }
});
