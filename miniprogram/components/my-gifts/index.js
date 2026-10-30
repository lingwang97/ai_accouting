// components/my-gifts — 我的随礼记录（宾客的 myreceipts 页、往来页「随礼记录」栏共用，v3.73.0）
// 分栏：等待主家确认 / 主家未确认收到 / 已取消 / 已入簿；每笔可展开时间线；
// 未收到的显示时间与原因，可「重新登记」「分享给主家」。数据全部来自 payment.myReceipts，只含本人用当前微信登记的记录。
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const { REC } = require('../../utils/status.js');
const guestsub = require('../../utils/guestsub.js');

const HINT = {
  transferred: '你已告知主家转账完成，主家核对微信到账后会确认入簿，届时会出现在「已入簿」里，可查看电子回执。',
  pending: '这笔还没点「我已完成转账」。如果已经转账，请再扫一次主家的礼簿码，按提示点「继续」→「我已完成转账」；没转账可以不用管，过一段时间会自动取消。',
  rejected: '主家没有确认收到这笔。如果你已经转账，请先和主家联系核对（可点「分享给主家」）；确认没转成功，可以点「重新登记」。',
  rejectedFuneral: '主家暂时没有核实到这笔。如果你已经转账，请先和主家联系核对（可点「分享给主家」）；确认没转成功，可以点「重新登记」。',
  keptFuneral: '主家核对后仍未核实到账。如果你确实已转账，请直接联系主家（可点「分享给主家」）；确认没转成功，可以点「重新登记」。',
  kept: '主家核对后仍维持未收到。如果你确实已转账，请直接联系主家（可点「分享给主家」）；确认没转成功，可以点「重新登记」。',
  cancelAuto: '超过 30 分钟没点「我已完成转账」，已自动取消。如果已经转账，请再扫一次主家的礼簿码重新登记。',
  cancelSelf: '这笔登记已取消。'
};

/** 「未确认」一栏的标题：全是白事记录用「暂未核实到账」，不说「未收到」；喜事 / 其他用「未确认收到」；混合时用中性说法（v3.74.4） */
function rejTitleOf(list) {
  const fun = (list || []).filter(r => r.funeral).length;
  if (fun && fun === list.length) return '主家暂未核实到账';
  return fun ? '主家未确认到账' : '主家未确认收到';
}

Component({
  properties: {
    keyword: { type: String, value: '', observer() { this.refilter(); } },
    // 用在底部菜单页（往来）时为 true：弹层停在自定义底部菜单上沿，避免「提交申请」被菜单盖住（v3.74.1）
    inTab: { type: Boolean, value: false }
  },
  data: { rejTitle: '主家未确认收到', appeal: null, loading: true, loadErr: '', list: [], waiting: [], rejected: [], cancelled: [], openId: '', empty: false },
  lifetimes: {
    attached() { this.reload(); }
  },
  methods: {
    /** 重新拉取（页面 onShow / 下拉刷新时调用）；返回 Promise */
    async reload() {
      if (this._loading) return;
      this._loading = true;
      try {
        const res = await req.myReceipts({ silent: true });
        const stText = w => {
          if (w.status === REC.TRANSFERRED) return '等待主家确认';
          if (w.status === REC.PENDING) return '还没点「我已完成转账」';
          if (w.status === REC.REJECTED) {
            if (w.appealStatus === 'open') return '已申请再核对，等待主家处理';
            if (w.appealStatus === 'kept') return (w.funeral ? '核对后仍未核实到账' : '主家核对后维持未收到') + (w.appealReply ? `：${w.appealReply}` : '');
            return w.funeral ? '主家暂未核实到账' : '主家未确认收到';
          }
          return w.auto ? '超时自动取消' : '已取消';
        };
        const hintOf = w => {
          if (w.status === REC.REJECTED) return w.appealStatus === 'kept' ? (w.funeral ? HINT.keptFuneral : HINT.kept) : (w.funeral ? HINT.rejectedFuneral : HINT.rejected);
          if (w.status === REC.CANCELLED) return w.auto ? HINT.cancelAuto : HINT.cancelSelf;
          return HINT[w.status] || '';
        };
        const view = w => {
          const tl = (w.timeline || []).map(t => ({ text: t.text, atStr: fmt.dateTime(t.at) }));
          return {
            ...w,
            amountStr: fmt.money(w.amount),
            timeStr: fmt.dateTime(w.rejectedAt || w.transferredAt || w.createdAt),
            regStr: fmt.dateTime(w.createdAt),
            timeline: tl,
            stText: stText(w),
            hint: hintOf(w),
            // 「分享给主家」的卡片标题：不含任何 openid，只有宾客自己填的姓名、金额、日期
            shareTitle: `${w.funeral ? '致奠人' : '随礼人'}${w.payerName}，${fmt.day(w.createdAt).slice(5).replace('-', '月')}日${w.funeral ? '登记奠仪' : '转账'}￥${fmt.money(w.amount)}，请核对`
          };
        };
        this._raw = {
          list: (res.list || []).map(r => ({ ...r, amountStr: fmt.money(r.amount), timeStr: fmt.dateTime(r.paidAt || r.createdAt) })),
          waiting: (res.waiting || []).map(view),
          rejected: (res.rejected || []).map(view),
          cancelled: (res.cancelled || []).map(view)
        };
        this.setData({ loadErr: '' });
        this.refilter();
      } catch (e) {
        if (!this._raw) this.setData({ loadErr: req.errText(e, '随礼记录没加载出来') });
        else wx.showToast({ title: req.errText(e), icon: 'none' });
      } finally {
        this._loading = false;
        this.setData({ loading: false });
        this.triggerEvent('loaded', { empty: this.data.empty });
      }
    },

    /** 按主家 / 随礼人 / 礼簿名筛选 */
    refilter() {
      const raw = this._raw;
      if (!raw) return;
      const k = String(this.properties.keyword || '').trim();
      const pick = arr => (k ? arr.filter(r => [r.accountName, r.payerName, r.themeName].some(x => (x || '').includes(k))) : arr);
      const d = { list: pick(raw.list), waiting: pick(raw.waiting), rejected: pick(raw.rejected), cancelled: pick(raw.cancelled) };
      d.rejTitle = rejTitleOf(d.rejected);
      d.empty = !d.list.length && !d.waiting.length && !d.rejected.length && !d.cancelled.length;
      this.setData(d);
    },

    onRetryLoad() { this.setData({ loadErr: '', loading: true }); this.reload(); },

    /** 展开 / 收起时间线与说明 */
    onToggle(e) {
      const id = e.currentTarget.dataset.id;
      this.setData({ openId: this.data.openId === id ? '' : id });
    },

    /** 重新登记：回到该主家的随礼页（宾客重新填写、转账、点「我已完成转账」） */
    onRegister(e) {
      const aid = e.currentTarget.dataset.aid;
      if (aid) wx.navigateTo({ url: `/pages/pay/pay?aid=${aid}` });
    },

    onOpen(e) {
      wx.navigateTo({ url: `/pages/receipt/receipt?rid=${e.currentTarget.dataset.id}` });
    },

    // —— 申请再核对（v3.74.0）：每笔 1 次；说明 ≤50 字、转账单号后几位（选填）；提交时再请求一次通知订阅，主家处理后宾客能收到提醒 ——
    onAppealOpen(e) {
      const w = this.data.rejected.find(x => x._id === e.currentTarget.dataset.id);
      if (!w) return;
      this.setData({ appeal: { rid: w._id, name: w.payerName, amountStr: w.amountStr, note: '', ref: '', busy: false } });
    },
    onAppealNote(e) { this.setData({ 'appeal.note': e.detail.value }); },
    onAppealRef(e) { this.setData({ 'appeal.ref': e.detail.value }); },
    onAppealClose() { if (!(this.data.appeal && this.data.appeal.busy)) this.setData({ appeal: null }); },
    onAppealSubmit() {
      const a = this.data.appeal;
      if (!a || a.busy) return;
      const subP = guestsub.ask(); // 必须在第一个 await 之前（点击的同步调用链里）
      this.setData({ 'appeal.busy': true });
      return (async () => {
        try {
          const guestNotify = await subP;
          await req.payAppeal(a.rid, String(a.note || '').trim().slice(0, 50), String(a.ref || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 6), guestNotify);
          this.setData({ appeal: null });
          wx.showToast({ title: '已提交申请', icon: 'success' });
          await this.reload();
        } catch (err) { /* toast 已提示 */ this.setData({ 'appeal.busy': false }); }
      })();
    },

    noop() {}
  }
});
