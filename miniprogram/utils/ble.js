// utils/ble.js — BLE 连接管理与分包写入（文档 §6.5）
const STORAGE_KEY = 'printerDevice';

// 常见蓝牙打印机名称前缀，用于发现过滤（可在扫描页选择"显示全部设备"绕过）
const PRINTER_PREFIX = ['Print', 'Xprinter', 'HM', 'MT', 'GB', 'HPRT', 'MTP', 'ZJ', 'TX', 'KM'];

const state = {
  deviceId: '',
  serviceId: '',
  charId: ''     // 可写特征值 UUID
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function openAdapter() {
  return new Promise((resolve, reject) => {
    wx.openBluetoothAdapter({
      success: resolve,
      fail: () => reject(new Error('请打开手机蓝牙后重试'))
    });
  });
}

function startDiscovery() {
  return new Promise((resolve, reject) => {
    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: false,
      success: resolve,
      fail: () => reject(new Error('搜索蓝牙设备失败'))
    });
  });
}

function stopDiscovery() {
  try { wx.stopBluetoothDevicesDiscovery({}); } catch (e) { /* 忽略 */ }
}

function onFound(cb) {
  wx.onBluetoothDeviceFound(res => cb(res.devices || []));
}

/** 当前已发现的设备列表 */
function getDevices() {
  return new Promise(resolve => {
    wx.getBluetoothDevices({
      success: res => resolve(res.devices || []),
      fail: () => resolve([])
    });
  });
}

function isPrinterLike(name) {
  return PRINTER_PREFIX.some(p => (name || '').toUpperCase().startsWith(p.toUpperCase()));
}

/** 连接设备并定位可写特征值；找不到 FF02 时遍历所有服务兜底 */
function connect(deviceId) {
  return new Promise((resolve, reject) => {
    wx.createBLEConnection({
      deviceId,
      timeout: 6000,
      success: () => {
        state.deviceId = deviceId;
        _watchState();
        _resolveWritable(deviceId).then(resolve).catch(e => {
          disconnect();
          reject(e);
        });
      },
      fail: () => reject(new Error('连接打印机失败，请重试'))
    });
  });
}

/** 打印机断电/走远时清空连接状态，下次打印自动重连 */
let _watching = false;
function _watchState() {
  if (_watching) return;
  _watching = true;
  wx.onBLEConnectionStateChange(res => {
    if (!res.connected && res.deviceId === state.deviceId) state.deviceId = '';
  });
}

function _resolveWritable(deviceId) {
  return new Promise((resolve, reject) => {
    wx.getBLEDeviceServices({
      deviceId,
      success: res => {
        const services = res.services || [];
        // 优先常见打印服务
        const preferred = services.find(s => s.uuid.toUpperCase().startsWith('0000FF00'));
        const ordered = preferred ? [preferred, ...services.filter(s => s !== preferred)] : services;

        const tryService = i => {
          if (i >= ordered.length) return reject(new Error('未找到可写特征值'));
          const sid = ordered[i].uuid;
          wx.getBLEDeviceCharacteristics({
            deviceId,
            serviceId: sid,
            success: res2 => {
              const ch = (res2.characteristics || []).find(c =>
                (c.properties.write || c.properties.writeNoResponse));
              if (ch) {
                state.serviceId = sid;
                state.charId = ch.uuid;
                resolve({ serviceId: sid, charId: ch.uuid });
              } else {
                tryService(i + 1);
              }
            },
            fail: () => tryService(i + 1)
          });
        };
        tryService(0);
      },
      fail: () => reject(new Error('获取服务失败'))
    });
  });
}

function disconnect() {
  if (state.deviceId) {
    try { wx.closeBLEConnection({ deviceId: state.deviceId }); } catch (e) { /* 忽略 */ }
    state.deviceId = '';
  }
}

/** 分包写入（BLE 单包 ≤20 字节），返回 Promise */
function writeBuffer(buffer) {
  const data = new Uint8Array(buffer);
  const CHUNK = 20;
  let p = Promise.resolve();
  for (let i = 0; i < data.length; i += CHUNK) {
    const slice = data.slice(i, i + CHUNK);
    p = p.then(() => new Promise((resolve, reject) => {
      wx.writeBLECharacteristicValue({
        deviceId: state.deviceId,
        serviceId: state.serviceId,
        characteristicId: state.charId,
        value: slice.buffer,
        success: () => setTimeout(resolve, 20), // 打印机写缓冲需要间隔
        fail: err => reject(err)
      });
    }));
  }
  return p;
}

// 记忆设备
function saveDevice(dev) { wx.setStorageSync(STORAGE_KEY, dev); }
function loadDevice() { try { return wx.getStorageSync(STORAGE_KEY) || null; } catch (e) { return null; } }

/** 用记忆设备自动重连（ printer.js 调用） */
async function reconnectSaved() {
  const dev = loadDevice();
  if (!dev) return null;
  try {
    const info = await connect(dev.deviceId);
    return info;
  } catch (e) {
    return null;
  }
}

module.exports = {
  PRINTER_PREFIX, state,
  openAdapter, startDiscovery, stopDiscovery, onFound, getDevices, isPrinterLike,
  connect, disconnect, writeBuffer,
  saveDevice, loadDevice, reconnectSaved, sleep
};
