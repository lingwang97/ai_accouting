// v3.66.1 宾客入簿通知：字段构造、只在入簿时发、不重复发、礼台代记不发、批次合一条
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction } = require('./helpers/sdk-stub.js');
const notify = require('../cloudfunctions/payment/notify.js');

const OWNER = 'o-owner';
const sent = [];

// ---- 字段构造
test('buildGuest：喜事单人 / 白事单人 / 批次 / 白事批次的备注；金额两位小数；支付方式', () => {
  const t = '2026年10月27日 14:30';
  const a = notify.buildGuest({ hostName: '张府', themeName: '新婚之喜', amount: 600, count: 1, method: 'wechat' }, t);
  assert.strictEqual(a.thing6.value, '张府 新婚之喜');
  assert.strictEqual(a.amount3.value, '600.00元');
  assert.strictEqual(a.time1.value, t);
  assert.strictEqual(a.thing8.value, '微信转账');
  assert.strictEqual(a.thing5.value, '已入簿，点此查看电子回执');
  const f = notify.buildGuest({ hostName: '李府', themeName: '追思会', amount: 200.5, count: 1, funeral: true, method: 'cash' }, t);
  assert.strictEqual(f.thing5.value, '奠仪已收到，点此查看回执');
  assert.strictEqual(f.amount3.value, '200.50元');
  assert.strictEqual(f.thing8.value, '现金');
  assert.strictEqual(notify.buildGuest({ count: 3, amount: 900, method: 'mixed' }, t).thing5.value, '3人一起随礼，已入簿');
  assert.strictEqual(notify.buildGuest({ count: 3, amount: 900, method: 'mixed' }, t).thing8.value, '微信转账+现金');
  assert.strictEqual(notify.buildGuest({ count: 2, amount: 1, funeral: true }, t).thing5.value, '2人奠仪已收到');
  for (const v of Object.values(a)) assert.ok(v.value.length <= 20);
});

test('buildGuest：超长截断到 20 字、去掉表情等特殊字符、空时有兜底', () => {
  const g = notify.buildGuest({ hostName: '欧阳府😀🎉', themeName: '一二三四五六七八九十一二三四五六七八九十', amount: 1, count: 1 }, 't');
  assert.ok(g.thing6.value.length <= 20);
  assert.ok(!/[😀🎉]/u.test(g.thing6.value));
  assert.ok(g.thing6.value.startsWith('欧阳府 '));
  assert.strictEqual(notify.buildGuest({ amount: 1, count: 1 }, 't').thing6.value, '慧礼记');
  assert.strictEqual(notify.thingValue('<b>张府</b>\n新婚', ''), 'b张府b新婚');
});

// ---- 发送时机
function seed(records) {
  db.reset().applyUpdates = true;
  sent.length = 0;
  sdk.openapi.subscribeMessage = { send: async o => { sent.push(o); } };
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜', type: 'wedding' }])
    .seed('records', records);
}
const rec = (id, extra) => ({ _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', themeName: '新婚之喜', payerOpenid: 'g1', payerName: '王五', amount: 600, payMethod: 'wechat', status: 'transferred', createdAt: new Date(), ...extra });
const owner = ev => { state.openid = OWNER; return loadFunction('payment').main(ev); };

test('宾客点「我已完成转账」时同意订阅：记 guestNotify 与版本；没同意不记', async () => {
  seed([rec('r1', { status: 'pending' }), rec('r2', { status: 'pending', payerOpenid: 'g2' })]);
  state.openid = 'g1';
  const r = await loadFunction('payment').main({ action: 'transferred', rid: 'r1', envVersion: 'trial', guestNotify: true });
  assert.strictEqual(r.code, 0, r.msg);
  const r1 = db.data.records.find(x => x._id === 'r1');
  assert.strictEqual(r1.guestNotify, true);
  assert.strictEqual(r1.guestEnv, 'trial');
  state.openid = 'g2';
  await loadFunction('payment').main({ action: 'transferred', rid: 'r2', envVersion: 'release' });
  assert.strictEqual(db.data.records.find(x => x._id === 'r2').guestNotify, undefined);
});

test('主家确认入簿后给订阅的宾客发一次：体验版、打开回执；再次调用不重复发', async () => {
  seed([rec('r1', { guestNotify: true, guestEnv: 'trial' })]);
  const r = await owner({ action: 'confirm', rid: 'r1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(sent.length, 1);
  const m = sent[0];
  assert.strictEqual(m.touser, 'g1');
  assert.strictEqual(m.templateId, notify.GUEST_TMPL_ID);
  assert.strictEqual(m.page, 'pages/receipt/receipt?rid=r1');
  assert.strictEqual(m.miniprogramState, 'trial');
  assert.strictEqual(m.data.thing6.value, '张府 新婚之喜');
  assert.ok(db.data.records[0].guestNotifiedAt);
  assert.ok(!('guestEnv' in r.data.record)); // 不返回前端
  // 重复调用（比如别的入口又处理一次）：已发过不再发
  await owner({ action: 'confirmBatch', rids: ['r1'] }); // 已入簿：确认失败，也不会再发
  assert.strictEqual(sent.length, 1);
});

test('只在入簿时发：未收到（拒绝）不发；没订阅不发；礼台代记 / 经办人自己不发', async () => {
  seed([rec('r1', { guestNotify: true })]);
  await owner({ action: 'reject', rid: 'r1' });
  assert.strictEqual(sent.length, 0);
  seed([rec('r2')]); // 没订阅
  await owner({ action: 'confirm', rid: 'r2' });
  assert.strictEqual(sent.length, 0);
  seed([rec('r3', { guestNotify: true, payerOpenid: '' })]); // 礼台代记
  await owner({ action: 'confirm', rid: 'r3' });
  assert.strictEqual(sent.length, 0);
  seed([rec('r4', { guestNotify: true, payerOpenid: OWNER })]); // 主家自己试扫：经办人就是自己
  await owner({ action: 'confirm', rid: 'r4' });
  assert.strictEqual(sent.length, 0);
});

test('批次：整批确认只发一条，金额为合计，点开宾客自己那条；批量确认分两次时最后一次才发', async () => {
  const b = (id, i, amt) => rec(id, { batchId: 'B1', batchIdx: i, batchSize: 3, payerName: '甲' + i, amount: amt, guestNotify: true });
  seed([b('a0', 0, 100), b('a1', 1, 200), b('a2', 2, 300)]);
  await owner({ action: 'confirm', rid: 'a1' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].page, 'pages/receipt/receipt?rid=a0&batch=1');
  assert.strictEqual(sent[0].data.amount3.value, '600.00元');
  assert.strictEqual(sent[0].data.thing5.value, '3人一起随礼，已入簿');
  // 列表批量确认：同一批被拆到两次调用
  seed([b('a0', 0, 100), b('a1', 1, 200), b('a2', 2, 300)]);
  await owner({ action: 'confirmBatch', rids: ['a0', 'a1'] });
  assert.strictEqual(sent.length, 0); // 还有一位没处理
  await owner({ action: 'confirmBatch', rids: ['a2'] });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].data.amount3.value, '600.00元');
});

test('白事：发送失败（如宾客次数已用）不影响确认结果', async () => {
  seed([rec('f1', { bookType: 'funeral', guestNotify: true })]);
  sdk.openapi.subscribeMessage = { send: async () => { const e = new Error('x'); e.errCode = 43101; throw e; } };
  const r = await owner({ action: 'confirm', rid: 'f1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(db.data.records[0].status, 'paid');
});
