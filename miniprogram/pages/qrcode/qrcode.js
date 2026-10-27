// pages/qrcode/qrcode.js — 我的收款码（UC3）
// 两种收礼方式（本页顶部切换）：
//   longpress：原模式，展示登记码，付款方在自己手机上长按收款码转账
//   screen：店主亮屏双码，上方登记码（小程序码）+ 下方微信收款码，屏幕常亮、亮度最高
// 两种模式都可生成「收款台卡」（双码合成图，保存相册后打印贴摊位）
const req = require('../../utils/request.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');
const cache = require('../../utils/cache.js');
const fmt = require('../../utils/format.js');

const OFF_PREFIX = 'qroff_';           // 本机保存的礼簿码（离线兜底），放在页面缓存里：切换身份 / 退出登录时随缓存清空
const OFF_REFRESH_MS = 24 * 3600 * 1000; // 礼簿码 / 收款码没变时，至少隔一天才重新下载保存一次

const CARD_W = 750;
const CARD_H = 1240;

Page({
  data: {
    showTry: false, // 模拟宾客随礼：仅开发版 / 体验版显示，正式版隐藏
    account: null,
    qrUrl: '',       // 登记码（小程序码）
    qrFileID: '',
    payCodeUrl: '',  // 个人收款码
    loading: true,
    errMsg: '',
    offline: false,   // 网络不佳：正显示本机保存的礼簿码（v3.66.0）
    offlineAt: ''
  },

  async onLoad(options) {
    try {
      const env = wx.getAccountInfoSync().miniProgram.envVersion;
      this.setData({ showTry: env === 'develop' || env === 'trial' });
    } catch (e) { /* 取不到按正式版：隐藏 */ }
    this._bookId = options.bookId || ''; // 机构版：本场礼簿码
    // 记账人需有「礼簿码与打印」权限
    const role = await getApp().ensureRole();
    if ((role === 'clerk' || role === 'viewer') && !perm.can('show')) {
      wx.showToast({ title: '你没有「礼簿码与打印」权限', icon: 'none' });
      return setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) }), 800);
    }
    this.load();
  },

  onShow() {
    if (this.data.account) { this.lightOn(); this.setNavColor(this.data.primary); }
  },

  /** 导航栏跟随本页主题色（本场是白事时素灰） */
  setNavColor(primary) {
    if (!primary) return;
    wx.setNavigationBarColor({ frontColor: '#ffffff', backgroundColor: primary, fail() {} });
  },

  onHide() { this.lightOff(); },
  onUnload() { this.lightOff(); },

  async load() {
    this.setData({ loading: true });
    try {
      const { account } = await req.accountGet(true, { silent: true });
      if (!account) {
        wx.showToast({ title: '请先完善主家信息', icon: 'none' });
        setTimeout(() => wx.redirectTo({ url: '/pages/account/account' }), 800);
        return;
      }
      const primary = theme.current().primary;
      this.setData({ account, primary });
      this.setNavColor(primary);
      this.lightOn();

      // 本场礼簿码；记账人一律由服务端决定（正在记的是主家当前礼簿时为主家礼簿码，否则为本场码），不用本地缓存
      if (this._bookId || getApp().globalData.role === 'clerk') return await this.loadBookQr(account);

      // 收款码链接与礼簿码并行取（v3.66.0，原先依次等待）；记账人读不到主家上传的收款码图片，优先用云函数生成的链接
      const [payCodeUrl, qr] = await Promise.all([
        account.payCodeUrl || this.getTempUrl(account.payCodeFileID),
        this.getQrFileID(account._id).then(id => this.getTempUrl(id).then(url => ({ id, url }))).catch(e => ({ e }))
      ]);
      this.setData({ payCodeUrl, offline: false });
      if (qr.e || !qr.url) {
        if (!(qr.e && req.isNetErr(qr.e) && this.showOffline())) this.setData({ qrUrl: '', errMsg: '登记码生成失败：' + req.errText(qr.e, '请稍后重试') });
      } else {
        this.setData({ qrFileID: qr.id, qrUrl: qr.url, errMsg: '' });
        this.saveOffline({ sig: [qr.id, account.payCodeFileID || '', account.accountName].join('|'), name: account.accountName, bookName: '', primary, qrUrl: qr.url, payCodeUrl });
      }
    } catch (e) {
      // 读取主家信息失败：网络问题先显示本机保存的礼簿码；没有保存过则显示错误，点击重试
      if (!(req.isNetErr(e) && this.showOffline())) this.setData({ errMsg: '加载失败：' + req.errText(e, '请稍后重试') });
    } finally {
      this.setData({ loading: false });
    }
  },

  onRetry() {
    this.setData({ errMsg: '' });
    this.load();
  },

  /** 本场礼簿码：码里是礼簿 id，宾客扫码直接记入这一场；显示本场主家与本场收款码 */
  async loadBookQr(account) {
    try {
      const r = await req.qrcodeGen(account._id, this._bookId || undefined);
      // 礼簿码与收款码的临时链接并行取（v3.66.0）
      const [qrUrl, payTmp] = await Promise.all([
        this.getTempUrl(r.fileID),
        !r.book && !account.payCodeUrl ? this.getTempUrl(account.payCodeFileID) : ''
      ]);
      if (!r.book) {
        // 主家礼簿码（记账人正在记的就是主家当前礼簿）
        const payCodeUrl = account.payCodeUrl || payTmp;
        this.setData({ qrFileID: r.fileID, qrUrl, payCodeUrl, errMsg: '', offline: false });
        this.saveOffline({ sig: [r.fileID, account.payCodeFileID || '', account.accountName].join('|'), name: account.accountName, bookName: '', primary: this.data.primary, qrUrl, payCodeUrl });
        return;
      }
      // 标题显示主家（机构版为本场主家），下方显示礼簿名称，避免礼簿名显示两次
      const name = (r.book && r.book.hostName) || account.accountName;
      const bookPrimary = theme.forType(r.book && r.book.type).primary; // 本场是白事时素灰
      this.setNavColor(bookPrimary);
      this.setData({
        primary: bookPrimary,
        account: { ...account, accountName: name },
        bookName: r.book ? r.book.name : '',
        qrFileID: r.fileID, qrUrl, payCodeUrl: r.payCodeUrl || account.payCodeUrl || '', errMsg: '', offline: false
      });
      this.saveOffline({ sig: [r.fileID, r.book.payCodeFileID || account.payCodeFileID || '', name, r.book.name].join('|'), name, bookName: r.book.name, primary: bookPrimary, qrUrl, payCodeUrl: r.payCodeUrl || account.payCodeUrl || '', title: '本场礼簿码' });
      wx.setNavigationBarTitle({ title: '本场礼簿码' });
      this._shareId = r.book._id;
      this._shareWord = r.book.type === 'funeral' ? '奠仪' : '随礼'; // 白事不用「随礼」
    } catch (e) {
      if (!(req.isNetErr(e) && this.showOffline())) this.setData({ qrUrl: '', errMsg: '本场礼簿码生成失败：' + req.errText(e, '请稍后重试') });
    }
  },

  // —— 离线兜底（v3.66.0）：成功显示后把礼簿码与收款码存到本机；之后网络不佳时先显示本机保存的，主家照样能出示 ——
  offKey() { return OFF_PREFIX + (this._bookId || 'main'); },
  /** 下载保存到本机（后台进行，失败忽略）；礼簿码 / 收款码 / 名称都没变且不到一天时跳过 */
  async saveOffline(m) {
    if (!m || !m.qrUrl) return;
    const key = this.offKey();
    const old = cache.get(key);
    if (old && old.sig === m.sig && Date.now() - (old.at || 0) < OFF_REFRESH_MS) return;
    try {
      const fs = wx.getFileSystemManager();
      const base = `${wx.env.USER_DATA_PATH}/${key}`;
      const keep = async (url, part) => {
        if (!url) return '';
        const tmp = await downloadUrl(url);
        const path = `${base}_${part}.png`;
        try { fs.unlinkSync(path); } catch (e) { /* 不存在 */ }
        await new Promise((ok, no) => fs.saveFile({ tempFilePath: tmp, filePath: path, success: ok, fail: no }));
        return path;
      };
      const [qr, pay] = await Promise.all([keep(m.qrUrl, 'qr'), keep(m.payCodeUrl, 'pay')]);
      cache.set(key, { sig: m.sig, name: m.name, bookName: m.bookName || '', primary: m.primary || '', title: m.title || '', qr, pay, at: Date.now() });
    } catch (e) { /* 保存失败不影响使用 */ }
  },
  /** 显示本机保存的礼簿码；没有保存过（或文件已被系统清理）返回 false */
  showOffline() {
    const c = cache.get(this.offKey());
    if (!c || !c.qr) return false;
    try { wx.getFileSystemManager().accessSync(c.qr); } catch (e) { return false; }
    const primary = c.primary || theme.current().primary;
    this.setData({
      account: { accountName: c.name }, bookName: c.bookName || '', primary,
      qrUrl: c.qr, qrFileID: '', payCodeUrl: c.pay || '', errMsg: '',
      offline: true, offlineAt: fmt.dateTime(c.at)
    });
    this.setNavColor(primary);
    if (c.title) wx.setNavigationBarTitle({ title: c.title });
    this.lightOn();
    return true;
  },

  /** 主家礼簿码按账户 + 小程序版本缓存，避免每次进入都重新生成上传（只有主家本人走这里） */
  async getQrFileID(aid) {
    let env = 'release';
    try { env = wx.getAccountInfoSync().miniProgram.envVersion; } catch (e) { /* 默认正式版 */ }
    const key = `qr_${aid}_${env}`;
    const cached = wx.getStorageSync(key);
    if (cached) return cached;
    const { fileID } = await req.qrcodeGen(aid);
    wx.setStorageSync(key, fileID);
    return fileID;
  },

  // —— 亮屏模式：最高亮度 + 常亮，离开页面恢复 ——
  lightOn() {
    if (this._lit) return;
    this._lit = true;
    wx.getScreenBrightness({
      success: res => {
        this._brightness = res.value;
        // 回调回来时页面已经离开：立即恢复，不再调到最亮
        if (!this._lit) wx.setScreenBrightness({ value: res.value, fail() {} });
      },
      complete: () => { if (this._lit) wx.setScreenBrightness({ value: 1, fail() {} }); }
    });
    wx.setKeepScreenOn({ keepScreenOn: true, fail() {} });
  },

  lightOff() {
    if (!this._lit) return;
    this._lit = false;
    if (typeof this._brightness === 'number') {
      wx.setScreenBrightness({ value: this._brightness, fail() {} });
    }
    wx.setKeepScreenOn({ keepScreenOn: false, fail() {} });
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

  /** 主家自己模拟宾客随礼，熟悉流程 / 联调 */
  onTry() {
    wx.navigateTo({ url: `/pages/pay/pay?aid=${this._shareId || this.data.account._id}` });
  },

  /** 点击放大 */
  onPreview(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.previewImage({ urls: [url] });
  },

  /** 保存礼簿码（单张，可单独打印或转发） */
  async onSave() {
    const url = this.data.qrUrl || this.data.payCodeUrl;
    if (!url) return;
    try {
      const dl = await new Promise((r, j) => wx.downloadFile({ url, success: r, fail: j }));
      await saveToAlbum(dl.tempFilePath);
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (e) {
      albumFail(e);
    }
  },

  /** 生成收款台卡：登记码 + 微信收款码合成一张图，保存到相册 */
  async onMakeCard() {
    const { account, qrFileID, payCodeUrl } = this.data;
    if (!qrFileID) return wx.showToast({ title: '登记码未生成，无法制作台卡', icon: 'none' });
    if (!payCodeUrl) return wx.showToast({ title: '收款码加载失败，无法制作台卡', icon: 'none' });
    wx.showLoading({ title: '生成中' });
    try {
      const [qrPath, payPath] = await Promise.all([
        downloadCloud(qrFileID),
        downloadUrl(payCodeUrl)
      ]);
      const filePath = await this.drawCard(account, qrPath, payPath);
      await saveToAlbum(filePath);
      wx.hideLoading();
      wx.showModal({
        title: '礼簿台卡已保存到相册',
        content: '上码登记礼金，下码扫码转账',
        showCancel: false
      });
    } catch (e) {
      wx.hideLoading();
      albumFail(e);
    }
  },

  drawCard(account, qrPath, payPath) {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery().select('#card').fields({ node: true }).exec(async res => {
        try {
          const canvas = res[0].node;
          canvas.width = CARD_W;
          canvas.height = CARD_H;
          const ctx = canvas.getContext('2d');
          const primary = this.data.primary || theme.current().primary;
          const load = src => new Promise((ok, fail) => {
            const img = canvas.createImage();
            img.onload = () => ok(img);
            img.onerror = fail;
            img.src = src;
          });
          const [qrImg, payImg] = await Promise.all([load(qrPath), load(payPath)]);

          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, CARD_W, CARD_H);
          // 顶栏
          ctx.fillStyle = primary;
          ctx.fillRect(0, 0, CARD_W, 150);
          ctx.fillStyle = '#FFFFFF';
          ctx.textAlign = 'center';
          // 称呼较长时按宽度缩小字号，保证不超出顶栏
          let nameSize = 48;
          ctx.font = `bold ${nameSize}px sans-serif`;
          while (nameSize > 24 && ctx.measureText(account.accountName).width > CARD_W - 80) {
            nameSize -= 2;
            ctx.font = `bold ${nameSize}px sans-serif`;
          }
          ctx.fillText(account.accountName, CARD_W / 2, 92);

          const step = (y, no, text, img) => {
            ctx.fillStyle = primary;
            ctx.font = 'bold 36px sans-serif';
            ctx.fillText(`第${no}步  ${text}`, CARD_W / 2, y);
            ctx.drawImage(img, (CARD_W - 400) / 2, y + 24, 400, 400);
          };
          step(220, '一', '扫码登记姓名和礼金', qrImg);
          step(720, '二', '微信扫一扫转账随礼', payImg);

          ctx.fillStyle = '#999999';
          ctx.font = '26px sans-serif';
          ctx.fillText('转账后回到小程序点「我已完成转账」', CARD_W / 2, CARD_H - 66);
          ctx.fillStyle = '#BBBBBB';
          ctx.font = '20px sans-serif';
          ctx.fillText('慧礼记 · 扫码随礼 自动记账', CARD_W / 2, CARD_H - 28);

          wx.canvasToTempFilePath({
            canvas,
            fileType: 'png',
            success: r => resolve(r.tempFilePath),
            fail: reject
          });
        } catch (e) {
          reject(e);
        }
      });
    });
  },

  /** 转发给付款方，直达付款页 */
  onShareAppMessage() {
    const a = this.data.account;
    return {
      title: `向「${a ? a.accountName : ''}」${this._shareWord || '随礼'}`,
      path: a ? `/pages/pay/pay?aid=${this._shareId || a._id}` : '/pages/index/index'
    };
  }
});

function downloadCloud(fileID) {
  return new Promise((resolve, reject) => {
    wx.cloud.downloadFile({ fileID, success: r => resolve(r.tempFilePath), fail: reject });
  });
}

function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({ url, success: r => (r.statusCode === 200 ? resolve(r.tempFilePath) : reject(new Error('下载失败'))), fail: reject });
  });
}

function saveToAlbum(filePath) {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({ filePath, success: resolve, fail: reject });
  });
}

function albumFail(e) {
  if (/auth|deny/i.test((e && e.errMsg) || '')) {
    wx.showModal({
      title: '需要相册权限',
      content: '请允许保存到相册',
      confirmText: '去设置',
      success: res => res.confirm && wx.openSetting()
    });
  } else {
    wx.showToast({ title: '保存失败，请重试', icon: 'none' });
  }
}
