// v3.77.1：新礼金提醒（主家 / 记账人）换新模板：字段、批次、白事、申诉提醒、旧订阅 43101 提示
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction } = require('./helpers/sdk-stub.js');
const notify = require('../cloudfunctions/payment/notify.js');

const ROOT = path.join(__dirname, '..');
const NEW_ID = 'sVsjMMXbw7ZiMu8rEG-8_Y4toUJ42ziyevx2NtVgng4';
const OLD_ID = 'eC0vKfrKjT6oBR187PU8HRIO85tW1EM8W-gqe9xjSqc';
const OWNER = 'o-owner';
const sent = [];

function seed(records, bookType) {
  db.reset().applyUpdates = true;
  sent.length = 0;
  sdk.openapi.subscribeMessage = { send: async o => { sent.push(o); } };
  sdk.openapi.security = { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) };
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER, giftNotify: true }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜', type: bookType || 'wedding' }])
    .seed('records', records);
}
const rec = (id, extra) => ({ _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', themeName: '新婚之喜', payerOpenid: 'g1', payerName: '王五', amount: 600, payMethod: 'wechat', status: 'pending', createdAt: new Date(), ...extra });
const guest = (ev, id) => { state.openid = id || 'g1'; return loadFunction('payment').main(ev); };

test('build：新模板字段 thing1 / thing4 / amount7 / time9 / thing3；不含旧字段；20 字内、去特殊字符', () => {
  const d = notify.build({ hostName: '张府', themeName: '新婚之喜', payerName: '王五', amount: 600, reason: '新礼金待确认' }, '2026年10月30日 10:00');
  assert.deepStrictEqual(Object.keys(d).sort(), ['amount7', 'thing1', 'thing3', 'thing4', 'time9']);
  assert.strictEqual(d.thing1.value, '张府 新婚之喜');
  assert.strictEqual(d.thing4.value, '王五');
  assert.strictEqual(d.amount7.value, '600.00元');
  assert.strictEqual(d.time9.value, '2026年10月30日 10:00');
  assert.strictEqual(d.thing3.value, '新礼金待确认');
  const long = notify.build({ hostName: '欧阳府😀', themeName: '一二三四五六七八九十一二三四五六七八九十', payerName: '甲'.repeat(30), amount: 1.005, reason: '很长'.repeat(20) }, 't');
  for (const k of ['thing1', 'thing4', 'thing3']) assert.ok(long[k].value.length <= 20, long[k].value);
  assert.ok(!/😀/u.test(long.thing1.value));
  assert.strictEqual(notify.build({ amount: 1 }, 't').thing1.value, '慧礼记');
  assert.strictEqual(notify.build({ amount: 1 }, 't').thing4.value, '宾客');
  assert.strictEqual(notify.TMPL_ID, NEW_ID);
  assert.ok(fs.readFileSync(path.join(ROOT, 'miniprogram/config.js'), 'utf8').includes(NEW_ID), '前后端模板 ID 一致');
});

test('transferred：单人喜事发新模板，字段按登记内容；点开待确认页', async () => {
  seed([rec('r1')]);
  const r = await guest({ action: 'transferred', rid: 'r1', envVersion: 'trial' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].touser, OWNER);
  assert.strictEqual(sent[0].templateId, NEW_ID);
  assert.strictEqual(sent[0].page, 'pages/pending/pending');
  assert.strictEqual(sent[0].data.thing1.value, '张府 新婚之喜');
  assert.strictEqual(sent[0].data.thing4.value, '王五');
  assert.strictEqual(sent[0].data.amount7.value, '600.00元');
  assert.strictEqual(sent[0].data.thing3.value, '新礼金待确认');
  assert.ok(sent[0].data.time9.value);
});

test('transferred：批次写「张三等3人」、金额合计、「N人一起随礼待确认」；混合支付同样；白事用奠仪', async () => {
  const b = (id, i, amt, extra) => rec(id, { batchId: 'B1', batchIdx: i, batchSize: 3, payerName: ['张三', '李四', '王五'][i], amount: amt, ...extra });
  seed([b('a0', 0, 100), b('a1', 1, 200), b('a2', 2, 300)]);
  await guest({ action: 'transferred', rid: 'a0' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].data.thing4.value, '张三等3人');
  assert.strictEqual(sent[0].data.amount7.value, '600.00元');
  assert.strictEqual(sent[0].data.thing3.value, '3人一起随礼待确认');
  seed([b('a0', 0, 100, { batchPay: 'mixed' }), b('a1', 1, 200, { batchPay: 'mixed', payMethod: 'cash' }), b('a2', 2, 300, { batchPay: 'mixed' })]);
  await guest({ action: 'transferred', rid: 'a0' });
  assert.strictEqual(sent[0].data.thing3.value, '3人一起随礼待确认');
  seed([b('f0', 0, 100, { bookType: 'funeral' }), b('f1', 1, 100, { bookType: 'funeral' }), b('f2', 2, 100, { bookType: 'funeral' })], 'funeral');
  await guest({ action: 'transferred', rid: 'f0' });
  assert.strictEqual(sent[0].data.thing3.value, '3人一起奠仪待确认');
  seed([rec('f9', { bookType: 'funeral' })], 'funeral');
  await guest({ action: 'transferred', rid: 'f9' });
  assert.strictEqual(sent[0].data.thing3.value, '奠仪待确认');
});

test('申诉提醒：新模板，thing3「宾客申诉，请再核对」，time9 为申诉时间，金额为该笔；不再向旧模板发送', async () => {
  seed([rec('r1', { status: 'rejected', rejectedAt: new Date(), rejectedFrom: 'transferred', transferredAt: new Date(Date.now() - 86400000 * 3) })]);
  const r = await guest({ action: 'appeal', rid: 'r1', note: '转了' });
  assert.strictEqual(r.code, 0, r.msg);
  const n = sent.filter(x => x.templateId === NEW_ID);
  assert.strictEqual(n.length, 1);
  assert.strictEqual(n[0].data.thing3.value, '宾客申诉，请再核对');
  assert.strictEqual(n[0].data.amount7.value, '600.00元');
  assert.ok(n[0].data.time9.value.includes(String(new Date().getFullYear())));
  assert.ok(!sent.some(x => x.templateId === OLD_ID));
});

test('发送 43101（旧模板订阅 / 次数用完）记入 lastNotify，不影响转账结果', async () => {
  seed([rec('r1')]);
  sdk.openapi.subscribeMessage = { send: async () => { const e = new Error('x'); e.errCode = 43101; throw e; } };
  const r = await guest({ action: 'transferred', rid: 'r1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(db.data.users.find(u => u.openid === OWNER).lastNotify.code, 43101);
});

function loadNotify(store, extra) {
  global.wx = { getStorageSync: k => store[k], setStorageSync: (k, v) => { store[k] = v; }, getSetting() {}, showModal() {}, ...(extra || {}) };
  delete require.cache[require.resolve('../miniprogram/utils/notify.js')];
  return require('../miniprogram/utils/notify.js');
}

test('前端 tipText：旧用户（订阅的不是当前模板）提示重新开启；43101 提示重新开启；按新模板开启后不提示；关闭的人不提示', () => {
  const store = {};
  const n = loadNotify(store);
  assert.ok(n.tipText(null, true).includes('重新开启'), '无新模板记录');
  assert.ok(n.tipText({ ok: true, code: 0, at: new Date() }, true).includes('重新开启'));
  assert.strictEqual(n.tipText(null, false), '');
  store.notify_tmpl = OLD_ID;
  assert.ok(n.tipText(null, true).includes('重新开启'));
  store.notify_tmpl = NEW_ID;
  store.notify_on_at = Date.now() - 1000;
  assert.strictEqual(n.tipText({ ok: true, code: 0, at: new Date(Date.now() - 86400000) }, true), '');
  const t = n.tipText({ ok: false, code: 43101, at: new Date() }, true);
  assert.ok(t.includes('重新开启') && t.includes('高级功能'), t);
  delete global.wx;
});

test('前端 subscribe 请求新模板并记录模板 ID；高级功能开关走 notify.subscribe', async () => {
  const store = {};
  let asked = null;
  const n = loadNotify(store, { requestSubscribeMessage: o => { asked = o.tmplIds; o.success({ [NEW_ID]: 'accept' }); } });
  assert.strictEqual(await n.subscribe(), true);
  assert.deepStrictEqual(asked, [NEW_ID]);
  assert.strictEqual(store.notify_tmpl, NEW_ID);
  assert.strictEqual(n.tipText(null, true), '');
  assert.ok(fs.readFileSync(path.join(ROOT, 'miniprogram/pages/advanced/advanced.js'), 'utf8').includes('notify.subscribe()'));
  delete global.wx;
});
