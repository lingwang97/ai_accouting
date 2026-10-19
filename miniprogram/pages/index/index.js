// pages/index/index.js — 首页 / 工作台（按身份切换）
// 主家、记账人：工作台——当前礼簿概览 + 出示礼簿码 / 待确认 / 礼台记账 / 打印机 四个常用操作
// 宾客、未登录：扫码随礼
const req = require('../../utils/request.js');
const fmt = require('../../utils/format.js');
const notify = require('../../utils/notify.js');
const scenes = require('../../utils/scenes.js');
const theme = require('../../utils/theme.js');
const cache = require('../../utils/cache.js');
const perm = require('../../utils/perm.js');
const device = require('../../utils/device.js');

const POLL_MS = 5000;
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
    printerName: '',
    pm: {},            // 当前身份的权限（记账人按各自权限显示操作）
    notifyTip: '',     // 新礼金提醒未开启 / 发送失败时的提示
    guideTip: false,   // 「第一次使用？看看使用说明」小卡片（关闭后不再显示）
    themeStyle: ''
  },

  onShow() {
    theme.apply(this);
    this.setData({ guideTip: !wx.getStorageSync('guide_tip_closed') });
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
        canSwitch: perm.map(d.perms, d.role).books && !d.restricted, // 能管理礼簿且不限礼簿范围才可切换
        notifyTip: notify.tipText(d.lastNotify),
        book: b ? { ...b, typeLabel: scenes.label(b.type), sumStr: fmt.money(b.sum), sumCls: sumCls(fmt.money(b.sum)) } : null,
        todaySum: fmt.money(d.today.sum),
        todayCount: d.today.count,
        pendingCount: d.pending.count,
        pendingSum: fmt.money(d.pending.sum),
        joinCount: d.pendingMembers || 0  // 申请加入、待主家同意的人数
      };
      this.setData({ mode: 'host', ...view });
      // 身份变化（是否只读）后按对应间隔重新轮询；页面已隐藏时不重启
      if (this._timer && this._pollMs !== (view.readonly ? POLL_MS_READONLY : POLL_MS)) this.startTimer();
      cache.set('dashboard', view);
      app.setBadge(d.pending.count); // 同时刷新底部菜单：首个菜单显示为「工作台」
      theme.apply(this, b ? b.type : 'other');
    } catch (e) {
      if (this.data.mode === 'loading') this.toGuest();
    }
  },

  toGuest() {
    this.clearTimer();
    cache.set('dashboard', null);
    this.setData({ mode: 'guest', account: null });
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
      this.setData({ pendingCount: pending.count, pendingSum: fmt.money(pending.sum) });
      getApp().setBadge(pending.count);
    } catch (e) { /* 静默 */ }
  },

  // —— 工作台操作 ——
  /** 机构模式 / 只负责部分场次：出示当前场次的「本场礼簿码」 */
  goQrcode() {
    const b = this.data.book;
    const perBook = b && (this.data.restricted || (this.data.account && this.data.account.orgMode));
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
    let list = [];
    try { list = (await req.bookList()).list.filter(b => !b.archived); } catch (e) { return; }
    const cur = this.data.book && this.data.book._id;
    const max = list.length > 6 ? 5 : 6;
    const shown = list.slice(0, max);
    const items = shown.map(b => (b._id === cur ? '✓ ' : '') + (b.hostName ? `${b.hostName} · ${b.name}` : b.name));
    if (list.length > max) items.push('更多礼簿…');
    if (!items.length) return this.goBooks();
    wx.showActionSheet({
      itemList: items,
      success: async res => {
        const b = shown[res.tapIndex];
        if (!b) return this.goBooks();
        if (b._id === cur) return;
        try {
          await req.bookSetActive(b._id);
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
  goMembers() { wx.navigateTo({ url: '/pages/members/members' }); },
  goRecords() { wx.switchTab({ url: '/pages/records/records' }); },
  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },
  /** 使用说明小卡片：记账人打开记账人分页 */
  goGuide() {
    wx.navigateTo({ url: '/pages/guide/guide?tab=' + (this.data.role === 'clerk' ? 'clerk' : 'host') });
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

