// components/my-gifts — 我的随礼记录（宾客的 myreceipts 页、往来页「随礼记录」栏共用，v3.73.0）
// 分栏：等待主家确认 / 主家未确认收到 / 已取消 / 已入簿；每笔可展开时间线；
// 未收到的显示时间与原因，可「重新登记」「分享给主家」。数据全部来自 payment.myReceipts，只含本人用当前微信登记的记录。
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const { REC } = require('../../utils/status.js');
const guestsub = require('../../utils/guestsub.js');
const giftdot = require('../../utils/giftdot.js');

const HINT = {
  transferred: '你已告知主家转账完成，主家核对微信到账后会确认入簿，届时会出现在「已入簿」里，可查看电子回执。',
  pending: '这笔还没点「我已完成转账」。如果已经转账，请再扫一次主家的礼簿码，按提示点「继续」→「我已完成转账」；没转账可以不用管，过一段时间会自动取消。',
  rejected: '主家没有确认收到这笔。如果你已经转账，请先和主家联系核对（可点「分享给主家」）；确认没转成功，可以点「重新登记」。',
  rejectedFuneral: '主家暂时没有核实到这笔。如果你已经转账，请先和主家联系核对（可点「分享给主家」）；确认没转成功，可以点「重新登记」。',
  keptFuneral: '主家核对后仍未核实到账。如果你确实已转账，请直接联系主家（可点「分享给主家」）；确认没转成功，可以点「重新登记」。',
  kept: '主家核对后仍维持未收到。如果你确实已转账，请直接联系主家（可点「分享给主家」）；确认没转成功，可以点「重新登记」。',
  void: '主家作废了这笔记录。如有疑问，请直接联系主家核对；这条记录会保留 30 天。',
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
  data: { rejTitle: '主家未确认收到', appeal: null, loading: true, loadErr: '', list: [], waiting: [], rejected: [], cancelled: [], voided: [], corrections: [], vouchers: [], openId: '', empty: false },
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
          if (w.status === REC.VOID) return '主家已作废';
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
          if (w.status === REC.VOID) return HINT.void;
          return HINT[w.status] || '';
        };
        const view = w => {
          const tl = (w.timeline || []).map(t => ({ text: t.text, atStr: fmt.dateTime(t.at) }));
          return {
            ...w,
            amountStr: fmt.money(w.amount),
            timeStr: fmt.dateTime(w.voidedAt || w.rejectedAt || w.transferredAt || w.createdAt),
            regStr: fmt.dateTime(w.createdAt),
            timeline: tl,
            stText: stText(w),
            hint: hintOf(w),
            // 「分享给主家」的卡片标题：不含任何 openid，只有宾客自己填的姓名、金额、日期
            shareTitle: `${w.funeral ? '致奠人' : '随礼人'}${w.payerName}，${fmt.day(w.createdAt).slice(5).replace('-', '月')}日${w.funeral ? '登记奠仪' : '转账'}￥${fmt.money(w.amount)}，请核对`
          };
        };
        // 主家修改 / 作废 / 申请更正：上次看过之后的标「新」（v3.85.0）
        const seen0 = this._seen0 === undefined ? giftdot.seen() : this._seen0;
        this._seen0 = seen0;
        const isNew = t => !!t && new Date(t).getTime() > seen0;
        const STV = { paid: '已入簿', void: '主家已作废', rejected: '主家未确认收到' };
        this._raw = {
          list: (res.list || []).map(r => ({
            ...r, amountStr: fmt.money(r.amount), timeStr: fmt.dateTime(r.paidAt || r.createdAt),
            isNew: r.amended && isNew(r.lastChangeAt),
            changes: (r.changes || []).map(t => ({ text: t.text, atStr: fmt.dateTime(t.at) }))
          })),
          waiting: (res.waiting || []).map(view),
          rejected: (res.rejected || []).map(view),
          cancelled: (res.cancelled || []).map(view),
          voided: (res.voided || []).map(w => ({ ...view(w), isNew: isNew(w.voidedAt) })),
          corrections: (res.corrections || []).map(c => ({
            ...c, amountStr: fmt.money(c.amount), atStr: fmt.dateTime(c.at), expireStr: fmt.dateTime(c.expireAt),
            what: c.kind === 'amount' ? `把金额从 ￥${fmt.money(c.amount)} 更正为 ￥${fmt.money(c.newAmount)}`
              : (c.kind === 'name' ? `把姓名「${c.payerName}」更正为「${c.newName}」` : '作废这笔记录')
          })),
          vouchers: (res.vouchers || []).map(v => ({
            ...v, amountStr: fmt.money(v.amount), stText: v.funeral && v.status === REC.REJECTED ? '主家暂未核实到账' : (STV[v.status] || ''),
            timeStr: fmt.dateTime(v.voidedAt || v.rejectedAt || v.paidAt || v.snapshotAt),
            timeline: (v.timeline || []).map(t => ({ text: t.text, atStr: fmt.dateTime(t.at) }))
          }))
        };
        // 红点：看过了就记下；还有待确认的更正申请时红点保留
        giftdot.markSeen(res.lastChangeAt);
        try { getApp().setGiftDot((res.correctionN || 0) > 0); } catch (e) { /* 忽略 */ }
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
      const d = { list: pick(raw.list), waiting: pick(raw.waiting), rejected: pick(raw.rejected), cancelled: pick(raw.cancelled), voided: pick(raw.voided), corrections: pick(raw.corrections), vouchers: pick(raw.vouchers) };
      d.rejTitle = rejTitleOf(d.rejected);
      d.empty = !d.list.length && !d.waiting.length && !d.rejected.length && !d.cancelled.length && !d.voided.length && !d.corrections.length && !d.vouchers.length;
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
          const sub = await subP;
          await req.payAppeal(a.rid, String(a.note || '').trim().slice(0, 50), String(a.ref || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 6), sub);
          this.setData({ appeal: null });
          wx.showToast({ title: '已提交申请', icon: 'success' });
          await this.reload();
        } catch (err) { /* toast 已提示 */ this.setData({ 'appeal.busy': false }); }
      })();
    },

    // —— 主家申请更正（v3.85.0）：随礼人同意后才生效，拒绝或 7 天没处理保持原样 ——
    onCorrReply(e) {
      const { id, d } = e.currentTarget.dataset;
      const c = this.data.corrections.find(x => x._id === id);
      if (!c || this._replying) return;
      const agree = d === 'agree';
      wx.showModal({
        title: agree ? '同意更正' : '拒绝更正',
        content: agree ? `同意后，主家的记录会${c.what}，之后不能撤回。确定同意？` : '拒绝后这笔记录保持原样，主家会看到你已拒绝。确定拒绝？',
        confirmText: agree ? '同意' : '拒绝',
        success: async m => {
          if (!m.confirm) return;
          this._replying = true;
          try {
            await req.payCorrectReply(id, d);
            wx.showToast({ title: agree ? '已同意' : '已拒绝', icon: 'success' });
            await this.reload();
          } catch (err) { /* toast 已提示 */ } finally { this._replying = false; }
        }
      });
    },

    /** 开启变更提醒：重新订阅「记账提醒」，主家修改 / 作废这笔时微信通知（一次性订阅；订阅必须在点击的同步调用链里） */
    onResub(e) {
      const id = e.currentTarget.dataset.id;
      if (this._resub) return;
      this._resub = true;
      const subP = guestsub.ask('reject');
      return (async () => {
        try {
          const sub = await subP;
          if (!sub.guestRejectNotify) return wx.showToast({ title: '未开启提醒', icon: 'none' });
          await req.payResub(id, sub);
          wx.showToast({ title: '已开启提醒', icon: 'success' });
        } catch (err) { /* toast 已提示 */ } finally { this._resub = false; }
      })();
    },

    /** 删除自己保留的凭证（主家删除礼簿 / 注销后留下的）：只删自己这份，不影响任何人 */
    onVoucherDel(e) {
      const v = this.data.vouchers.find(x => x._id === e.currentTarget.dataset.id);
      if (!v) return;
      wx.showModal({
        title: '删除凭证',
        content: `删除后，你将看不到这笔 ￥${v.amountStr} 的随礼凭证，无法恢复。确定删除？`,
        confirmText: '删除',
        success: async m => {
          if (!m.confirm) return;
          try {
            await req.payDeleteVoucher(v.ids);
            wx.showToast({ title: '已删除', icon: 'success' });
            await this.reload();
          } catch (err) { /* toast 已提示 */ }
        }
      });
    },

    noop() {}
  }
});
