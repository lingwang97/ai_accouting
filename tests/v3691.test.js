// v3.69.1：入簿通知打开整批回执、本机离线礼簿码文件随身份清理、误建的 miniprogram/.claude、ownPayCode 共享、高峰开关防连点
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const GN = require('../tools/cloud-shared/guestnotify.js');

const OWNER = 'o-owner';
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('入簿通知：单笔不带 batch，批次带 batch=1；回执页把 batch=1 传给 receiptGet', async () => {
  db.reset().applyUpdates = true;
  const sent = [];
  sdk.openapi.subscribeMessage = { send: async o => { sent.push(o); } };
  const r = (id, extra) => ({ _id: id, aid: 'a', ownerOpenid: OWNER, payerOpenid: 'g1', payerName: '王', amount: 1, status: 'paid', paidAt: new Date(), guestNotify: true, ...extra });
  db.seed('records', [r('s1'), r('b0', { batchId: 'B', batchIdx: 0 }), r('b1', { batchId: 'B', batchIdx: 1 })]);
  await GN.create(db, sdk).notifyGuests(['s1', 'b0', 'b1']);
  assert.deepStrictEqual(sent.map(m => m.page).sort(), ['pages/receipt/receipt?rid=b0&batch=1', 'pages/receipt/receipt?rid=s1']);
  const page = read('miniprogram/pages/receipt/receipt.js');
  assert.ok(/batch: options\.batch === '1'/.test(page));
  assert.ok(/req\.receiptGet\(options\.rid, batch,/.test(page));
});

test('payment.receipt batch：付款人本人看整批；认领人只看自己那张（v3.58.1 规则不变）', async () => {
  db.reset();
  const r = (id, i, extra) => ({ _id: id, aid: 'a', ownerOpenid: OWNER, batchId: 'B', batchIdx: i, payerName: '甲' + i, amount: 100, status: 'paid', payerOpenid: 'g1', ...extra });
  db.seed('records', [r('b0', 0), r('b1', 1, { claimedOpenid: 'c9' })]).seed('users', []).seed('accounts', []).seed('members', []);
  state.openid = 'g1';
  const mine = await loadFunction('payment').main({ action: 'receipt', rid: 'b0', batch: true });
  assert.strictEqual(mine.code, 0, mine.msg);
  assert.strictEqual(mine.data.record.batchItems.length, 2);
  state.openid = 'c9';
  const other = await loadFunction('payment').main({ action: 'receipt', rid: 'b1', batch: true });
  assert.strictEqual(other.code, 0, other.msg);
  assert.ok(!other.data.record.batchItems, '认领人不能看整批');
});

test('离线礼簿码：qroff.clearFiles 只删 qroff_ 开头的本机文件；resetIdentity 调用；qrcode 页用同一前缀', () => {
  const removed = [];
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getFileSystemManager: () => ({
      readdirSync: () => ['qroff_main_qr.png', 'qroff_main_pay.png', 'qroff_b1_qr.png', 'other.png'],
      unlinkSync: p => removed.push(p)
    })
  };
  try {
    const Q = require('../miniprogram/utils/qroff.js');
    assert.strictEqual(Q.clearFiles(), 3);
    assert.deepStrictEqual(removed, ['wxfile://usr/qroff_main_qr.png', 'wxfile://usr/qroff_main_pay.png', 'wxfile://usr/qroff_b1_qr.png']);
    global.wx.getFileSystemManager = () => { throw new Error('no fs'); };
    assert.strictEqual(Q.clearFiles(), 0, '读不到目录不报错');
  } finally { delete global.wx; }
  const app = read('miniprogram/app.js');
  const reset = app.slice(app.indexOf('resetIdentity() {'), app.indexOf('resetIdentity() {') + 900);
  assert.ok(/qroff\.js'\)\.clearFiles\(\)/.test(reset));
  assert.ok(/OFF_PREFIX = require\('\.\.\/\.\.\/utils\/qroff\.js'\)\.PREFIX/.test(read('miniprogram/pages/qrcode/qrcode.js')));
});

test('miniprogram/.claude 不在小程序目录里；git 忽略、打包忽略', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'miniprogram', '.claude')));
  assert.ok(/^miniprogram\/\.claude\/$/m.test(read('.gitignore')));
  const cfg = JSON.parse(read('project.config.json'));
  assert.ok(cfg.packOptions.ignore.some(x => x.type === 'folder' && x.value === '.claude'));
});

test('ownPayCode 只在共享模块里定义一份；判断规则不变', () => {
  ['account', 'books', 'system'].forEach(fn => {
    const s = read(`cloudfunctions/${fn}/index.js`);
    assert.ok(!/function ownPayCode/.test(s), fn);
    assert.ok(/require\('\.\/paycode\.js'\)/.test(s), fn);
  });
  const { ownPayCode } = require('../tools/cloud-shared/paycode.js');
  assert.ok(ownPayCode('cloud://env.x/paycodes/oABC_1-1700000000000.png', 'oABC_1'));
  assert.ok(ownPayCode('cloud://env.x/paycodes/book-oABC_1-1700000000000.jpg', 'oABC_1'));
  assert.ok(!ownPayCode('cloud://env.x/paycodes/oOTHER-1700000000000.png', 'oABC_1'));
  assert.ok(!ownPayCode('cloud://env.x/avatars/oABC_1-1.png', 'oABC_1'));
  assert.ok(!ownPayCode('cloud://env.x/paycodes/oABC_1-1.png', ''));
});

test('高峰开关：上一次没返回时再点不重复提交，结束后复位', () => {
  const s = read('miniprogram/pages/advanced/advanced.js');
  const fn = s.slice(s.indexOf('async onPeakSwitch('), s.indexOf('// —— 回收站保留时间'));
  assert.ok(/if \(this\._peakBusy\) return this\.resetSwitch/.test(fn));
  assert.ok(/finally \{\s*this\._peakBusy = false;/.test(fn));
});
