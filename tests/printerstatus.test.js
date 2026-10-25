// v3.59.2：工作台「打印机」三态（已连接 / 已配对·未连接 / 未配对）与 BLE 连接状态订阅
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const ble = require('../miniprogram/utils/ble.js');

// ble.js 只向系统注册一次断开监听（模块级标记），所以处理函数在整个文件里共用一份
const sys = { cbs: [] };
function fakeWx() {
  global.wx = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    onBLEConnectionStateChange: cb => { sys.cbs.push(cb); },
    closeBLEConnection: o => o && o.complete && o.complete(),
    createBLEConnection: o => o.success(),
    getBLEDeviceServices: o => o.success({ services: [{ uuid: '0000FF00-0000-1000-8000-00805F9B34FB' }] }),
    getBLEDeviceCharacteristics: o => o.success({ characteristics: [{ uuid: 'FF02', properties: { write: true } }] }),
    setBLEMTU: o => o.fail({ errCode: 10007 })
  };
}
const connectOk = id => ble.connect(id);
const fire = res => sys.cbs.forEach(f => f(res));

test('printerStatus 三种状态', () => {
  assert.strictEqual(ble.printerStatus({ name: 'P1', deviceId: 'd' }, true), 'connected');
  assert.strictEqual(ble.printerStatus(null, true), 'connected');
  assert.strictEqual(ble.printerStatus({ name: 'P1', deviceId: 'd' }, false), 'paired');
  assert.strictEqual(ble.printerStatus({ name: 'P1' }, false), 'paired');
  assert.strictEqual(ble.printerStatus('', false), 'none');
  assert.strictEqual(ble.printerStatus(null, false), 'none');
  assert.strictEqual(ble.printerStatus({}, false), 'none');
});

test('订阅：未连接过也会注册系统监听；连上、断开都通知；退订后不再通知', async () => {
  fakeWx();
  ble.state.deviceId = '';
  const got = [];
  const cb = v => got.push(v);
  ble.onStateChange(cb);
  ble.onStateChange(cb); // 重复订阅只算一次
  assert.ok(sys.cbs.length >= 1); // 订阅时已确保注册
  await connectOk('devA');
  assert.deepStrictEqual(got, [true]);
  // 系统断开事件
  fire({ deviceId: 'other', connected: false }); // 别的设备：忽略
  assert.deepStrictEqual(got, [true]);
  fire({ deviceId: 'devA', connected: false });
  assert.deepStrictEqual(got, [true, false]);
  assert.strictEqual(ble.state.deviceId, '');
  // 主动断开：已是未连接，不重复通知
  ble.disconnect();
  assert.deepStrictEqual(got, [true, false]);
  // 退订
  ble.offStateChange(cb);
  await connectOk('devB');
  assert.deepStrictEqual(got, [true, false]);
  ble.disconnect();
  delete global.wx;
});

test('订阅回调抛错不影响其他订阅者', () => {
  fakeWx();
  ble.state.deviceId = '';
  const got = [];
  const bad = () => { throw new Error('x'); };
  const ok = v => got.push(v);
  ble.onStateChange(bad); ble.onStateChange(ok);
  ble.disconnect();
  ble.state.deviceId = 'z'; // 直接置位后主动断开
  ble.disconnect();
  assert.deepStrictEqual(got, [false]);
  ble.offStateChange(bad); ble.offStateChange(ok);
  delete global.wx;
});
