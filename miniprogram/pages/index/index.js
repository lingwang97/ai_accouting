// pages/index/index.js — 首页 / 工作台（按身份切换）
// 主家、记账人：工作台——当前礼簿概览 + 出示礼簿码 / 待确认 / 礼台记账 / 打印机 四个常用操作
// 宾客、未登录：扫码随礼；已登录、选了办事收礼还没建好主家信息时，顶部显示「开始办事 · 3 步」进度卡片
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const notify = require('../../utils/notify.js');
const scenes = require('../../utils/scenes.js');
const theme = require('../../utils/theme.js');
const cache = require('../../utils/cache.js');
const perm = require('../../utils/perm.js');
const device = require('../../utils/device.js');
const setup = require('../../utils/setup.js');

const POLL_MS = 5000;
const DISMISS_KEY = 'idx_dismissed';
function loadDismissed() {
  try { const d = wx.getStorageSync(DISMISS_KEY); return d && typeof d === 'object' ? d : {}; } catch (e) { return {}; }
}
const POLL_MS_READONLY = 30000; // 家人只读：不处理待确认，放慢轮询
const LOGOUT_KEY = 'logged_out';
// 礼金合计位数多时缩小字号（如 1234567.89 共 10 位）
const sumCls = str => (str.length >= 13 ? 'xlong' : str.length >= 10 ? 'long' : '');

Page({
  data: {
    mode: 'loading',   // loading | host 工作台 | guest 扫码随礼
    loggedIn: false,
    account: null,
    role: 'none',
    book: null,        // 当前礼簿 { name, typeLabel, date, sumStr, count }
    todaySum: '0.00',
    todayCount: 0,
    pendingCount: 0,
    pendingSum: '0.00',
    otherPending: 0,   // 其他礼簿的待确认份数（提示用）
    todayBook: 0,      // 当前礼簿今日入簿份数
    printerName: '',
    pm: {},            // 当前身份的权限（记账人按各自权限显示操作）
    notifyTip: '',     // 新礼金提醒未开启 / 发送失败时的提示
    guideTip: false,   // 「第一次使用？看看使用教程」小卡片（关闭后不再显示）
    joins: [],         // 申请加入的进度 [{ aid, name, role, pending, dk }]
    dismissed: {},     // 本地已读签名：notify=提示文案；j_<aid>=已同意的身份。签名变化（文案 / 身份不同）再提醒
    setupCard: null,   // 已登录、选了办事收礼但还没建好主家信息：「开始办事 · 3 步」进度 { name, code, book }
    themeStyle: ''
  },

  onShow() {
    // 已退出登录：立即显示宾客首页，不先渲染上一个账户的工作台
    if (getApp().isLoggedOut()) {
      if (this.data.mode !== 'guest') this.toGuest();
      this.setData({ loggedIn: false });
      return;
    }
    theme.apply(this);
    this.setData({ guideTip: !wx.getStorageSync('guide_tip_closed'), dismissed: loadDismissed() });
    // 秒开：先显示上次的工作台数据，后台刷新
    if (this.data.mode === 'loading' && !wx.getStorageSync(LOGOUT_KEY)) {
      let c = cache.get('dashboard');
      // 旧版缓存没有权限表：按身份补算；记账人权限尚未取到时丢弃缓存，避免入口被隐藏
      if (c && !c.pm) {
        const g = getApp().globalData;
        if (c.role === 'owner' || g.perms) {
          c.pm = perm.map(g.perms, c.role);
          if (c.canSwitch === undefined) c.canSwitch = c.pm.books && !c.restricted;
        } else c = null;
      }
      if (c) {
        this.setData({ ...c, mode: 'host' });
        theme.apply(this, c.book ? c.book.type : 'other');
      }
    }
    this.refresh();
    this.startTimer();
  },
  startTimer() {
    this.clearTimer();
    this._pollMs = this.data.readonly ? POLL_MS_READONLY : POLL_MS;
    this._timer = setInterval(() => this.refreshPending(true), this._pollMs);
  },
  onHide() { this.clearTimer(); },
  onUnload() { this.clearTimer(); },
  clearTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  async refresh() {
    const app = getApp();
    const saved = wx.getStorageSync('printerDevice');
    this.setData({ printerName: (saved && saved.name) || '' });
    try {
      // 一次取齐：主家信息、当前礼簿、今日、待确认；与启动时的登录检查并行发出
      const loggedOut = !!wx.getStorageSync(LOGOUT_KEY);
      const dP = loggedOut ? null : req.dashboard().catch(() => null);
      if (!app.globalData.user && !loggedOut) await app.loginReady;
      const user = app.globalData.user;
      this.setData({ loggedIn: !!user });
      if (!user) return this.toGuest();

      const d = (dP && (await dP)) || (await req.dashboard());
      this.setData({ joins: (d.joins || []).map(j => ({ ...j, dk: 'j_' + j.aid })) }); // 申请加入的进度：待同意 / 已同意待切换
      app.globalData.account = d.account;
      app.globalData.role = d.role;
      app.globalData.perms = d.perms || [];
      theme.setAccount(d.account); // 主家选的主题色
      app._accountChecked = true;
      if (!d.account) return this.toGuest();

      let b = d.book;
      if (d.needBooks) {
        // 首次使用：books.list 会自动建默认礼簿、补算合计
        const { list, activeBookId } = await req.bookList();
        b = list.find(x => x._id === activeBookId) || null;
      }
      const view = {
        account: d.account,
        role: d.role,
        restricted: !!d.restricted,
        readonly: !!d.readonly,     // 家人共享：只读
        pm: perm.map(d.perms, d.role),
        // 能管理礼簿且不限礼簿范围才可切换；机构模式下负责多场的记账人切换的是自己正在记的一场（mySwitch）
        mySwitch: !!d.mySwitch,
        noBook: d.noBook || '', // ended 记账人负责的礼簿已结束；none 主家还没有当前礼簿
        canSwitch: !!d.mySwitch || (d.role !== 'clerk' || !(d.account && d.account.orgMode)) && perm.map(d.perms, d.role).books && !d.restricted,
        notifyTip: notify.tipText(d.lastNotify),
        book: b ? { ...b, typeLabel: scenes.label(b.type), sumStr: fmt.money(b.sum), sumCls: sumCls(fmt.money(b.sum)) } : null,
        todaySum: fmt.money(d.today.sum),
        todayCount: d.today.count,
        todayBook: d.today.book || 0, // 当前礼簿的今日份数
        pendingCount: d.pending.count,
        pendingSum: fmt.money(d.pending.sum),
        otherPending: d.pending.other || 0,
        joinCount: d.pendingMembers || 0  // 申请加入、待主家同意的人数
      };
      this.setData({ mode: 'host', ...view });
      // 身份变化（是否只读）后按对应间隔重新轮询；页面已隐藏时不重启
      if (this._timer && this._pollMs !== (view.readonly ? POLL_MS_READONLY : POLL_MS)) this.startTimer();
      cache.set('dashboard', view);
      // 刚通过创建向导建好：提示下一步
      if (app.globalData.justSetup) {
        app.globalData.justSetup = false;
        wx.showModal({
          title: '礼簿已创建',
          content: '下一步：出示礼簿码，宾客用微信扫码就能随礼，礼金自动记到这本礼簿。',
          confirmText: '去出示',
          cancelText: '稍后',
          success: res => { if (res.confirm) this.goQrcode(); }
        });
      }
      app.setBadge(d.pending.count); // 同时刷新底部菜单：首个菜单显示为「工作台」
      theme.apply(this, b ? b.type : 'other');
    } catch (e) {
      if (this.data.mode === 'loading') this.toGuest();
    }
  },

  toGuest() {
    this.clearTimer();
    cache.set('dashboard', null);
    // 选了「办事收礼」、还没建好主家信息：显示进度卡片，可接着创建
    const card = this.data.loggedIn && setup.intent() === 'host' ? setup.progress(setup.draft()) : null;
    this.setData({ mode: 'guest', account: null, setupCard: card });
    theme.apply(this, '');
    getApp().setBadge(0);
  },

  /** 待确认份数与合计（服务端只做计数 + 聚合，不拉整张列表）；silent=true 为轮询，有新礼金时震动 */
  async refreshPending(silent) {
    if (this.data.mode !== 'host') return;
    try {
      const pending = await req.pendingStat();
      if (!pending) return;
      if (silent && pending.count > this.data.pendingCount) wx.vibrateShort({ type: 'heavy', fail() {} });
      this.setData({ pendingCount: pending.count, pendingSum: fmt.money(pending.sum), otherPending: pending.other || 0 });
      getApp().setBadge(pending.count);
    } catch (e) { /* 静默 */ }
  },

  // —— 工作台操作 ——
  /**
   * 机构模式：出示当前场次的「本场礼簿码」；只负责部分礼簿的记账人，负责的不是主家当前礼簿时也用本场礼簿码
   * 其余（含记账人负责的正是当前礼簿）与主家完全相同：主家礼簿码 + 同样的扫码流程
   */
  goQrcode() {
    const b = this.data.book;
    const a = this.data.account || {};
    const perBook = b && (a.orgMode || (this.data.role === 'clerk' && b._id !== a.activeBookId));
    wx.navigateTo({ url: '/pages/qrcode/qrcode' + (perBook ? `?bookId=${b._id}` : '') });
  },
  goPending() { wx.navigateTo({ url: '/pages/pending/pending' }); },
  goCash() { wx.navigateTo({ url: '/pages/cash/cash' }); },
  goPrinter() { wx.navigateTo({ url: '/pages/printer/printer' }); },
  goBooks() { wx.navigateTo({ url: '/pages/books/books' }); },
  goReconcile() {
    const b = this.data.book;
    wx.navigateTo({ url: '/pages/reconcile/reconcile' + (b ? `?bookId=${b._id}` : '') });
  },

  /** 切换当前礼簿：点哪本立即切换（超过 6 本时最后一项进礼簿管理） */
  async onSwitchBook() {
    // 读取礼簿列表期间、选择框关闭之前不再响应，避免连点叠出多个选择框
    if (this._switching) return;
    this._switching = true;
    let list = [];
    try { list = (await req.bookList()).list.filter(b => !b.archived); } catch (e) { this._switching = false; return; }
    const cur = this.data.book && this.data.book._id;
    const max = list.length > 6 ? 5 : 6;
    const shown = list.slice(0, max);
    const items = shown.map(b => (b._id === cur ? '✓ ' : '') + (b.hostName ? `${b.hostName} · ${b.name}` : b.name));
    if (list.length > max) items.push('更多礼簿…');
    if (!items.length) { this._switching = false; return this.goBooks(); }
    wx.showActionSheet({
      itemList: items,
      complete: () => { this._switching = false; },
      success: async res => {
        const b = shown[res.tapIndex];
        if (!b) return this.goBooks();
        if (b._id === cur) return;
        try {
          await (this.data.mySwitch ? req.bookSetMine(b._id) : req.bookSetActive(b._id));
          require('../../utils/printer.js').clearTemplateCache(); // 打印样式跟礼簿走
          theme.apply(this, b.type);
          wx.showToast({ title: '已切换', icon: 'success' });
          this.refresh();
        } catch (e) { /* toast 已提示 */ }
      }
    });
  },
  goOrgSummary() { wx.navigateTo({ url: '/pages/orgsummary/orgsummary' }); },
  goBookDetail() {
    const b = this.data.book;
    if (b) wx.navigateTo({ url: `/pages/bookdetail/bookdetail?id=${b._id}` });
  },
  goAccount() { wx.navigateTo({ url: '/pages/account/account' }); },
  /** 主家已同意加入：切换到这个身份 */
  async onJoinSwitch(e) {
    const j = this.data.joins[e.currentTarget.dataset.i];
    if (!j || j.pending) return;
    try {
      await req.identitySwitch(j.aid);
      getApp().resetIdentity();
      wx.showToast({ title: '已切换', icon: 'success' });
      this.refresh();
    } catch (err) { /* toast 已提示 */ }
  },
  /** 主家创建向导（还没有主家信息时） */
  goSetup() { wx.navigateTo({ url: '/pages/setup/setup' }); },
  /** 「开始办事」卡片：我只是来随礼 */
  onDismissSetup() {
    setup.setIntent('guest');
    this.setData({ setupCard: null });
  },
  goMembers() { wx.navigateTo({ url: '/pages/members/members' }); },
  goRecords() { wx.switchTab({ url: '/pages/records/records' }); },
  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },
  /** 使用教程小卡片：记账人打开记账人分页 */
  goGuide() {
    wx.navigateTo({ url: '/pages/guide/guide?tab=' + (this.data.role === 'clerk' ? 'clerk' : 'host') });
  },
  /** 关闭「新礼金提醒未开启」：记下当前提示文案，文案变化（如发送失败码不同）再提醒 */
  onCloseNotify() { this.markDismissed('notify', this.data.notifyTip); },
  /** 关闭「已同意」的加入提示：记下身份，之后不再提示（再次被同意为别的身份会再提醒） */
  onCloseJoin(e) {
    const j = this.data.joins[e.currentTarget.dataset.i];
    if (j) this.markDismissed(j.dk, j.role);
  },
  markDismissed(key, sig) {
    const d = { ...this.data.dismissed, [key]: sig };
    this.setData({ dismissed: d });
    try { wx.setStorageSync(DISMISS_KEY, d); } catch (e) { /* 忽略 */ }
  },
  onCloseGuideTip() {
    try { wx.setStorageSync('guide_tip_closed', true); } catch (e) { /* 忽略 */ }
    this.setData({ guideTip: false });
  },
  goMyReceipts() { wx.navigateTo({ url: '/pages/myreceipts/myreceipts' }); }, // 宾客首页

  /** 转发给好友 / 分享到朋友圈：落地首页（宾客扫码随礼，主家创建礼簿） */
  onShareAppMessage() {
    return { title: '慧礼记｜扫码随礼、自动记账、人情往来一本清', path: '/pages/index/index' };
  },
  onShareTimeline() {
    return { title: '慧礼记｜办事收礼，扫码随礼自动记账' };
  },

  /** 开启新礼金提醒（必须在点击中直接调用订阅） */
  async onSubscribe() {
    const ok = await notify.subscribe();
    if (ok) {
      this.setData({ notifyTip: '' });
      wx.showModal({
        title: '已开启新礼金提醒',
        content: '宾客转账后你会收到微信服务通知。建议勾选「总是保持以上选择」，之后每次确认礼金自动续订。',
        showCancel: false
      });
    } else {
      wx.showModal({
        title: '未开启提醒',
        content: '未弹出授权？右上角「···」→ 设置 → 通知管理 打开',
        showCancel: false
      });
    }
  },

  /** 扫描主家的礼簿码 → 进入随礼页（主家去别人家随礼也用这里） */
  onScan() {
    wx.scanCode({
      onlyFromCamera: false,
      success: res => {
        // 小程序码扫描结果 path 形如 pages/pay/pay?scene=<aid>；分享链接/旧码为 aid=<aid>
        const raw = decodeURIComponent(res.path || res.result || '');
        const m = raw.match(/pages\/pay\/pay\?(?:scene=)?(?:aid=)?([a-zA-Z0-9_-]+)/) || raw.match(/aid=([a-zA-Z0-9_-]+)/);
        if (m) {
          wx.navigateTo({ url: `/pages/pay/pay?aid=${m[1]}&via=scan` });
        } else {
          wx.showToast({ title: '不是有效的礼簿码', icon: 'none' });
        }
      },
      fail: err => {
        if (String((err && err.errMsg) || '').includes('cancel')) return; // 用户取消
        wx.showToast({ title: device.isPC() ? '当前设备不支持扫码' : '扫码失败，请重试', icon: 'none' });
      }
    });
  }
});

