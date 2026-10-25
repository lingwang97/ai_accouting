// utils/ble.js — BLE 连接管理与分包写入（文档 §6.5）
const device = require('./device.js');
const STORAGE_KEY = 'printerDevice';

// 常见蓝牙打印机名称前缀，用于发现过滤（可在扫描页选择"显示全部设备"绕过）
const PRINTER_PREFIX = ['Print', 'Xprinter', 'HM', 'MT', 'GB', 'HPRT', 'MTP', 'ZJ', 'TX', 'KM'];

const state = {
  deviceId: '',
  serviceId: '',
  charId: '',    // 可写特征值 UUID
  chunk: 20      // 单包字节数：默认 20；安卓协商 MTU 成功后为 MTU-3（v3.58.0）
};

const MTU_REQUEST = 185; // 请求的 MTU；打印机实际支持的由 setBLEMTU 的返回值决定


const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 蓝牙错误码 → 提示（码以微信官方文档 wx.openBluetoothAdapter 等为准；不确定的统一兜底） */
function errMsg(err, fallback) {
  const code = err && err.errCode;
  switch (code) {
    case 10001: return device.notPhone() ? '当前设备不支持蓝牙打印，请在手机上操作' : '请打开手机蓝牙后重试';
    case 10002: return '没有找到打印机，请确认已开机并靠近手机';
    case 10003: return '连接打印机失败，请重试';
    case 10006: return '打印机连接已断开';
    case 10009: return '手机系统版本或权限不支持蓝牙，请检查系统蓝牙与定位权限';
    case 10012: return '连接打印机超时，请靠近打印机后重试';
    default:
      if (code) return `蓝牙异常（错误码 ${code}）`;
      return fallback || '蓝牙异常';
  }
}

function openAdapter() {
  return new Promise((resolve, reject) => {
    wx.openBluetoothAdapter({
      success: resolve,
      // 电脑 / iPad 上不支持蓝牙打印，提示换手机操作
      fail: err => reject(new Error(errMsg(err, device.notPhone() ? '当前设备不支持蓝牙打印，请在手机上操作' : '请打开手机蓝牙后重试')))
    });
  });
}

function startDiscovery() {
  return new Promise((resolve, reject) => {
    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: false,
      success: resolve,
      fail: err => reject(new Error(errMsg(err, '搜索蓝牙设备失败')))
    });
  });
}

function stopDiscovery() {
  try { wx.stopBluetoothDevicesDiscovery({}); } catch (e) { /* 忽略 */ }
}

function onFound(cb) {
  offFound(); // 每次扫描都会注册，先移除旧的监听
  wx.onBluetoothDeviceFound(res => cb((res.devices || []).map(slim)));
}

/** 只留页面与连接用到的字段，去掉 advertisData 等 ArrayBuffer，减少 setData 传输 */
function slim(d) {
  return { name: d.name, deviceId: d.deviceId, RSSI: d.RSSI };
}

function offFound() {
  try { wx.offBluetoothDeviceFound(); } catch (e) { /* 低版本无此接口 */ }
}

/** 当前已发现的设备列表 */
function getDevices() {
  return new Promise(resolve => {
    wx.getBluetoothDevices({
      success: res => resolve((res.devices || []).map(slim)),
      fail: () => resolve([])
    });
  });
}

function isPrinterLike(name) {
  return PRINTER_PREFIX.some(p => (name || '').toUpperCase().startsWith(p.toUpperCase()));
}

/** 连接设备并定位可写特征值；找不到 FF02 时遍历所有服务兜底 */
async function connect(deviceId) {
  await _closeOld();
  return new Promise((resolve, reject) => {
    wx.createBLEConnection({
      deviceId,
      timeout: 6000,
      success: () => {
        state.deviceId = deviceId;
        state.chunk = 20; // 每次连接先回到 20，再按协商结果提升
        _watchState();
        _resolveWritable(deviceId).then(info => _negotiateMtu(deviceId).then(() => resolve(info))).catch(e => {
          disconnect();
          reject(e);
        });
      },
      fail: err => reject(new Error(errMsg(err, '连接打印机失败，请重试')))
    });
  });
}

/** 连接新设备前先断开旧连接（等待回调，失败也不阻塞） */
function _closeOld() {
  if (!state.deviceId) return Promise.resolve();
  const id = state.deviceId;
  state.deviceId = '';
  return new Promise(resolve => {
    try {
      wx.closeBLEConnection({ deviceId: id, complete: () => resolve() });
    } catch (e) { resolve(); }
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

/**
 * 安卓：请求更大的 MTU，成功后单包按 MTU-3 发送（二维码光栅约 10KB，20 字节一包要多等十几秒）；失败或超时保持 20。
 * iOS 不调用（系统自动协商，且 setBLEMTU 在 iOS 上无效）。任何情况都不抛错，不影响连接。
 */
function _negotiateMtu(deviceId) {
  if (!device.isAndroid() || typeof wx.setBLEMTU !== 'function') return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    setTimeout(finish, 3000); // 个别机型不回调
    try {
      wx.setBLEMTU({
        deviceId,
        mtu: MTU_REQUEST,
        success: res => {
          const mtu = Number(res && res.mtu) || MTU_REQUEST;
          if (!done && mtu > 23) state.chunk = Math.min(mtu, 512) - 3;
          finish();
        },
        fail: finish
      });
    } catch (e) { finish(); }
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
      fail: err => reject(new Error(errMsg(err, '获取服务失败')))
    });
  });
}

function disconnect() {
  if (state.deviceId) {
    try { wx.closeBLEConnection({ deviceId: state.deviceId }); } catch (e) { /* 忽略 */ }
    state.deviceId = '';
  }
}

/**
 * 分包写入（单包默认 20 字节，安卓协商 MTU 成功后为 MTU-3），返回 Promise
 * 失败时 reject 的 Error 带 written（已成功写入的字节数）与 errCode，供上层判断是否可整单重试
 */
function writeBuffer(buffer, chunkSize) {
  const data = new Uint8Array(buffer);
  const CHUNK = chunkSize || state.chunk || 20;
  let written = 0;
  let p = Promise.resolve();
  for (let i = 0; i < data.length; i += CHUNK) {
    const slice = data.slice(i, i + CHUNK);
    p = p.then(() => new Promise((resolve, reject) => {
      wx.writeBLECharacteristicValue({
        deviceId: state.deviceId,
        serviceId: state.serviceId,
        characteristicId: state.charId,
        value: slice.buffer,
        success: () => { written += slice.length; setTimeout(resolve, 20); }, // 打印机写缓冲需要间隔
        fail: err => {
          const e = new Error(errMsg(err, '写入打印机失败'));
          e.errCode = err && err.errCode;
          e.written = written;
          reject(e);
        }
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
  openAdapter, startDiscovery, stopDiscovery, onFound, offFound, getDevices, isPrinterLike,
  connect, disconnect, writeBuffer, errMsg,
  saveDevice, loadDevice, reconnectSaved, sleep
};
