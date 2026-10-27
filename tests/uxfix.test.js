// v3.65.2 体验修复：自动打印暂停 10 分钟、网络错误识别、订阅失败中文说明
const assert = require('assert');
const { test } = require('./helpers/harness.js');

const ble = require('../miniprogram/utils/ble.js');
const printer = require('../miniprogram/utils/printer.js');
const request = require('../miniprogram/utils/request.js');

function fakeWx(opts) {
  const o = opts || {};
  const n = { connect: 0 };
  global.wx = {
    getStorageSync: k => (k === 'printerDevice' ? (o.saved || '') : ''),
    setStorageSync: () => {},
    onBLEConnectionStateChange: () => {},
    closeBLEConnection: x => x && x.complete && x.complete(),
    openBluetoothAdapter: x => x.success(),
    createBLEConnection: x => { n.connect++; return o.connectOk ? x.success() : x.fail({ errMsg: 'createBLEConnection:fail timeout' }); },
    getBLEDeviceServices: x => x.success({ services: [{ uuid: '0000FF00-0000-1000-8000-00805F9B34FB' }] }),
    getBLEDeviceCharacteristics: x => x.success({ characteristics: [{ uuid: 'FF02', properties: { write: true } }] }),
    setBLEMTU: x => x.fail({ errCode: 10007 }),
    getSystemInfoSync: () => ({ platform: 'android' })
  };
  return n;
}

test('自动打印：没配过打印机 → none，不尝试连接', async () => {
  const n = fakeWx({ saved: '' });
  ble.state.deviceId = '';
  printer.resumeAuto();
  assert.strictEqual(await printer.autoConnect(), 'none');
  assert.strictEqual(n.connect, 0);
  delete global.wx;
});

test('自动打印：重连失败 → failed 一次，之后 10 分钟内 paused 且不再重连；到期再试；手动连上立即恢复', async () => {
  const n = fakeWx({ saved: { deviceId: 'd1', name: 'P1' }, connectOk: false });
  ble.state.deviceId = '';
  printer.resumeAuto();
  assert.strictEqual(await printer.autoConnect(), 'failed');
  assert.strictEqual(n.connect, 1);
  assert.strictEqual(await printer.autoConnect(), 'paused');
  assert.strictEqual(await printer.autoConnect(Date.now() + 9 * 60 * 1000), 'paused');
  assert.strictEqual(n.connect, 1); // 暂停期内不再重连（每次重连要等约 6 秒）
  assert.strictEqual(await printer.autoConnect(Date.now() + printer.AUTO_PAUSE_MS + 1000), 'failed'); // 到期再试一次
  assert.strictEqual(n.connect, 2);
  // 手动连上（例如礼台页点「连接」）：暂停立即结束
  global.wx.createBLEConnection = x => { n.connect++; x.success(); };
  await ble.connect('d1');
  assert.strictEqual(await printer.autoConnect(), 'ok');
  ble.disconnect();
  printer.resumeAuto();
  delete global.wx;
});

test('网络错误识别：wx 调用失败算网络，服务端业务错误不算', () => {
  assert.strictEqual(request.isNetErr({ errMsg: 'cloud.callFunction:fail timeout', net: true }), true);
  assert.strictEqual(request.isNetErr({ errMsg: 'cloud.callFunction:fail' }), true);
  const biz = new Error('无权查看'); biz.biz = true;
  assert.strictEqual(request.isNetErr(biz), false);
  assert.strictEqual(request.isNetErr(null), false);
});

test('订阅失败：给中文说明，不显示微信英文错误', () => {
  global.wx = { getSetting: () => {}, getStorageSync: () => '' };
  const notify = require('../miniprogram/utils/notify.js');
  const t1 = notify.subscribeFailText({ errCode: 20004, errMsg: 'requestSubscribeMessage:fail:main switch is off' });
  assert.ok(/通知管理/.test(t1) && !/fail/.test(t1));
  const t2 = notify.subscribeFailText({ errMsg: 'requestSubscribeMessage:fail unknown' });
  assert.ok(!/fail/.test(t2));
  delete global.wx;
});
