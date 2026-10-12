// pages/printer/printer.js — 蓝牙打印机管理（UC6）
const ble = require('../../utils/ble.js');
const printer = require('../../utils/printer.js');

Page({
  data: {
    devices: [],
    discovering: false,
    showAll: false,
    savedDevice: null,
    connected: false,
    testing: false
  },

  onShow() {
    this.setData({ savedDevice: ble.loadDevice(), connected: printer.isConnected() });
  },

  onHide() {
    ble.stopDiscovery();
    this.setData({ discovering: false });
  },

  onUnload() {
    ble.stopDiscovery();
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
      wx.showToast({ title: e.message || '蓝牙不可用', icon: 'none' });
      this.setData({ discovering: false });
    }
  },

  onStopScan() {
    ble.stopDiscovery();
    this.setData({ discovering: false });
  },

  async onConnect(e) {
    const dev = this.data.devices.find(d => d.deviceId === e.currentTarget.dataset.id);
    if (!dev) return;
    wx.showLoading({ title: '连接中' });
    try {
      ble.stopDiscovery();
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
