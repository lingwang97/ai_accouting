// pages/transfer/transfer.js — 移交给主家（v3.77.4 从记账人页挪来）：选礼簿 → 生成移交卡片 → 发给主家本人
// 只有主家本人可用；移交卡点开即接收（pages/invite），没选的礼簿留在自己名下
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const scenes = require('../../utils/scenes.js');
const theme = require('../../utils/theme.js');

Page({
  data: {
    loading: true,
    orgMode: false,
    accountName: '',
    transferToken: '', // 选好礼簿后生成
    books: [],         // [{ _id, name, typeLabel, count, sumStr, archived, on }]
    stayClerk: true,   // 移交后继续为对方记账
    transferDesc: ''   // 已生成卡片的说明
  },

  onLoad() { theme.early(this); }, // 首帧前同步套主题色（v3.70.1）

  onShow() {
    this.setData({ primary: theme.apply(this).primary });
    if (!this._inited) this.init();
  },

  async init() {
    try {
      const { account, role } = await req.accountGet();
      if (role !== 'owner') {
        this.setData({ loading: false });
        return wx.showModal({
          title: '仅主家可用', content: '只有主家本人可以把礼簿移交给真正的主家', showCancel: false, confirmText: '知道了',
          success: () => this.back()
        });
      }
      this._inited = true;
      const orgMode = !!(account && account.orgMode);
      wx.setNavigationBarTitle({ title: '移交主家' });
      this.setData({ orgMode, accountName: (account && account.accountName) || '' });
      const { list } = await req.bookList(); // 含已归档的礼簿，也可以移交
      this.setData({
        books: list.map(b => ({
          _id: b._id, name: b.name, typeLabel: scenes.label(b.type), count: b.count || 0,
          sumStr: fmt.money(b.sum || 0), archived: !!b.archived, on: false
        }))
      });
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ loading: false });
    }
  },

  back() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/mine/mine' });
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

  /** 分享卡片：只有点页面上的分享按钮才发移交卡；右上角转发走默认首页 */
  onShareAppMessage(res) {
    if (!res || res.from !== 'button' || !this.data.transferToken) return { title: '慧礼记｜扫码随礼、自动记账、人情往来一本清', path: '/pages/index/index' };
    const names = this._transferNames || [];
    return {
      title: names.length === 1 ? `礼簿「${names[0]}」移交给你，请确认接收` : `「${this.data.accountName}」的 ${names.length || ''} 本礼簿移交给你，请确认接收`,
      path: `/pages/invite/invite?token=${this.data.transferToken}`
    };
  }
});
