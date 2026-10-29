// pages/printer/printer.js — 蓝牙打印机管理（UC6）
const ble = require('../../utils/ble.js');
const printer = require('../../utils/printer.js');
const theme = require('../../utils/theme.js');

Page({
  data: {
    devices: [],
    discovering: false,
    showAll: false,
    savedDevice: null,
    connected: false,
    testing: false,
    slow: false // 稳定模式（本机）：打印机乱码 / 缺行时打开
  },

  onLoad() { theme.early(this); }, // 首帧前同步套主题色（v3.70.1）

  onShow() {
    const t = theme.apply(this); // 主题色跟当前礼簿事由走
    this.setData({ primary: t.primary, savedDevice: ble.loadDevice(), connected: printer.isConnected(), slow: ble.isSlow() });
  },

  /** 稳定模式：每包 20 字节、按原速度发送；切换后断开，下次打印重新连接按新设置协商 */
  onSlow(e) {
    const on = !!e.detail.value;
    ble.setSlow(on);
    if (printer.isConnected()) ble.disconnect();
    this.setData({ slow: on, connected: false });
  },

  onHide() {
    this._stopScan();
  },

  onUnload() {
    this._stopScan();
  },

  /** 停止扫描并清定时器 */
  _stopScan() {
    clearTimeout(this._scanTimer);
    ble.stopDiscovery();
    ble.offFound();
    if (this.data.discovering) this.setData({ discovering: false });
  },

  toggleShowAll() {
    this.setData({ showAll: !this.data.showAll });
  },

  /** 开始扫描 BLE 设备（文档 §6.5） */
  async onScan() {
    try {
      await ble.openAdapter();
      this.setData({ devices: [], discovering: true });
      await ble.startDiscovery();
      // 搜索 30 秒后自动停止，避免长时间扫描耗电
      clearTimeout(this._scanTimer);
      this._scanTimer = setTimeout(() => {
        ble.stopDiscovery();
        this.setData({ discovering: false });
      }, 30000);

      ble.onFound(devs => {
        const list = this.data.devices.slice();
        for (const d of devs) {
          if (!d.name) continue;
          if (!this.data.showAll && !ble.isPrinterLike(d.name)) continue;
          const i = list.findIndex(x => x.deviceId === d.deviceId);
          if (i >= 0) list[i] = d;
          else list.push(d);
        }
        this.setData({ devices: list });
      });
      // 补拉一次当前已发现列表
      const existing = await ble.getDevices();
      existing.filter(d => d.name && (this.data.showAll || ble.isPrinterLike(d.name)))
        .forEach(d => {
          const list = this.data.devices;
          if (!list.find(x => x.deviceId === d.deviceId)) list.push(d);
        });
      this.setData({ devices: this.data.devices });
    } catch (e) {
      clearTimeout(this._scanTimer);
      wx.showToast({ title: e.message || '蓝牙不可用', icon: 'none' });
      this.setData({ discovering: false });
    }
  },

  onStopScan() {
    clearTimeout(this._scanTimer);
    ble.stopDiscovery();
    this.setData({ discovering: false });
  },

  async onConnect(e) {
    const dev = this.data.devices.find(d => d.deviceId === e.currentTarget.dataset.id);
    if (!dev) return;
    wx.showLoading({ title: '连接中' });
    try {
      clearTimeout(this._scanTimer);
      ble.stopDiscovery();
      this.setData({ discovering: false });
      await ble.connect(dev.deviceId);
      ble.saveDevice({ deviceId: dev.deviceId, name: dev.name });
      wx.hideLoading();
      wx.showToast({ title: '已连接', icon: 'success' });
      this.setData({ connected: true, savedDevice: { deviceId: dev.deviceId, name: dev.name } });
    } catch (err) {
      wx.hideLoading();
      wx.showModal({ title: '连接失败', content: err.message, showCancel: false });
    }
  },

  onDisconnect() {
    ble.disconnect();
    this.setData({ connected: false });
  },

  async onTest() {
    if (this.data.testing) return;
    this.setData({ testing: true });
    wx.showLoading({ title: '打印中' });
    try {
      await printer.printTest();
      wx.hideLoading();
      wx.showToast({ title: '测试页已打印', icon: 'success' });
    } catch (e) {
      wx.hideLoading();
      wx.showModal({ title: '打印失败', content: e.message || '未知错误', showCancel: false });
    } finally {
      this.setData({ testing: false });
    }
  }
});
