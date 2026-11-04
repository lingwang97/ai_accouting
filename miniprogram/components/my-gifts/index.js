// components/my-gifts — 我的随礼记录（宾客的 myreceipts 页、往来页「随礼记录」栏共用）
// v3.85.1：改成分标签分页——全部 / 已入簿 / 待确认 / 未收到 / 有变动；每页 20 条，上滑加载更多（页面 onReachBottom 调 loadMore），下拉刷新（页面调 reload）。
// 「有变动」里放主家修改 / 作废 / 申请更正（待我同意的更正申请在最上面）；「全部」最后一页之后追加主家删簿后保留的凭证。
// 数据全部来自 payment.myReceipts（带 tab 参数）与 giftStat，只含本人用当前微信登记的记录，不含 openid。
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

const TABS = [
  { k: 'all', t: '全部' },
  { k: 'paid', t: '已入簿' },
  { k: 'waiting', t: '待确认' },
  { k: 'rejected', t: '未收到' },
  { k: 'changed', t: '有变动' }
];

const EMPTY = {
  all: '暂无随礼记录。扫码随礼后进度会显示在这里，需用登记时的同一微信查看',
  paid: '还没有已入簿的记录',
  waiting: '没有等待主家确认的记录（只显示最近 3 天）',
  rejected: '没有未收到的记录（保留 30 天）',
  changed: '近 30 天没有主家修改、作废或申请更正的记录'
};

/** 「未收到」标签的叫法：已加载的未收到记录全是白事用「未核实」，不说「未收到」；混合时用中性说法 */
function rejLabelOf(rows) {
  const rej = (rows || []).filter(r => r.status === REC.REJECTED);
  if (!rej.length) return '未收到';
  const fun = rej.filter(r => r.funeral).length;
  if (fun === rej.length) return '未核实';
  return fun ? '未确认' : '未收到';
}

Component({
  properties: {
    keyword: { type: String, value: '', observer() { this.refilter(); } },
    // 用在底部菜单页（往来）时为 true：弹层停在自定义底部菜单上沿，避免「提交申请」被菜单盖住（v3.74.1）
    inTab: { type: Boolean, value: false }
  },
  data: {
    tab: 'all', segTo: 'mt-all', segFade: false, tabs: TABS.map(x => ({ ...x, dot: false })), loading: true, loadErr: '', more: false, moreBusy: false,
    rows: [], vouchers: [], openId: '', empty: false, emptyText: EMPTY.all, appeal: null
  },
  lifetimes: {
    attached() {
      this._cache = {};
      this._seen0 = giftdot.seen(); // 本次进入前看过的变动时间：之后的变动行标「新」
      this.reload();
    },
    ready() { this.measureSeg(); }
  },
  methods: {
    /** 重新拉取当前标签第一页 + 红点（页面 onShow / 下拉刷新时调用）；返回 Promise */
    async reload() {
      if (this._loading) return;
      this._loading = true;
      try {
        await Promise.all([this.loadTab(this.data.tab, 0), this.refreshDot()]);
      } finally {
        this._loading = false;
        this.setData({ loading: false });
        this.triggerEvent('loaded', { empty: this.data.empty });
      }
    },

    /** 红点：待我确认的更正申请，或有看过之后的新变动（轻量接口 giftStat） */
    /** 标签条右侧渐变提示：内容比框宽、且还没滑到最右时显示（v3.86.1） */
    onSegScroll() { this.measureSeg(); },
    measureSeg() {
      this.createSelectorQuery().select('.mg-seg').fields({ size: true, scrollOffset: true }, r => {
        if (!r) return;
        const fade = r.scrollWidth > r.width + 2 && r.scrollLeft + r.width < r.scrollWidth - 4;
        if (fade !== this.data.segFade) this.setData({ segFade: fade });
      }).exec();
    },

    async refreshDot() {
      try {
        const st = await req.giftStat({ silent: true });
        this._stat = st;
        const dot = giftdot.of(st);
        const dot4 = dot && this.data.tab !== 'changed' ? true : (st.correctionN || 0) > 0;
        this.setData({ 'tabs[4].dot': dot4 });
        // 「有变动」有红点：标签条自动滑到该项，窄屏不会漏看（每次进入只滑一次，v3.86.1）
        if (dot4 && !this._dotScrolled && this.data.tab !== 'changed') { this._dotScrolled = true; this.setData({ segTo: 'mt-changed' }); }
        try { getApp().setGiftDot(dot); } catch (e) { /* 忽略 */ }
      } catch (e) { /* 红点取不到不影响列表 */ }
    },

    /** 取某个标签的一页；cursor 为 0 / 空表示第一页（替换列表），否则追加 */
    async loadTab(tab, cursor) {
      try {
        const res = await req.myReceiptsTab(tab, cursor, { silent: true });
        if (tab !== this.data.tab) return; // 已切到别的标签：丢弃
        const rows = (res.rows || []).map(w => this.view(w));
        const prev = cursor ? (this._cache[tab] ? this._cache[tab].rows : []) : [];
        const all = prev.concat(rows);
        this._cache[tab] = { rows: all, next: res.next, vouchers: res.vouchers ? res.vouchers.map(v => this.voucherView(v)) : (cursor && this._cache[tab] ? this._cache[tab].vouchers : []) };
        if (tab === 'changed' && !cursor) {
          giftdot.markSeen(res.lastChangeAt); // 看过「有变动」：记下时间，红点只在还有待确认的更正申请时保留
          this.setData({ 'tabs[4].dot': all.some(r => r.corr) });
          try { getApp().setGiftDot(all.some(r => r.corr)); } catch (e) { /* 忽略 */ }
        }
        this.setData({ loadErr: '' });
        this.show(tab);
      } catch (e) {
        if (!this._cache[tab]) this.setData({ loadErr: req.errText(e, '随礼记录没加载出来') });
        else wx.showToast({ title: req.errText(e), icon: 'none' });
      }
    },

    /** 把缓存里的标签数据显示出来（按搜索词筛选） */
    show(tab) {
      const c = this._cache[tab] || { rows: [], next: null, vouchers: [] };
      const k = String(this.properties.keyword || '').trim();
      const pick = arr => (k ? arr.filter(r => [r.accountName, r.payerName, r.themeName].some(x => (x || '').includes(k))) : arr);
      const rows = pick(c.rows);
      const vouchers = tab === 'all' && c.next === null ? pick(c.vouchers || []) : [];
      const rejLabel = rejLabelOf(c.rows);
      this.setData({
        rows, vouchers, more: c.next !== null && c.next !== undefined, 'tabs[3].t': rejLabel,
        empty: !rows.length && !vouchers.length, emptyText: k ? `没有找到「${k}」` : (tab === 'rejected' ? EMPTY.rejected.replace('未收到', rejLabel) : EMPTY[tab])
      });
    },

    refilter() { if (this._cache) this.show(this.data.tab); },

    /** 切换标签：先显示已缓存的，再刷新第一页 */
    onTab(e) {
      const tab = e.currentTarget.dataset.k;
      if (tab === this.data.tab) return;
      this.setData({ tab, segTo: 'mt-' + tab, openId: '', loadErr: '', rows: [], vouchers: [], more: false, empty: false });
      if (this._cache[tab]) this.show(tab);
      else this.setData({ loading: true });
      this.loadTab(tab, 0).then(() => this.setData({ loading: false }));
    },

    /** 上滑加载更多（页面 onReachBottom 调用） */
    async loadMore() {
      const tab = this.data.tab;
      const c = this._cache[tab];
      if (!c || c.next === null || c.next === undefined || this.data.moreBusy || this._loading) return;
      this.setData({ moreBusy: true });
      try { await this.loadTab(tab, c.next); } finally { this.setData({ moreBusy: false }); }
    },

    /** 一条记录的显示数据 */
    view(w) {
      const stText = () => {
        if (w.status === REC.PAID) return '已入簿';
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
      const hint = () => {
        if (w.status === REC.REJECTED) return w.appealStatus === 'kept' ? (w.funeral ? HINT.keptFuneral : HINT.kept) : (w.funeral ? HINT.rejectedFuneral : HINT.rejected);
        if (w.status === REC.CANCELLED) return w.auto ? HINT.cancelAuto : HINT.cancelSelf;
        if (w.status === REC.VOID) return HINT.void;
        return HINT[w.status] || '';
      };
      const t0 = w.voidedAt || w.rejectedAt || (w.status === REC.PAID ? w.paidAt : '') || w.transferredAt || w.createdAt;
      const c = w.corr;
      return {
        ...w,
        amountStr: fmt.money(w.amount),
        timeStr: fmt.dateTime(t0),
        regStr: fmt.dateTime(w.createdAt),
        timeline: (w.timeline || []).map(t => ({ text: t.text, atStr: fmt.dateTime(t.at) })),
        changes: (w.changes || []).map(t => ({ text: t.text, atStr: fmt.dateTime(t.at) })),
        stText: stText(),
        hint: hint(),
        isNew: (w.amended || w.status === REC.VOID || !!c) && !!w.lastChangeAt && new Date(w.lastChangeAt).getTime() > (this._seen0 || 0),
        corr: c ? {
          ...c, atStr: fmt.dateTime(c.at), expireStr: fmt.dateTime(c.expireAt),
          what: c.kind === 'amount' ? `把金额从 ￥${fmt.money(w.amount)} 更正为 ￥${fmt.money(c.newAmount)}`
            : (c.kind === 'name' ? `把姓名「${w.payerName}」更正为「${c.newName}」` : '作废这笔记录')
        } : null,
        // 「分享给主家」的卡片标题：不含任何 openid，只有宾客自己填的姓名、金额、日期
        shareTitle: `${w.funeral ? '致奠人' : '随礼人'}${w.payerName}，${fmt.day(w.createdAt).slice(5).replace('-', '月')}日${w.funeral ? '登记奠仪' : '转账'}￥${fmt.money(w.amount)}，请核对`
      };
    },

    // 凭证（主家删簿 / 注销后保留）：在 data.vouchers 里只读；展示文案在 wxml 里拼
    voucherView(v) {
      const STV = { paid: '已入簿', void: '主家已作废', rejected: '主家未确认收到' };
      return {
        ...v, amountStr: fmt.money(v.amount), stText: v.funeral && v.status === REC.REJECTED ? '主家暂未核实到账' : (STV[v.status] || ''),
        timeStr: fmt.dateTime(v.voidedAt || v.rejectedAt || v.paidAt || v.snapshotAt),
        timeline: (v.timeline || []).map(t => ({ text: t.text, atStr: fmt.dateTime(t.at) }))
      };
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

    /** 点卡片：已入簿看回执，其他状态展开说明与经过 */
    onCard(e) {
      if (e.currentTarget.dataset.st === 'paid') this.onOpen(e);
      else this.onToggle(e);
    },

    onOpen(e) {
      wx.navigateTo({ url: `/pages/receipt/receipt?rid=${e.currentTarget.dataset.id}` });
    },

    // —— 申请再核对（v3.74.0）：每笔 1 次；说明 ≤50 字、转账单号后几位（选填）；提交时再请求一次通知订阅，主家处理后宾客能收到提醒 ——
    onAppealOpen(e) {
      const w = this.data.rows.find(x => x._id === e.currentTarget.dataset.id);
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
          this._cache = {};
          await this.reload();
        } catch (err) { /* toast 已提示 */ this.setData({ 'appeal.busy': false }); }
      })();
    },

    // —— 主家申请更正（v3.85.0）：随礼人同意后才生效，拒绝或 7 天没处理保持原样 ——
    onCorrReply(e) {
      const { id, d } = e.currentTarget.dataset;
      const c = this.data.rows.find(x => x._id === id);
      if (!c || !c.corr || this._replying) return;
      const agree = d === 'agree';
      wx.showModal({
        title: agree ? '同意更正' : '拒绝更正',
        content: agree ? `同意后，主家的记录会${c.corr.what}，之后不能撤回。确定同意？` : '拒绝后这笔记录保持原样，主家会看到你已拒绝。确定拒绝？',
        confirmText: agree ? '同意' : '拒绝',
        success: async m => {
          if (!m.confirm) return;
          this._replying = true;
          try {
            await req.payCorrectReply(id, d);
            wx.showToast({ title: agree ? '已同意' : '已拒绝', icon: 'success' });
            this._cache = {};
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
            this._cache = {};
            await this.reload();
          } catch (err) { /* toast 已提示 */ }
        }
      });
    },

    noop() {}
  }
});
