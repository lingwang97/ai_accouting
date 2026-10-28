// pages/reconcile/reconcile.js — 一键对账：当前礼簿（可切换）按支付方式、状态、记账人汇总，可复制对账单 / 保存图片
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const theme = require('../../utils/theme.js');
const receipt = require('../../utils/receipt.js');
const perm = require('../../utils/perm.js');

// 对账图最多画的行数：750 × (80 + 行数×52 + 60 + 小程序码 220) 不超过约 4000px，避免部分安卓机画布过高导出失败
const MAX_LINES = 70;

Page({
  data: {
    books: [],        // 可选礼簿（含已归档）
    bookIdx: 0,
    range: 'all',     // all 全部 | today 今日
    r: null,          // 对账结果（已格式化）
    loading: true,
    saving: false,
    canRecalc: false, // 有「管理礼簿」权限（列表里的礼簿都是负责范围内的，与 books.recalc 的服务端校验一致）
    themeStyle: ''
  },

  async onLoad(options) {
    const acc0 = getApp().globalData.account;
    this.setData({ org: !!(acc0 && acc0.orgMode), staffWord: acc0 && acc0.orgMode ? '礼台人员' : '记账人' }); // 机构模式称「礼台人员」
    if (!(await perm.guard('export', '你没有对账与导出的权限', { viewer: true }))) return; // 文案同 records.reconcile
    try {
      this.setData({ canRecalc: perm.can('books') && getApp().globalData.role !== 'viewer' });
      const { list, activeBookId } = await req.bookList();
      const books = list.map(b => ({ _id: b._id, name: b.hostName ? `${b.hostName} · ${b.name}` : b.name }));
      const want = options.bookId || activeBookId;
      this.setData({ books, bookIdx: Math.max(0, books.findIndex(b => b._id === want)) });
    } catch (e) { /* toast 已提示 */ }
    this.load();
  },

  onShow() { theme.apply(this); },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    const b = this.data.books[this.data.bookIdx];
    const seq = this._seq = (this._seq || 0) + 1; // 连续切换礼簿 / 范围时，只采用最后一次的结果
    this.setData({ loading: true });
    try {
      const day = this.data.range === 'today' ? fmt.day(new Date()) : '';
      const r = await req.reconcile(b ? b._id : '', day);
      if (seq !== this._seq) return;
      const m = x => ({ count: x.count, sumStr: fmt.money(x.sum) });
      this.setData({
        r: {
          ...r,
          bookTitle: r.book.hostName ? `${r.book.hostName} · ${r.book.name}` : r.book.name,
          paid: m(r.paid), wechat: m(r.wechat), cash: m(r.cash), deskCash: m(r.deskCash), guestCash: m(r.guestCash),
          deskWechat: m(r.deskWechat || { count: 0, sum: 0 }), guestWechat: m(r.guestWechat || r.wechat),
          mixed: { ...(r.mixed || { batches: 0 }), sumStr: fmt.money((r.mixed || {}).sum || 0), wechatStr: fmt.money((r.mixed || {}).wechat || 0), cashStr: fmt.money((r.mixed || {}).cash || 0) },
          transferred: m(r.transferred), pending: m(r.pending), rejected: m(r.rejected), void: m(r.void),
          diff: { ...r.diff, declaredStr: fmt.money(r.diff.declared), actualStr: fmt.money(r.diff.actual), gapStr: fmt.money(Math.abs(r.diff.gap)) },
          handlers: r.handlers.map(h => ({ ...h, sumStr: fmt.money(h.sum), cashSumStr: fmt.money(h.cashSum) })),
          at: fmt.dateTime(new Date())
        }
      });
    } catch (e) {
      if (seq === this._seq) this.setData({ r: null });
    } finally {
      if (seq === this._seq) this.setData({ loading: false });
    }
  },

  onBook(e) {
    this.setData({ bookIdx: Number(e.detail.value) });
    this.load();
  },

  onRange(e) {
    this.setData({ range: e.currentTarget.dataset.v });
    this.load();
  },

  /** 重算整本礼簿的合计（与「按日筛选」无关）；二次确认后调用 books.recalc */
  onRecalc() {
    const b = this.data.books[this.data.bookIdx];
    if (!b || this.data.recalcing) return;
    wx.showModal({
      title: '重算合计',
      content: '将按这本礼簿全部已入簿的记录重新计算份数与合计（不是只算当前筛选的日期），不会修改任何礼金记录。确定重算吗？',
      confirmText: '重算',
      success: async r => {
        if (!r.confirm) return;
        this.data.recalcing = true;
        try {
          await req.bookRecalc(b._id);
          wx.showToast({ title: '已重算', icon: 'success' });
          await this.load();
        } catch (e) { /* toast 已提示 */ } finally {
          this.data.recalcing = false;
        }
      }
    });
  },

  goPending() {
    if (getApp().globalData.role === 'viewer') return wx.showToast({ title: '家人共享为只读，由主家确认', icon: 'none' });
    if (!perm.can('confirm')) return wx.showToast({ title: '你没有「确认收礼」权限', icon: 'none' });
    wx.navigateTo({ url: '/pages/pending/pending' });
  },

  /** 对账单文字（复制、画图共用） */
  lines() {
    const r = this.data.r;
    const out = [
      `【对账单】${r.bookTitle}`,
      `范围：${this.data.range === 'today' ? '今日 ' + fmt.day(new Date()) : '全部'}　生成：${r.at}`,
      `已入簿：${r.paid.count} 份，￥${r.paid.sumStr}`,
      `· 微信转账：${r.wechat.count} 份，￥${r.wechat.sumStr}`,
      ...(r.deskWechat.count ? [`　- 宾客扫码转账：${r.guestWechat.count} 份，￥${r.guestWechat.sumStr}`, `　- 礼台记账（微信）：${r.deskWechat.count} 份，￥${r.deskWechat.sumStr}`] : []),
      `· 现金合计：${r.cash.count} 份，￥${r.cash.sumStr}`,
      `　- 礼台记账（现金）：${r.deskCash.count} 份，￥${r.deskCash.sumStr}`,
      `　- 宾客现金：${r.guestCash.count} 份，￥${r.guestCash.sumStr}`
    ];
    if (r.mixed.batches) out.push(`其中转账+现金：${r.mixed.batches} 批，￥${r.mixed.sumStr}（转账 ￥${r.mixed.wechatStr}、现金 ￥${r.mixed.cashStr}，已分别计入上面）`);
    if (r.transferred.count) out.push(`待确认：${r.transferred.count} 份，￥${r.transferred.sumStr}`);
    if (r.pending.count) out.push(`宾客未转账：${r.pending.count} 份，￥${r.pending.sumStr}`);
    if (r.rejected.count) out.push(`未收到（已拒绝）：${r.rejected.count} 份，￥${r.rejected.sumStr}`);
    if (r.diff.count) out.push(`按实收入簿：${r.diff.count} 份，宾客登记 ￥${r.diff.declaredStr}，实收 ￥${r.diff.actualStr}（${r.diff.gap < 0 ? '少' : '多'} ￥${r.diff.gapStr}）`);
    if (r.void.count) out.push(`已作废：${r.void.count} 份，￥${r.void.sumStr}`);
    if (r.handlers.length) {
      out.push('按记账人：');
      r.handlers.forEach(h => out.push(`· ${h.name}：${h.count} 份 ￥${h.sumStr}${h.cashCount ? `（其中现金 ${h.cashCount} 份 ￥${h.cashSumStr}）` : ''}`));
    }
    return out;
  },

  onCopy() {
    if (!this.data.r) return;
    wx.setClipboardData({ data: this.lines().join('\n'), success: () => wx.showToast({ title: '已复制，可粘贴到微信', icon: 'none' }) });
  },

  /** 对账单保存为图片（底部附小程序码，发到家族群顺带引流） */
  async onSaveImage() {
    if (!this.data.r || this.data.saving) return;
    this.setData({ saving: true });
    const all = this.lines();
    const lines = fmt.clipLines(all, MAX_LINES);
    if (lines.length < all.length) wx.showToast({ title: '内容较长，图片只含前面部分', icon: 'none' });
    const codeUrl = (await receipt.withAppCode({})).appCode || '';
    wx.createSelectorQuery().select('#reconCanvas').fields({ node: true }).exec(async res => {
      try {
        const canvas = res && res[0] && res[0].node;
        if (!canvas) throw new Error('画布未就绪');
        const code = await loadImage(canvas, codeUrl);
        const W = 750;
        const LH = 52;
        const CODE = code ? 220 : 0;
        const H = 80 + lines.length * LH + 60 + CODE;
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = theme.current().primary;
        ctx.fillRect(0, 0, W, 12);
        ctx.textBaseline = 'middle';
        lines.forEach((t, i) => {
          ctx.fillStyle = i === 0 ? '#222222' : '#444444';
          ctx.font = i === 0 ? 'bold 34px sans-serif' : '28px sans-serif';
          ctx.fillText(t, 40, 70 + i * LH, W - 80);
        });
        if (code) {
          const y = 80 + lines.length * LH + 30;
          ctx.drawImage(code, 40, y, 150, 150);
          ctx.fillStyle = '#999999';
          ctx.font = '24px sans-serif';
          ctx.fillText('慧礼记 · 扫码随礼自动记账、一键对账', 210, y + 60);
          ctx.fillText('长按识别小程序码，免费创建电子礼簿', 210, y + 100);
        }
        wx.canvasToTempFilePath({
          canvas,
          fileType: 'png',
          success: r => wx.saveImageToPhotosAlbum({
            filePath: r.tempFilePath,
            success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
            fail: e => { if (!/cancel/i.test((e && e.errMsg) || '')) wx.showToast({ title: '保存失败，请允许保存到相册', icon: 'none' }); },
            complete: () => this.setData({ saving: false })
          }),
          fail: () => { wx.showToast({ title: '生成图片失败', icon: 'none' }); this.setData({ saving: false }); }
        });
      } catch (e) {
        wx.showToast({ title: '生成图片失败', icon: 'none' });
        this.setData({ saving: false });
      }
    });
  }
});

/** 下载并加载小程序码；失败返回 null（对账单照常生成） */
function loadImage(canvas, url) {
  if (!url) return Promise.resolve(null);
  return new Promise(resolve => {
    wx.downloadFile({
      url,
      success: r => {
        if (r.statusCode !== 200) return resolve(null);
        const img = canvas.createImage();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = r.tempFilePath;
      },
      fail: () => resolve(null)
    });
  });
}
