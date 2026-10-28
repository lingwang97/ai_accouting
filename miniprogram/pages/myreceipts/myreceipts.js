// pages/myreceipts/myreceipts.js — 宾客：我的随礼记录（主家已确认的随礼，可查看电子回执）
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const theme = require('../../utils/theme.js');
const { REC } = require('../../utils/status.js');

Page({
  data: { list: [], waiting: [], loading: true, loadErr: '', themeStyle: '' },

  onShow() {
    this.setData({ themeStyle: theme.styleOf(theme.current()) });
    theme.applyNav();
    this.load();
  },

  /**
   * 已入簿的回执 + 等待主家确认的（v3.66.0：宾客转完账可以先离开，回来在这里看进度）
   * 加载失败且没有数据时显示原因与重试，不显示「暂无随礼记录」
   */
  async load() {
    if (this._loading) return;
    this._loading = true;
    try {
      const { list, waiting } = await req.myReceipts({ silent: true });
      this.setData({
        loadErr: '',
        list: list.map(r => ({ ...r, amountStr: fmt.money(r.amount), timeStr: fmt.dateTime(r.paidAt || r.createdAt) })),
        waiting: (waiting || []).map(w => ({
          ...w,
          amountStr: fmt.money(w.amount),
          timeStr: fmt.dateTime(w.transferredAt || w.createdAt),
          stText: w.status === REC.TRANSFERRED ? '等待主家确认' : '还没点「我已完成转账」'
        }))
      });
    } catch (e) {
      if (!this.data.list.length && !this.data.waiting.length) this.setData({ loadErr: req.errText(e, '随礼记录没加载出来') });
      else wx.showToast({ title: req.errText(e), icon: 'none' });
    } finally {
      this._loading = false;
      this.setData({ loading: false });
    }
  },
  onRetryLoad() { this.setData({ loadErr: '', loading: true }); this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },
  /** 等待确认的一行：说明怎么回事 */
  onWaitTip(e) {
    const w = this.data.waiting[e.currentTarget.dataset.i];
    if (!w) return;
    wx.showModal({
      title: w.status === REC.TRANSFERRED ? '等待主家确认' : '还没点完成转账',
      content: w.status === REC.TRANSFERRED
        ? '你已告知主家转账完成，主家核对微信到账后会确认入簿，届时这里会出现电子回执。'
        : '这笔还没点「我已完成转账」。如果已经转账，请再扫一次主家的礼簿码，按提示点「继续」→「我已完成转账」；没转账可以不用管，过一段时间会自动取消。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  /** 宾客转化：我家也要办事收礼 → 首页（登录后创建礼簿） */
  goHostEntry() { wx.switchTab({ url: '/pages/index/index' }); },
  /** 转发给好友 / 分享到朋友圈：落地首页（宾客扫码随礼，主家创建礼簿） */
  onShareAppMessage() {
    return { title: '慧礼记｜扫码随礼、自动记账、人情往来一本清', path: '/pages/index/index' };
  },
  onShareTimeline() {
    return { title: '慧礼记｜办事收礼，扫码随礼自动记账' };
  },

  onOpen(e) {
    wx.navigateTo({ url: `/pages/receipt/receipt?rid=${e.currentTarget.dataset.id}` });
  }
});
