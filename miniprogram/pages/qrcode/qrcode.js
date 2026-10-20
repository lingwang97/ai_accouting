// pages/qrcode/qrcode.js — 我的收款码（UC3）
// 两种收礼方式（本页顶部切换）：
//   longpress：原模式，展示登记码，付款方在自己手机上长按收款码转账
//   screen：店主亮屏双码，上方登记码（小程序码）+ 下方微信收款码，屏幕常亮、亮度最高
// 两种模式都可生成「收款台卡」（双码合成图，保存相册后打印贴摊位）
const req = require('../../utils/request.js');
const theme = require('../../utils/theme.js');
const perm = require('../../utils/perm.js');

const CARD_W = 750;
const CARD_H = 1240;

Page({
  data: {
    account: null,
    qrUrl: '',       // 登记码（小程序码）
    qrFileID: '',
    payCodeUrl: '',  // 个人收款码
    loading: true,
    errMsg: ''
  },

  async onLoad(options) {
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
    if (this.data.account) this.lightOn();
  },

  onHide() { this.lightOff(); },
  onUnload() { this.lightOff(); },

  async load() {
    this.setData({ loading: true });
    try {
      const { account } = await req.accountGet(true);
      if (!account) {
        wx.showToast({ title: '请先完善主家信息', icon: 'none' });
        setTimeout(() => wx.redirectTo({ url: '/pages/account/account' }), 800);
        return;
      }
      this.setData({ account, primary: theme.current().primary });
      this.lightOn();

      // 本场礼簿码；记账人一律由服务端决定（正在记的是主家当前礼簿时为主家礼簿码，否则为本场码），不用本地缓存
      if (this._bookId || getApp().globalData.role === 'clerk') return await this.loadBookQr(account);

      // 记账人读不到主家上传的收款码图片，优先用云函数生成的链接
      const payCodeUrl = account.payCodeUrl || await this.getTempUrl(account.payCodeFileID);
      this.setData({ payCodeUrl });

      try {
        const qrFileID = await this.getQrFileID(account._id);
        const qrUrl = await this.getTempUrl(qrFileID);
        this.setData({ qrFileID, qrUrl, errMsg: '' });
      } catch (e) {
        this.setData({ qrUrl: '', errMsg: '登记码生成失败：' + ((e && e.message) || '请稍后重试') });
      }
    } catch (e) {
      // 读取主家信息失败（网络异常等）：显示错误，点击重试
      this.setData({ errMsg: '加载失败：' + ((e && e.message) || '网络异常') });
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
      const qrUrl = await this.getTempUrl(r.fileID);
      if (!r.book) {
        // 主家礼簿码（记账人正在记的就是主家当前礼簿）
        const payCodeUrl = account.payCodeUrl || await this.getTempUrl(account.payCodeFileID);
        this.setData({ qrFileID: r.fileID, qrUrl, payCodeUrl, errMsg: '' });
        return;
      }
      // 标题显示主家（机构版为本场主家），下方显示礼簿名称，避免礼簿名显示两次
      const name = (r.book && r.book.hostName) || account.accountName;
      this.setData({
        primary: theme.forType(r.book && r.book.type).primary, // 本场是白事时素灰
        account: { ...account, accountName: name },
        bookName: r.book ? r.book.name : '',
        qrFileID: r.fileID, qrUrl, payCodeUrl: r.payCodeUrl || account.payCodeUrl || '', errMsg: ''
      });
      wx.setNavigationBarTitle({ title: '本场礼簿码' });
      this._shareId = r.book._id;
    } catch (e) {
      this.setData({ qrUrl: '', errMsg: '本场礼簿码生成失败：' + ((e && e.message) || '请稍后重试') });
    }
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
      success: res => { this._brightness = res.value; },
      complete: () => wx.setScreenBrightness({ value: 1, fail() {} })
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
          ctx.font = 'bold 48px sans-serif';
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
      title: `向「${a ? a.accountName : ''}」随礼`,
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
