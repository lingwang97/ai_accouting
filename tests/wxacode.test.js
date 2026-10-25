// v3.58.0：小票小程序码（wxacode.getUnlimited）→ 云端光栅 → 缓存；备用通道 system._wxaCode；scene 约定；BLE MTU 分包
const assert = require('assert');
const EventEmitter = require('events');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { sdk, db, state, loadFunction } = require('./helpers/sdk-stub.js');

// pngjs / jpeg-js 只在 payment 云函数目录里安装；没装时相关用例跳过
const PAY_DIR = path.join(__dirname, '../cloudfunctions/payment');
let deps = null;
try { deps = { PNG: require(require.resolve('pngjs', { paths: [PAY_DIR] })).PNG, jpeg: require(require.resolve('jpeg-js', { paths: [PAY_DIR] })) }; } catch (e) { deps = null; }
const t = (name, fn) => test(name, async () => (deps ? fn() : 'SKIP 未安装 pngjs / jpeg-js'));

const OWNER = 'o-owner', CLERK = 'u-clerk';
const TOKEN = 'AbCdEfGhIj12';
const NONCE = 'urlnonce_' + 'a'.repeat(24);
const origCallFn = sdk.callFunction;

/** 造一张像小程序码的 280×280 图：白底、黑色圆环 + 放射状扇形 */
function codeImage(kind, size = 280, blank = false) {
  const data = Buffer.alloc(size * size * 4, 255);
  const c = size / 2;
  if (!blank) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - c, dy = y - c, r = Math.sqrt(dx * dx + dy * dy);
        const ang = Math.atan2(dy, dx);
        const dark = (r > size * 0.40 && r < size * 0.46) || (r > size * 0.12 && r < size * 0.36 && Math.floor((ang + Math.PI) / (Math.PI / 12)) % 2 === 0);
        if (dark) { const i = (y * size + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
      }
    }
  }
  if (kind === 'jpeg') return Buffer.from(deps.jpeg.encode({ data, width: size, height: size }, 90).data);
  const png = new deps.PNG({ width: size, height: size });
  data.copy(png.data);
  return deps.PNG.sync.write(png);
}

function seedPay(extra = {}) {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '李府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }, { openid: CLERK, currentAid: 'acc1' }])
    .seed('members', [{ _id: 'm1', aid: 'acc1', memberOpenid: CLERK, role: 'clerk', bookIds: ['b1'], perms: ['confirm', 'desk', 'members'] }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, type: 'wedding' }])
    .seed('records', [{ _id: 'r1', aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', status: 'paid', payerName: '张三', amount: 100, payerOpenid: '', paidAt: new Date(), createdAt: new Date(), ...extra }]);
  db.applyUpdates = true;
  state.uploads.length = 0;
  state.download = async fileID => { const u = state.uploads.find(x => 'cloud://test/' + x.cloudPath === fileID); if (!u) throw new Error('not found'); return u.content; };
  sdk.callFunction = origCallFn;
}
const pay = (openid, event) => { state.openid = openid; return loadFunction('payment').main(event); };
const rec = () => db.data.records.find(r => r._id === 'r1');
const okApi = (img, seen) => ({ getUnlimited: async o => { if (seen) seen.push(o); return { buffer: img, contentType: 'image/jpeg' }; } });
const head = b64 => { const b = Buffer.from(b64, 'base64'); return { b, wBytes: b[4] + b[5] * 256, h: b[6] + b[7] * 256 }; };

t('issueQr：首次生成 12 位 token，调用参数符合约定（scene、page、280、纯黑白、不校验路径、env），返回 GS v 0 光栅且不含 token', async () => {
  seedPay();
  const seen = [];
  sdk.openapi.wxacode = okApi(codeImage('jpeg'), seen);
  const r = await pay(OWNER, { action: 'issueQr', rid: 'r1', envVersion: 'trial' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(/^[0-9A-Za-z]{12}$/.test(rec().rcptToken));
  assert.deepStrictEqual(Object.keys(r.data), ['raster']);
  const o = seen[0];
  assert.strictEqual(o.scene, 't=' + rec().rcptToken);
  assert.ok(o.scene.length <= 32 && /^[A-Za-z0-9=_.-]+$/.test(o.scene));
  assert.strictEqual(o.page, 'pages/receipt/receipt');
  assert.strictEqual(o.width, 280);
  assert.strictEqual(o.checkPath, false);
  assert.strictEqual(o.autoColor, false);
  assert.deepStrictEqual(o.lineColor, { r: 0, g: 0, b: 0 });
  assert.strictEqual(o.isHyaline, false);
  assert.strictEqual(o.envVersion, 'trial');
  const { b, wBytes, h } = head(r.data.raster);
  assert.deepStrictEqual([...b.slice(0, 4)], [0x1d, 0x76, 0x30, 0x00]);
  assert.strictEqual(wBytes, 35); // 280 点 = 35 字节
  assert.strictEqual(h, 280);
  assert.strictEqual(b.length, 8 + 35 * 280); // 9808 字节
  assert.ok(!JSON.stringify(r).includes(rec().rcptToken));
});

t('光栅转换：PNG 与 JPEG 都能解；尺寸可缩放；全白 / 非图片报 decode 错误', async () => {
  const { toRaster } = require('../cloudfunctions/payment/wxaraster.js');
  for (const kind of ['png', 'jpeg']) {
    const r = toRaster(codeImage(kind), 280);
    assert.strictEqual(r.bytes.length, 8 + 35 * 280);
    assert.ok(r.dark > 0.1 && r.dark < 0.6, kind + ' 黑点比例 ' + r.dark);
  }
  const small = toRaster(codeImage('png', 430), 240); // 缩放
  assert.strictEqual(small.width, 240);
  assert.strictEqual(small.h, 240);
  assert.strictEqual(small.bytes.length, 8 + 30 * 240);
  assert.throws(() => toRaster(codeImage('png', 280, true), 280), /decode:blank/);
  assert.throws(() => toRaster(Buffer.from('not an image at all'), 280), /decode:format/);
});

t('光栅内容：圆环位置为黑点、圆心外角落为白（二值化方向正确）', async () => {
  const { toRaster } = require('../cloudfunctions/payment/wxaraster.js');
  const r = toRaster(codeImage('png'), 280);
  const bit = (x, y) => (r.bytes[8 + y * r.wBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
  assert.strictEqual(bit(140 + 120, 140), 1); // 外环 r≈120（0.43*280）
  assert.strictEqual(bit(2, 2), 0);
});

t('缓存：首次生成后写云存储并记录 rcptQrKey / FileID；补打命中缓存不再调用接口；缓存丢失重新生成；不进列表接口', async () => {
  seedPay();
  let n = 0;
  sdk.openapi.wxacode = { getUnlimited: async () => { n++; return { buffer: codeImage('png') }; } };
  const r1 = await pay(OWNER, { action: 'issueQr', rid: 'r1' });
  assert.strictEqual(n, 1);
  assert.strictEqual(state.uploads.length, 1);
  assert.ok(/^rcptqr\/r1-/.test(state.uploads[0].cloudPath));
  assert.ok(rec().rcptQrFileID && /^[0-9A-Za-z]{12}:w280v1:release$/.test(rec().rcptQrKey));
  const r2 = await pay(OWNER, { action: 'issueQr', rid: 'r1' });
  assert.strictEqual(n, 1); // 命中缓存
  assert.strictEqual(r2.data.raster, r1.data.raster);
  state.uploads.length = 0; // 文件丢失
  const r3 = await pay(OWNER, { action: 'issueQr', rid: 'r1' });
  assert.strictEqual(n, 2);
  assert.strictEqual(r3.data.raster, r1.data.raster);
  // 列表 / 回执接口不返回缓存字段
  state.openid = OWNER;
  const list = await loadFunction('records').main({ action: 'list' });
  assert.ok(!JSON.stringify(list).includes('rcptQr'));
});

t('resetToken：换新 token、清缓存字段，旧缓存不再命中，扫旧码提示失效', async () => {
  seedPay();
  sdk.openapi.wxacode = okApi(codeImage('png'));
  await pay(OWNER, { action: 'issueQr', rid: 'r1' });
  const old = rec().rcptToken;
  assert.ok(rec().rcptQrFileID);
  assert.strictEqual((await pay(OWNER, { action: 'resetToken', rid: 'r1' })).code, 0);
  assert.notStrictEqual(rec().rcptToken, old);
  assert.strictEqual(rec().rcptQrFileID, '');
  assert.strictEqual(rec().rcptQrKey, '');
  assert.notStrictEqual((await pay('guest', { action: 'receiptByToken', token: old })).code, 0);
  assert.strictEqual((await pay('guest', { action: 'receiptByToken', token: rec().rcptToken })).code, 0);
});

t('回退通道：openapi 失败 → system._wxaCode（一次性凭据）；openapi 成功不调 system', async () => {
  seedPay({ rcptToken: TOKEN });
  const calls = [];
  const img = codeImage('jpeg');
  sdk.callFunction = async o => { calls.push(o); return { result: { code: 0, data: { image: img.toString('base64') } } }; };
  sdk.openapi.wxacode = { getUnlimited: async () => { const e = new Error('no permission'); e.errCode = -604101; throw e; } };
  const r = await pay(OWNER, { action: 'issueQr', rid: 'r1', envVersion: 'develop' });
  assert.strictEqual(r.code, 0);
  assert.ok(r.data.raster);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, 'system');
  assert.strictEqual(calls[0].data.action, '_wxaCode');
  assert.strictEqual(calls[0].data.scene, 't=' + TOKEN);
  assert.strictEqual(calls[0].data.page, 'pages/receipt/receipt');
  assert.strictEqual(calls[0].data.envVersion, 'develop');
  assert.ok(/^urlnonce_[0-9a-f]{24}$/.test(calls[0].data.nonce));
  seedPay({ rcptToken: TOKEN });
  calls.length = 0;
  sdk.openapi.wxacode = okApi(img);
  assert.ok((await pay(OWNER, { action: 'issueQr', rid: 'r1' })).data.raster);
  assert.strictEqual(calls.length, 0);
});

t('issueQr：两条路都失败 → raster 为空并带 reason（只含错误码，无 token / 密钥），仍返回成功；码图坏了报 decode', async () => {
  seedPay({ rcptToken: TOKEN });
  sdk.callFunction = async () => ({ result: { code: 0, data: { image: '', reason: 'secret-missing' } } });
  sdk.openapi.wxacode = { getUnlimited: async () => { const e = new Error('x'); e.errCode = -604101; throw e; } };
  const r = await pay(OWNER, { action: 'issueQr', rid: 'r1' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.raster, '');
  assert.strictEqual(r.data.reason, 'openapi:-604101,system:secret-missing');
  assert.ok(!JSON.stringify(r).includes(TOKEN));
  sdk.callFunction = async () => { throw new Error('boom'); };
  assert.ok(/^openapi:-604101,call:/.test((await pay(OWNER, { action: 'issueQr', rid: 'r1' })).data.reason));
  sdk.openapi.wxacode = okApi(Buffer.alloc(200, 65));
  assert.strictEqual((await pay(OWNER, { action: 'issueQr', rid: 'r1' })).data.reason, 'decode:format');
  sdk.openapi.wxacode = okApi(codeImage('png', 280, true));
  assert.strictEqual((await pay(OWNER, { action: 'issueQr', rid: 'r1' })).data.reason, 'decode:blank');
});

t('issueQr：他人记录 / 未入簿被拒', async () => {
  seedPay();
  sdk.openapi.wxacode = okApi(codeImage('png'));
  assert.notStrictEqual((await pay('stranger', { action: 'issueQr', rid: 'r1' })).code, 0);
  seedPay({ status: 'transferred' });
  assert.notStrictEqual((await pay(OWNER, { action: 'issueQr', rid: 'r1' })).code, 0);
});

t('qrCheck：只有主家 / 有「样式」权限的人可用；scene test=1、指向首页；withRaster 才返回光栅；内部 action 不在 request.js', async () => {
  seedPay();
  const seen = [];
  sdk.openapi.wxacode = okApi(codeImage('png'), seen);
  const r = await pay(OWNER, { action: 'qrCheck' });
  assert.deepStrictEqual(r.data, { ok: true, via: 'openapi', reason: '' });
  assert.strictEqual(seen[0].scene, 'test=1');
  assert.strictEqual(seen[0].page, 'pages/index/index');
  const r2 = await pay(OWNER, { action: 'qrCheck', withRaster: true });
  assert.strictEqual(head(r2.data.raster).h, 280);
  assert.notStrictEqual((await pay(CLERK, { action: 'qrCheck' })).code, 0);
  const reqSrc = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/request.js'), 'utf8');
  assert.ok(!reqSrc.includes('_wxaCode') && !reqSrc.includes('_urlLink'));
  sdk.openapi.wxacode = { getUnlimited: async () => { const e = new Error('x'); e.errCode = 85407; throw e; } };
  sdk.callFunction = async () => ({ result: { code: 0, data: { image: '', reason: 'http:85407' } } });
  assert.deepStrictEqual((await pay(OWNER, { action: 'qrCheck' })).data, { ok: false, via: '', reason: 'openapi:85407,system:http:85407' });
});

test('payment 配置：声明 wxacode.getUnlimited 权限（不再用 urllink）；依赖含 pngjs / jpeg-js；purge 会清缓存文件', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(PAY_DIR, 'config.json'), 'utf8'));
  assert.ok(cfg.permissions.openapi.includes('wxacode.getUnlimited'));
  assert.ok(!cfg.permissions.openapi.includes('urllink.generate'));
  const pkg = JSON.parse(fs.readFileSync(path.join(PAY_DIR, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.pngjs && pkg.dependencies['jpeg-js']);
  assert.ok(fs.readFileSync(path.join(__dirname, '../tools/cloud-shared/purge.js'), 'utf8').includes('rcptQrFileID'));
});

// —— system._wxaCode ——
function fakeHttps(handler) {
  const orig = https.request;
  const seen = [];
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = data => {
      const body = JSON.parse(data);
      seen.push({ url, body });
      const out = handler(url, body, seen);
      const res = new EventEmitter();
      process.nextTick(() => { cb(res); res.emit('data', Buffer.isBuffer(out) ? out : Buffer.from(JSON.stringify(out))); res.emit('end'); });
    };
    return req;
  };
  return { seen, restore: () => { https.request = orig; } };
}
const sys = (openid, event) => { state.openid = openid; return loadFunction('system').main(event); };
const seedNonce = (extra = {}) => db.reset().seed('settings', [{ _id: NONCE, kind: 'urllink', createdAt: Date.now(), ...extra }]);
const wx = (extra = {}) => ({ action: '_wxaCode', nonce: NONCE, scene: 'test=1', page: 'pages/index/index', ...extra });
const IMG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]); // 只需文件头像 JPEG

test('system._wxaCode：没有有效一次性凭据一律拒绝（含带 OPENID 的客户端调用、过期、伪造）', async () => {
  process.env.WX_APPSECRET = 'secret-for-test';
  const h = fakeHttps(() => { throw new Error('不应请求微信接口'); });
  try {
    db.reset();
    assert.notStrictEqual((await sys('some-client', { action: '_wxaCode', scene: 'test=1', page: 'pages/index/index' })).code, 0);
    assert.notStrictEqual((await sys('some-client', wx())).code, 0); // 凭据不存在
    seedNonce({ createdAt: Date.now() - 120000 });
    assert.notStrictEqual((await sys('', wx())).code, 0);
    seedNonce({ _openid: 'forged' });
    assert.notStrictEqual((await sys('some-client', wx())).code, 0);
    assert.strictEqual(h.seen.length, 0);
  } finally { h.restore(); }
});

test('system._wxaCode：凭据有效 → stable_token + getwxacodeunlimit（280、纯黑白、check_path=false），图片 base64 返回，token 实例内缓存；参数白名单', async () => {
  process.env.WX_APPSECRET = 'secret-for-test';
  const h = fakeHttps(url => (url.includes('stable_token') ? { access_token: 'AT1' } : IMG));
  try {
    seedNonce();
    const fn = loadFunction('system');
    state.openid = 'whoever';
    const r = await fn.main(wx({ scene: 't=' + TOKEN, page: 'pages/receipt/receipt', envVersion: 'trial' }));
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.data.image, IMG.toString('base64'));
    const gen = h.seen.find(x => x.url.includes('getwxacodeunlimit'));
    assert.ok(gen.url.includes('access_token=AT1'));
    assert.deepStrictEqual(gen.body, { scene: 't=' + TOKEN, page: 'pages/receipt/receipt', width: 280, check_path: false, env_version: 'trial', auto_color: false, line_color: { r: 0, g: 0, b: 0 }, is_hyaline: false });
    seedNonce();
    await fn.main(wx());
    assert.strictEqual(h.seen.filter(x => x.url.includes('stable_token')).length, 1); // 复用缓存
    seedNonce();
    assert.strictEqual((await fn.main(wx({ page: 'pages/records/records' }))).data.reason, 'bad-param');
    seedNonce();
    assert.strictEqual((await fn.main(wx({ scene: 'x'.repeat(33) }))).data.reason, 'bad-param');
    seedNonce();
    assert.strictEqual((await fn.main(wx({ scene: 'a b' }))).data.reason, 'bad-param');
  } finally { h.restore(); }
});

test('system._wxaCode：access_token 失效（40001）→ 强制刷新后重试一次；仍失败给出 http 错误码', async () => {
  process.env.WX_APPSECRET = 'secret-for-test';
  let n = 0;
  const h = fakeHttps((url, body) => {
    if (url.includes('stable_token')) return { access_token: body.force_refresh ? 'AT-NEW' : 'AT-OLD' };
    n++;
    return url.includes('AT-OLD') ? { errcode: 40001, errmsg: 'invalid credential' } : IMG;
  });
  try {
    seedNonce();
    const r = await sys('x', wx());
    assert.strictEqual(r.data.image, IMG.toString('base64'));
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(h.seen.filter(x => x.url.includes('stable_token')).map(x => x.body.force_refresh), [false, true]);
  } finally { h.restore(); }
  const h2 = fakeHttps(url => (url.includes('stable_token') ? { access_token: 'AT' } : { errcode: 42001 }));
  try {
    seedNonce();
    const r = await sys('x', wx());
    assert.strictEqual(r.data.image, '');
    assert.strictEqual(r.data.reason, 'http:42001');
    assert.strictEqual(h2.seen.filter(x => x.url.includes('getwxacodeunlimit')).length, 2);
  } finally { h2.restore(); }
});

test('system._wxaCode：WX_APPSECRET 未配置 → secret-missing；AppSecret 错误 → token:40125（不含密钥）；85407 原样透出', async () => {
  const saved = process.env.WX_APPSECRET;
  try {
    delete process.env.WX_APPSECRET;
    seedNonce();
    assert.strictEqual((await sys('x', wx())).data.reason, 'secret-missing');
    process.env.WX_APPSECRET = 'wrong-secret-xyz';
    const h = fakeHttps(() => ({ errcode: 40125, errmsg: 'invalid appsecret' }));
    try {
      seedNonce();
      const r2 = await sys('x', wx());
      assert.strictEqual(r2.data.reason, 'token:40125');
      assert.ok(!JSON.stringify(r2).includes('wrong-secret-xyz'));
    } finally { h.restore(); }
    const h3 = fakeHttps(url => (url.includes('stable_token') ? { access_token: 'AT' } : { errcode: 85407, errmsg: 'no permission' }));
    try {
      seedNonce();
      assert.strictEqual((await sys('x', wx())).data.reason, 'http:85407');
    } finally { h3.restore(); }
  } finally { if (saved === undefined) delete process.env.WX_APPSECRET; else process.env.WX_APPSECRET = saved; }
});

// —— scene 构造与解析 ——
const rs = require('../miniprogram/utils/rcptscene.js');

test('rcptscene：scene 构造 ≤32 位；解析 options.scene（URL 编码 / 原文）、?t=，非法返回空', () => {
  assert.strictEqual(rs.sceneOf(TOKEN), 't=' + TOKEN);
  assert.ok(rs.sceneOf(TOKEN).length <= 32);
  assert.strictEqual(rs.tokenFromOptions({ scene: encodeURIComponent('t=' + TOKEN) }), TOKEN);
  assert.strictEqual(rs.tokenFromOptions({ scene: 't=' + TOKEN }), TOKEN);
  assert.strictEqual(rs.tokenFromOptions({ scene: 'a=1&t=' + TOKEN }), TOKEN);
  assert.strictEqual(rs.tokenFromOptions({ t: TOKEN }), TOKEN);
  assert.strictEqual(rs.tokenFromOptions({ scene: 'test=1' }), '');
  assert.strictEqual(rs.tokenFromOptions({ scene: 't=short' }), '');
  assert.strictEqual(rs.tokenFromOptions({ scene: '%E0%A4%A' }), '');
  assert.strictEqual(rs.tokenFromOptions({ rid: 'abc' }), '');
  assert.strictEqual(rs.tokenFromOptions(null), '');
  const src = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/receipt/receipt.js'), 'utf8');
  assert.ok(src.includes('rcptscene.tokenFromOptions(options)'));
});

// —— BLE MTU 分包 ——
const device = require('../miniprogram/utils/device.js');
const ble = require('../miniprogram/utils/ble.js');

function fakeWx({ platform, mtu, mtuFail, failAtPacket }) {
  const writes = [];
  const log = { mtuCalls: 0 };
  global.wx = {
    getDeviceInfo: () => ({ platform }),
    createBLEConnection: o => o.success(),
    onBLEConnectionStateChange: () => {},
    closeBLEConnection: o => o && o.complete && o.complete(),
    getBLEDeviceServices: o => o.success({ services: [{ uuid: '0000FF00-0000-1000-8000-00805F9B34FB' }] }),
    getBLEDeviceCharacteristics: o => o.success({ characteristics: [{ uuid: 'FF02', properties: { write: true } }] }),
    setBLEMTU: o => { log.mtuCalls++; if (mtuFail) o.fail({ errCode: 10007 }); else o.success({ mtu }); },
    writeBLECharacteristicValue: o => {
      if (failAtPacket !== undefined && writes.length === failAtPacket) return o.fail({ errCode: 10006 });
      writes.push(o.value.byteLength);
      o.success();
    }
  };
  device.reset();
  return { writes, log };
}

test('BLE：安卓协商 MTU 成功 → 单包 MTU-3（182）；失败 / iOS → 保持 20；iOS 不调用 setBLEMTU', async () => {
  let f = fakeWx({ platform: 'android', mtu: 185 });
  await ble.connect('dev1');
  assert.strictEqual(f.log.mtuCalls, 1);
  assert.strictEqual(ble.state.chunk, 182);
  f = fakeWx({ platform: 'android', mtuFail: true });
  await ble.connect('dev1');
  assert.strictEqual(ble.state.chunk, 20);
  f = fakeWx({ platform: 'ios', mtu: 185 });
  await ble.connect('dev1');
  assert.strictEqual(f.log.mtuCalls, 0);
  assert.strictEqual(ble.state.chunk, 20);
  f = fakeWx({ platform: 'android', mtu: 23 }); // 打印机只支持默认 MTU
  await ble.connect('dev1');
  assert.strictEqual(ble.state.chunk, 20);
  delete global.wx;
  device.reset();
});

test('BLE 分包：20 与 182 两种包大小，包数与总字节正确；中途失败的已写字节数随包大小同步', async () => {
  for (const size of [20, 182]) {
    const f = fakeWx({ platform: 'ios' });
    ble.state.deviceId = 'dev1';
    const buf = new Uint8Array(10000).map((_, i) => i % 251).buffer; // 约一张小程序码光栅
    await ble.writeBuffer(buf, size);
    assert.strictEqual(f.writes.length, Math.ceil(10000 / size));
    assert.strictEqual(f.writes.reduce((a, b) => a + b, 0), 10000);
    assert.ok(Math.max(...f.writes) <= size);
    // 第 3 个包失败：已写入 = 前两个包的字节数，用于「中途失败不重打」判断
    const f2 = fakeWx({ platform: 'ios', failAtPacket: 2 });
    ble.state.deviceId = 'dev1';
    await assert.rejects(() => ble.writeBuffer(buf, size), e => e.written === size * 2 && e.errCode === 10006);
    assert.strictEqual(f2.writes.length, 2);
  }
  // 不传包大小时用协商结果
  const f3 = fakeWx({ platform: 'android', mtu: 185 });
  await ble.connect('dev1');
  await ble.writeBuffer(new Uint8Array(400).buffer);
  assert.deepStrictEqual(f3.writes, [182, 182, 36]);
  ble.state.deviceId = '';
  ble.state.chunk = 20;
  delete global.wx;
  device.reset();
});

test('打印耗时估算：一张小程序码 9808 字节，182 字节/包比 20 字节/包快 8 倍以上', () => {
  const bytes = 8 + 35 * 280;
  const est = size => Math.ceil(bytes / size) * 0.02; // 只算 20ms 间隔，不含蓝牙往返
  assert.ok(est(182) < est(20) / 8);
});
