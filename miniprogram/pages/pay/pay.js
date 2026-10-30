// pages/pay/pay.js — 扫码随礼页（宾客落地页）
// 步骤：form 登记 → transfer 向主家收款码转账 → waiting 等待主家确认 → success（显示回执）/ failed
const req = require('../../utils/request.js');
const { REC } = require('../../utils/status.js');
const fmt = require('../../utils/format.js');
const receipt = require('../../utils/receipt.js');
const scenes = require('../../utils/scenes.js');
const batch = require('../../utils/batch.js');
const samename = require('../../utils/samename.js');
const theme = require('../../utils/theme.js');
const guestsub = require('../../utils/guestsub.js');

const paypoll = require('../../utils/paypoll.js'); // 轮询退避：5 秒 → 10 秒 → 20 秒 → 30 秒，最长 10 分钟（v3.71.0 / v3.75.0）
const NAME_KEY = 'pay_last_name'; // 本机上次随礼用的姓名（宾客常去多家随礼，免得每次重填）
const OPEN_KEY = 'pay_open'; // 本机最近一笔未点「我已完成转账」的随礼（{ aid, rid, record, payCodeUrl, at }）

/** 页面展示用：金额文本、批次名单 */
function viewRecord(r) {
  const items = r.items || [];
  const mixed = r.payMethod === 'mixed';
  return {
    ...r,
    mixed,
    amountStr: fmt.money(r.amount),
    // 需扫码转账的金额（转账+现金时只转转账部分）、交给礼台的现金
    payStr: fmt.money(mixed ? r.transferAmount : r.amount),
    cashStr: fmt.money(r.cashAmount || 0),
    itemsStr: items.length > 1 ? items.map(x => `${x.name} ￥${fmt.money(x.amount)}`).join('、') : ''
  };
}

Page({
  data: {
    aid: '',
    primary: theme.DEFAULT, // 开关颜色，加载主家信息后按主题更新
    account: null,
    loadErr: '',
    loadErrNet: false,   // 读取失败是网络问题（v3.66.0）：显示「点此重试」，不说礼簿码无效
    pollTimeout: false,  // 等待确认超过约 10 分钟、自动查询已停止（v3.66.0）：停止转圈并说明
    step: 'form',      // form | transfer | waiting | success | failed
    payerName: '',
    amount: '',
    remark: '',
    relation: '',
    batchMode: false,  // 批次录入：一次登记多位随礼人，按合计转一笔账
    batchRows: [],
    payMethod: 'wechat', // wechat 微信转账 | cash 现金（跳过收款码与转账步骤）| mixed 转账+现金（仅批次录入）
    relations: scenes.RELATIONS,
    isFuneral: false,
    submitting: false,
    record: null,
    payCodeUrl: '',
    failReason: '',
    onsite: true,        // 在现场（扫码进入）：扫主家屏幕 / 台卡上的收款码；不在现场（转发链接进入）：存相册识别
    showFallback: false, // 在现场时：在本机显示收款码（备用）
    codeSaved: false,    // 宾客手机付款：收款码是否已存入相册
    receiptModel: null,  // 到账后的留存收据
    savingReceipt: false,
    who: '随礼人',       // 白事称「致奠人」、动作称「登记」（v3.65.2，与礼簿码页「奠仪」一致）
    act: '随礼',
    amountFocus: false
  },

  onLoad(options) {
    let aid = options.aid || '';
    // 小程序码 scene 即 aid（兼容旧版 aid=xxx 格式）
    if (!aid && options.scene) {
      const scene = decodeURIComponent(options.scene);
      const m = scene.match(/^(?:aid=)?([a-zA-Z0-9_-]{1,32})$/);
      if (m) aid = m[1];
    }
    if (!aid) {
      this.setData({ loadErr: '二维码无效，请联系收款方' });
      return;
    }
    // 不论什么身份、从哪里进入，一律先引导「扫一扫」扫礼台（主家屏幕 / 台卡）上的收款码，
    // 收款码图片默认收起，看不到 / 扫不到时点开，再存相册转账。
    // 不再按进入场景自动展开：wx.getEnterOptionsSync 取的是小程序启动时的场景，之前从聊天卡片打开过小程序后，
    // 再扫码或从礼簿码页进入随礼页也会被误判为「不在现场」而展开收款码
    let last = '';
    try { last = wx.getStorageSync(NAME_KEY) || ''; } catch (e) { /* 忽略 */ }
    this.setData({ aid, onsite: true, payerName: typeof last === 'string' ? last : '' });
    this.loadAccount(aid).then(() => this.resumeOpen(aid));
  },

  // —— 未完成的随礼：宾客常在微信转完账直接回聊天，没点「我已完成转账」；再次进入时接着处理 ——
  saveOpen(record, payCodeUrl) {
    try { wx.setStorageSync(OPEN_KEY, { aid: this.data.aid, rid: record._id, record, payCodeUrl, at: Date.now() }); } catch (e) { /* 忽略 */ }
  },
  clearOpen() {
    try { wx.removeStorageSync(OPEN_KEY); } catch (e) { /* 忽略 */ }
  },
  async resumeOpen(aid) {
    let o = null;
    try { o = wx.getStorageSync(OPEN_KEY); } catch (e) { /* 忽略 */ }
    if (!o || o.aid !== aid || Date.now() - o.at > 24 * 3600 * 1000 || this.data.step !== 'form') return;
    let status = '';
    try { status = (await req.payStatus(o.rid, { silent: true })).status; } catch (e) { return; }
    if (status === REC.TRANSFERRED) {
      this.setData({ record: viewRecord(o.record), step: 'waiting' });
      return this.startPoll();
    }
    if (status !== REC.PENDING && status !== REC.CANCELLED) return this.clearOpen();
    const v = viewRecord(o.record);
    wx.showModal({
      title: `有一笔未完成的${this.data.act}`,
      content: `${v.payerName} ￥${v.payStr}：已经转账了吗？转了请点「继续」，再点「我已完成转账」。`,
      confirmText: '继续',
      cancelText: '不用了',
      success: r => {
        if (r.confirm) this.setData({ record: v, payCodeUrl: o.payCodeUrl || '', showFallback: false, codeSaved: false, step: 'transfer' });
        else if (r.cancel) {
          this.clearOpen();
          if (status === REC.PENDING) req.payCancel(o.rid).catch(() => {});
        }
      }
    });
  },

  onUnload() {
    this.stopPoll();
  },

  onHide() {
    this.stopPoll();
  },

  onShow() {
    // 付款方去微信转账后返回本页，继续轮询
    if (this.data.step === 'waiting') this.startPoll();
  },

  async loadAccount(aid) {
    try {
      const { account } = await req.accountGetByAid(aid, { silent: true });
      const t = theme.forType(account.book && account.book.type, account.theme && account.theme.chosen ? account.theme.primary : '');
      const funeral = !!(account.book && account.book.type === 'funeral');
      this.setData({ account, isFuneral: funeral, themeStyle: theme.styleOf(t), primary: t.primary, who: funeral ? '致奠人' : '随礼人', act: funeral ? '登记' : '随礼' });
      wx.setNavigationBarColor({ frontColor: '#ffffff', backgroundColor: t.primary, fail() {} });
      wx.setNavigationBarTitle({ title: funeral ? `向「${account.accountName}」致奠` : `向「${account.accountName}」随礼` });
    } catch (e) {
      // 网络失败与「礼簿码无效」区分开：网络问题可重试（宾客在宴会厅信号差很常见）
      if (req.isNetErr(e)) this.setData({ loadErr: req.errText(e) + '，没能读取礼簿信息', loadErrNet: true });
      else this.setData({ loadErr: (e && e.biz && e.message) || '礼簿码无效或主家已停用', loadErrNet: false });
    }
  },
  /** 读取礼簿信息失败（网络）：点此重试 */
  onRetryLoad() {
    if (!this.data.loadErrNet || this._reloading) return;
    this._reloading = true;
    this.setData({ loadErr: '', loadErrNet: false });
    const done = () => { this._reloading = false; }; // 不用 finally，兼容低版本基础库
    this.loadAccount(this.data.aid).then(() => this.resumeOpen(this.data.aid)).then(done, done);
  },

  onName(e) { this.setData({ payerName: e.detail.value }); },
  onAmount(e) { this.setData({ amount: e.detail.value }); },
  /** 姓名键盘点「下一项」：跳到金额 */
  onNameNext() { this.setData({ amountFocus: true }); },
  onAmountBlur() { this.setData({ amountFocus: false }); },
  onRemark(e) { this.setData({ remark: e.detail.value }); },
  onBatchMode(e) {
    const on = e.detail.value;
    this.setData({ batchMode: on, ...(on || this.data.payMethod !== 'mixed' ? {} : { payMethod: 'wechat' }) });
  },
  onBatchChange(e) { this._batchRows = e.detail.rows; },
  onQuick(e) { this.setData({ amount: String(e.currentTarget.dataset.v) }); },
  onRelation(e) {
    const r = e.currentTarget.dataset.r;
    this.setData({ relation: this.data.relation === r ? '' : r });
  },
  onPayMethod(e) { this.setData({ payMethod: e.currentTarget.dataset.m }); },

  /** 第 1 步：确认转账 → 创建待转账记录，进入转账步骤 */
  async onConfirmTransfer() {
    if (this.data.submitting) return;
    let payload;
    if (this.data.batchMode) {
      // 批次录入：多位随礼人，按合计金额转一笔账
      const v = batch.validate(this._batchRows);
      if (v.error) return wx.showToast({ title: v.error, icon: 'none' });
      payload = { items: v.items };
    } else {
      const name = (this.data.payerName || '').trim();
      const amount = Number(this.data.amount);
      if (!name) return wx.showToast({ title: `请填写${this.data.who}姓名`, icon: 'none' });
      if (!Number.isFinite(amount) || amount <= 0) {
        return wx.showToast({ title: `请选择或填写${this.data.isFuneral ? '奠仪' : '礼金'}`, icon: 'none' });
      }
      payload = { payerName: name, amount, remark: this.data.remark, relation: this.data.relation };
    }

    // 转账+现金只填了一位：按这一位的方式提交，不算混合
    const pm = this.data.payMethod === 'mixed' && payload.items && payload.items.length === 1 ? payload.items[0].method : this.data.payMethod;
    // 现金随礼没有「我已完成转账」这一步：在这里订阅入簿通知（必须在第一个 await 之前）
    const subP = pm === 'cash' ? this.askGuestNotify() : null;
    this.setData({ submitting: true });
    try {
      const sub = subP ? await subP : null;
      // 幂等键：弱网重试、连点都带同一个 reqId，服务端只记一条；表单内容变了换新的，提交成功后换新的
      const sig = JSON.stringify([payload, pm]);
      if (!this._reqId || this._reqSig !== sig) {
        this._reqId = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        this._reqSig = sig;
      }
      const reqId = this._reqId;
      let allowDup = false;
      // silent：失败提示由下面 catch 统一处理（限流只弹一个固定说明弹窗，其余错误照常 toast，v3.76.1）
      const send = () => req.payCreate({ aid: this.data.aid, ...payload, payMethod: pm, reqId, dupCheck: true, ...guestsub.flags(sub), ...(allowDup ? { allowDup: true } : {}) }, { silent: true });
      let res = await send();
      // 疑似重复（v3.76.0）：30 分钟内已登记过同名同额，问一下是不是真要再登记一笔（取消则不提交）
      if (res.dupOf) {
        if (!(await this.askDup(res.dupOf))) return;
        allowDup = true;
        res = await send();
      }
      // 同名提醒：主家礼簿里已有别的宾客叫这个名字，请填区分信息后重新提交（取消则不提交）
      if (res.needTag) {
        for (const name of res.needTag) {
          const tag = await samename.askTag(name, { guest: true });
          if (!tag) return;
          if (payload.items) payload.items.forEach(x => { if (x.name === name) x.tag = tag; });
          else payload.tag = tag;
        }
        res = await send();
        if (res.needTag) return wx.showToast({ title: '仍有同名，请修改姓名或区分信息', icon: 'none' });
      }
      if (res.dupOf) return; // 提交期间刚出现的重复：不再追问，本次不登记
      const { record } = res;
      this._reqId = ''; // 已创建，下一次提交换新 reqId
      if (!payload.items) { try { wx.setStorageSync(NAME_KEY, payload.payerName); } catch (e) { /* 忽略 */ } } // 下次随礼自动填好姓名
      // 现金：不经收款码与转账，直接等待主家确认收到
      if (record.payMethod === 'cash') {
        this.setData({ record: viewRecord(record), step: 'waiting' });
        this.startPoll();
        return;
      }
      // 重复提交（弱网重试）时记录状态可能已推进：已转账等待确认 / 已入簿 / 被拒，直接进入对应步骤
      if (record.status === REC.TRANSFERRED) {
        this.setData({ record: viewRecord(record), step: 'waiting' });
        this.startPoll();
        return;
      }
      if (record.status === REC.PAID || record.status === REC.REJECTED) {
        this.setData({ record: viewRecord(record) });
        this.startPoll();
        return;
      }
      // 优先用云函数生成的临时链接（宾客无权直接读取主家上传的图片）
      const payCodeUrl = record.payCodeUrl || (record.payCodeFileID ? await this.getTempUrl(record.payCodeFileID) : '');
      this.setData({
        record: viewRecord(record),
        payCodeUrl,
        showFallback: false, // 收款码默认收起，看不到时点开
        codeSaved: false,
        step: 'transfer'
      });
      this.saveOpen(record, payCodeUrl);
    } catch (e) {
      // 被限流（v3.75.1）：这次没有登记成功，提醒稍等再提交，别直接扫礼台收款码转账（主家会对不上是谁的钱）
      if (e && e.biz && /稍等几秒/.test(e.message || '')) this.busyTip();
      else if (e && (e.biz || req.isNetErr(e))) req.showErr(e); // 其他请求错误（额度、网络、业务拒绝）照常提示；程序内部异常不弹
    } finally {
      this.setData({ submitting: false });
    }
  },

  /**
   * 疑似重复登记的确认（v3.76.0）：dup { name, amount, status, minutes }；返回是否「再登记一笔」
   * 不再登记时告诉宾客去哪里看刚才那笔
   */
  askDup(dup) {
    const cash = this.data.payMethod === 'cash';
    const st = { pending: cash ? '礼台还没确认' : '还没点「我已完成转账」', transferred: '正在等主家确认', paid: '主家已确认入簿' }[dup.status] || '已登记';
    return new Promise(resolve => {
      wx.showModal({
        title: `你刚登记过${this.data.act === '登记' ? '' : '这笔'}`,
        content: `${dup.minutes} 分钟前已登记 ${dup.name} ￥${fmt.money(dup.amount)}（${st}）。确定要再登记一笔吗？同一笔${this.data.isFuneral ? '奠仪' : '礼金'}不要重复登记。`,
        confirmText: '再登记',
        cancelText: '不用了',
        success: r => {
          if (!r.confirm) {
            wx.showToast({ title: `可在${this.myGiftsWhere()}查看`, icon: 'none', duration: 3000 });
            return resolve(false);
          }
          resolve(true);
        },
        fail: () => resolve(false)
      });
    });
  },

  /** 限流提示弹窗：说明还没登记成功（v3.75.1）；固定文案，不拼云端原话（v3.76.1，避免与 toast 重复） */
  busyTip() {
    wx.showModal({
      title: '还没有登记成功',
      content: this.data.payMethod === 'cash'
        ? '现在提交的人较多，这次还没有登记成功。请过几秒再点一次提交。'
        : '现在提交的人较多，这次还没有登记成功。请过几秒再点一次提交，等登记成功、页面显示收款码后再转账，不要直接扫礼台的收款码转账。',
      confirmText: '知道了',
      showCancel: false
    });
  },

  onToggleFallback() {
    this.setData({ showFallback: !this.data.showFallback });
  },

  /** 判断错了时一键切换：在现场 ⇄ 不在现场 */
  async onSwitchOnsite() {
    const onsite = !this.data.onsite;
    this.setData({ onsite, showFallback: false });
    if (!onsite && this.data.payCodeUrl && !this.data.codeSaved && (await this.savePayCode(true))) this.showScanGuide();
  },

  /**
   * 宾客「入簿通知」订阅（v3.66.1）：wx.requestSubscribeMessage 必须在点击的同步调用链里调用，
   * 所以在 onTransferred / 现金「确认随礼」的第一个 await 之前调用；返回是否同意（拒绝 / 失败都按不同意，照常继续）
   */
  askGuestNotify() {
    return guestsub.ask();
  },

  /** 「我的随礼记录」在当前身份下的位置：记账人 / 机构模式在「我的」，主家在「往来」，宾客在首页（v3.74.4） */
  myGiftsWhere() {
    const app = getApp();
    const g = app.globalData || {};
    const acc = g.user && g.account;
    if (!acc) return '首页「我的随礼记录」';
    return g.role === 'clerk' || acc.orgMode ? '「我的 → 随礼记录」' : '「往来 → 随礼记录」';
  },

  /** 第 2 步：付款方转账完成 → 等待收款方确认 */
  async onTransferred() {
    if (this.data.submitting) return;
    const subP = this.askGuestNotify(); // 必须在第一个 await 之前（见上）
    this.setData({ submitting: true });
    try {
      const sub = await subP;
      await req.payTransferred(this.data.record._id, sub);
      this.clearOpen();
      this.setData({ step: 'waiting' });
      this.startPoll();
    } catch (e) { /* toast 已提示 */ } finally {
      this.setData({ submitting: false });
    }
  },

  /** 常见问题：教程页第 4 分页，默认展开「宾客常见问题」 */
  goFaq() { wx.navigateTo({ url: '/pages/guide/guide?tab=faq&cat=guest' }); },

  /** 取消本次转账（尚未转账时） */
  onCancel() {
    wx.showModal({
      title: `取消${this.data.act}`,
      content: `确定取消本次${this.data.act}吗？`,
      success: async res => {
        if (!res.confirm) return;
        try {
          await req.payCancel(this.data.record._id);
        } catch (e) {
          // 取消失败（已转账、已被确认等）：不重置表单（request.js 已提示原因），避免宾客以为取消了又重复提交
          return;
        }
        this.clearOpen();
        this.setData({ step: 'form', record: null, payCodeUrl: '' });
      }
    });
  },

  // —— 轮询收款方确认结果 ——
  startPoll() {
    this.stopPoll();
    this._pollAt = Date.now(); // 从头计时：回到页面、点「刷新状态」、下拉刷新都重新从 5 秒开始
    this._on = true;
    if (this.data.pollTimeout) this.setData({ pollTimeout: false });
    this.poll(this._gen);
  },

  stopPoll() {
    this._on = false;
    this._gen = (this._gen || 0) + 1; // 作废进行中的查询，其返回不再处理也不再排下一次
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  },

  async poll(gen) {
    if (!this.data.record || !this._on || gen !== this._gen) return;
    const elapsed = Date.now() - this._pollAt;
    if (elapsed > paypoll.MAX_MS) {
      this.stopPoll();
      this.setData({ pollTimeout: true }); // 停止转圈，说明可以离开、之后去哪里看
      return;
    }
    try {
      const { status, reasonText } = await req.payStatus(this.data.record._id, { silent: true });
      if (gen !== this._gen) return; // 期间已停止 / 重新开始
      if (status === REC.PAID) {
        this.stopPoll();
        wx.vibrateShort({ type: 'medium', fail() {} });
        this.setData({ step: 'success' });
        this.loadReceipt();
      } else if (status === REC.REJECTED) {
        this.stopPoll();
        this.setData({ step: 'failed', failReason: (this.data.isFuneral ? '主家暂未核实到账' : '主家未收到该笔转账') + (reasonText ? `（${reasonText}）` : '') + '，请与主家核实。这笔记录之后可在' + this.myGiftsWhere() + '查看' });
      }
    } catch (e) { /* 网络抖动，下次再试 */ }
    // 逐步放慢：每次查询返回后再排下一次，网络慢时不会重叠
    if (this._on && gen === this._gen) this._timer = setTimeout(() => this.poll(gen), paypoll.delay(Date.now() - this._pollAt));
  },

  /** 收款方确认后加载留存收据（失败时退回简单成功页） */
  async loadReceipt() {
    try {
      // 批次录入：一张合并回执列出全部随礼人
      const { record, accountName, tpl } = await req.receiptGet(this.data.record._id, true);
      const model = receipt.buildModel(record, tpl, accountName);
      this.setData({ receiptModel: model });
      this.setData({ receiptModel: await receipt.withAppCode(model) }); // 小程序码后补，不拖慢回执显示
    } catch (e) { /* 保留简单成功页 */ }
  },

  async onSaveReceipt() {
    if (this.data.savingReceipt || !this.data.receiptModel) return;
    this.setData({ savingReceipt: true });
    try {
      const path = await receipt.toImage('#receiptCanvas', this.data.receiptModel);
      await receipt.saveImage(path);
    } catch (e) {
      wx.showToast({ title: '生成图片失败，可截屏留存', icon: 'none' });
    } finally {
      this.setData({ savingReceipt: false });
    }
  },

  /** 宾客转化：我家也要办事收礼 → 首页（登录后创建礼簿） */
  goHostEntry() { wx.switchTab({ url: '/pages/index/index' }); },

  /** 手动刷新（超时后） */
  onRefresh() {
    this.startPoll();
  },

  /** 下拉刷新（v3.75.0）：只在「等待主家确认」步骤立即查一次并从头计时；其他步骤不做任何事（不重置表单 / 不丢已填内容） */
  onPullDownRefresh() {
    if (this.data.step === 'waiting' && this.data.record) this.startPoll();
    wx.stopPullDownRefresh();
  },

  onRetry() {
    this.setData({ step: 'form', record: null, payCodeUrl: '', failReason: '', receiptModel: null, payMethod: 'wechat' });
  },

  getTempUrl(fileID) {
    return new Promise(resolve => {
      wx.cloud.getTempFileURL({
        fileList: [fileID],
        success: res => resolve((res.fileList[0] && res.fileList[0].tempFileURL) || ''),
        fail: () => resolve('')
      });
    });
  },

  /** 保存收款码到相册（手动重新保存） */
  async onSavePayCode() {
    if (await this.savePayCode(true)) this.showScanGuide();
  },

  /** 下载并保存收款码；返回是否成功（失败已提示） */
  async savePayCode(loading) {
    if (!this.data.payCodeUrl) return false;
    if (loading) wx.showLoading({ title: '保存中' });
    try {
      const dl = await new Promise((r, j) => wx.downloadFile({ url: this.data.payCodeUrl, success: r, fail: j }));
      await new Promise((r, j) => wx.saveImageToPhotosAlbum({ filePath: dl.tempFilePath, success: r, fail: j }));
      if (loading) wx.hideLoading();
      this.setData({ codeSaved: true });
      return true;
    } catch (e) {
      if (loading) wx.hideLoading();
      if (/auth|deny/i.test((e && e.errMsg) || '')) {
        wx.showModal({
          title: '需要相册权限',
          content: '收款码要先保存到相册，才能用微信扫一扫识别。请允许保存到相册',
          confirmText: '去设置',
          success: res => res.confirm && wx.openSetting()
        });
      } else {
        // 下载被拦截等：打开大图，长按「保存图片」（系统预览不受下载域名限制）
        this.saveByPreview();
      }
      return false;
    }
  },

  /** 备用保存方式：大图预览中长按保存 */
  saveByPreview() {
    wx.showModal({
      title: '请长按保存收款码',
      content: '长按大图选「保存图片」，再用扫一扫 → 相册转账',
      confirmText: '打开大图',
      showCancel: false,
      success: () => wx.previewImage({ urls: [this.data.payCodeUrl], showmenu: true })
    });
  },

  /** 保存成功后的转账引导 */
  showScanGuide() {
    wx.showModal({
      title: '收款码已存入相册',
      content: '回微信「扫一扫」→ 右上角「相册」选它转账，转完回来点「我已完成转账」',
      confirmText: '去转账',
      showCancel: false
    });
  },

  /** 预览收款码大图（可在大图里长按保存） */
  onPreviewPayCode() {
    if (this.data.payCodeUrl) {
      wx.previewImage({ urls: [this.data.payCodeUrl], showmenu: true });
    }
  }
});

