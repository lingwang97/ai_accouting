// pages/qrcode/qrcode.js — 我的收款码（UC3）
// 两种收款模式（「我的 → 收款模式」切换）：
//   longpress：原模式，展示登记码，付款方在自己手机上长按收款码转账
//   screen：店主亮屏双码，上方登记码（小程序码）+ 下方微信收款码，屏幕常亮、亮度最高
// 两种模式都可生成「收款台卡」（双码合成图，保存相册后打印贴摊位）
const req = require('../../utils/request.js');

const CARD_W = 750;
const CARD_H = 1240;

Page({
  data: {
    account: null,
    mode: 'longpress',
    qrUrl: '',       // 登记码（小程序码）
    qrFileID: '',
    payCodeUrl: '',  // 个人收款码
    loading: true,
    errMsg: ''
  },

  onLoad() {
    this.load();
  },

  onShow() {
    if (this.data.mode === 'screen') this.lightOn();
  },

  onHide() { this.lightOff(); },
  onUnload() { this.lightOff(); },

  async load() {
    this.setData({ loading: true });
    try {
      const { account } = await req.accountGet();
      if (!account) {
        wx.showToast({ title: '请先完善主家信息', icon: 'none' });
        setTimeout(() => wx.redirectTo({ url: '/pages/account/account' }), 800);
        return;
      }
      const mode = account.payMode === 'screen' ? 'screen' : 'longpress';
      this.setData({ account, mode });
      wx.setNavigationBarTitle({ title: mode === 'screen' ? '随礼展示' : '礼簿码' });
      if (mode === 'screen') this.lightOn();

      const payCodeUrl = await this.getTempUrl(account.payCodeFileID);
      this.setData({ payCodeUrl });

      try {
        const qrFileID = await this.getQrFileID(account._id);
        const qrUrl = await this.getTempUrl(qrFileID);
        this.setData({ qrFileID, qrUrl, errMsg: '' });
      } catch (e) {
        this.setData({ qrUrl: '', errMsg: '登记码生成失败：' + ((e && e.message) || '请稍后重试') });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 登记码按账户 + 小程序版本缓存，避免每次进入都重新生成上传 */
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

  /** 点击放大 */
  onPreview(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.previewImage({ urls: [url] });
  },

  /** 保存单张登记码（原模式） */
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
    const { account, qrFileID } = this.data;
    if (!qrFileID) return wx.showToast({ title: '登记码未生成，无法制作台卡', icon: 'none' });
    wx.showLoading({ title: '生成中' });
    try {
      const [qrPath, payPath] = await Promise.all([
        downloadCloud(qrFileID),
        downloadCloud(account.payCodeFileID)
      ]);
      const filePath = await this.drawCard(account, qrPath, payPath);
      await saveToAlbum(filePath);
      wx.hideLoading();
      wx.showModal({
        title: '礼簿台卡已保存到相册',
        content: '可打印后摆在礼台。宾客：先扫上方礼簿码登记姓名礼金，再用微信扫一扫扫下方收款码转账。',
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
          const primary = (account.theme && account.theme.primary) || '#07C160';
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
          ctx.fillText('转账后回到小程序点「我已完成转账」', CARD_W / 2, CARD_H - 50);

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
      path: a ? `/pages/pay/pay?aid=${a._id}` : '/pages/index/index'
    };
  }
});

function downloadCloud(fileID) {
  return new Promise((resolve, reject) => {
    wx.cloud.downloadFile({ fileID, success: r => resolve(r.tempFilePath), fail: reject });
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
