// v3.76.0 疑似重复登记（宾客端提示 dupOf + 待确认页标「疑似重复」）、工作台礼簿合计改实时聚合并核对累计值
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction } = require('./helpers/sdk-stub.js');

const OWNER = 'o-owner';
const MIN = 60 * 1000;
const read = f => fs.readFileSync(path.join(__dirname, '../miniprogram', f), 'utf8');

function seed(records) {
  db.reset().applyUpdates = true;
  db.persist = true;
  sdk.openapi.security = { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) };
  sdk.openapi.subscribeMessage = { send: async () => {} };
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '李府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, type: 'wedding', name: '婚宴', statReady: true, statCount: 0, statFen: 0, statSince: new Date(0) }])
    .seed('records', records);
}
const mine = (id, extra) => ({ _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', payerOpenid: 'g1', payerName: '张三', amount: 500, payMethod: 'wechat', status: 'transferred', createdAt: new Date(Date.now() - 5 * MIN), ...extra });
const create = extra => { state.openid = 'g1'; return loadFunction('payment').main({ action: 'create', aid: 'acc1', payerName: '张三', amount: 500, dupCheck: true, ...extra }); };

test('create：30 分钟内本人在本礼簿已登记同名同额 → 返回 dupOf（不建记录、不含 id / openid）；allowDup 后照常登记', async () => {
  seed([mine('r1')]);
  const r = await create({ reqId: 'gdup-00001' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.deepStrictEqual(Object.keys(r.data), ['dupOf']);
  assert.strictEqual(r.data.dupOf.name, '张三');
  assert.strictEqual(r.data.dupOf.amount, 500);
  assert.strictEqual(r.data.dupOf.status, 'transferred');
  assert.strictEqual(r.data.dupOf.minutes, 5);
  assert.ok(!/r1|g1|o-owner/.test(JSON.stringify(r.data)));
  assert.strictEqual(db.data.records.length, 1);
  const r2 = await create({ reqId: 'gdup-00001', allowDup: true });
  assert.strictEqual(r2.code, 0, r2.msg);
  assert.ok(r2.data.record);
  assert.strictEqual(db.data.records.length, 2);
});

test('create：现金随礼同样提示；批次里任一人同名同额即提示', async () => {
  seed([mine('r1', { payMethod: 'cash' })]);
  const c = await create({ payMethod: 'cash', reqId: 'gdup-00002' });
  assert.ok(c.data.dupOf);
  const b = await create({ items: [{ name: '李四', amount: 100 }, { name: '张三', amount: 500 }], reqId: 'gdup-00003' });
  assert.strictEqual(b.data.dupOf.name, '张三');
});

test('create：金额不同 / 超过 30 分钟 / 已取消 / 未收到 / 别的礼簿 / 别人登记的 都不提示', async () => {
  const cases = [
    mine('a', { amount: 600 }),
    mine('b', { createdAt: new Date(Date.now() - 31 * MIN) }),
    mine('c', { status: 'cancelled' }),
    mine('d', { status: 'rejected' }),
    mine('e', { bookId: 'b2' }),
    mine('f', { payerOpenid: 'g9' })
  ];
  for (const x of cases) {
    seed([x]);
    const r = await create({ reqId: 'gdup-1' + x._id + '0000' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(!r.data.dupOf, '不应提示：' + x._id);
  }
});

test('create：同一 reqId 的重试（上次已写入）不提示重复，按幂等返回原记录', async () => {
  seed([]);
  const r1 = await create({ reqId: 'gdup-00009' });
  assert.ok(r1.data.record);
  // fakedb 的 add 不拒绝重复 _id：重试前把上一次写入的记录 createdAt 保持在 30 分钟内
  const r2 = await create({ reqId: 'gdup-00009' });
  assert.ok(!r2.data.dupOf);
  assert.strictEqual(r2.data.record._id, r1.data.record._id);
});

test('create：旧前端（不带 dupCheck）不检查重复，保持原行为', async () => {
  seed([mine('r1')]);
  const r = await create({ reqId: 'gdup-00010', dupCheck: undefined });
  assert.ok(r.data.record && !r.data.dupOf);
});

test('pay.js：带 dupCheck 提交；dupOf 弹窗确认后带 allowDup 重新提交；按钮不超过 4 字', () => {
  const src = read('pages/pay/pay.js');
  assert.ok(/reqId, dupCheck: true,/.test(src));
  assert.ok(/if \(res\.dupOf\) \{\s*if \(!\(await this\.askDup\(res\.dupOf\)\)\) return;\s*allowDup = true;/.test(src));
  assert.ok(/allowDup \? \{ allowDup: true \} : \{\}/.test(src));
  const m = src.match(/askDup\(dup\) \{[\s\S]*?\n  \},/)[0];
  [...m.matchAll(/(confirmText|cancelText): '([^']*)'/g)].forEach(x => assert.ok(x[2].length <= 4, x[0]));
});

// ---- 待确认页「疑似重复」
test('records.pending：同礼簿同名同额 30 分钟内的多条标 suspectDup（含已入簿的那条做参照），其他不标', async () => {
  const now = Date.now();
  const r = (id, extra) => ({ _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', payerName: '张三', amount: 500, status: 'transferred', createdAt: new Date(now - 10 * MIN), transferredAt: new Date(now - 10 * MIN), ...extra });
  seed([
    r('t1'),
    r('p1', { status: 'paid', createdAt: new Date(now - 20 * MIN) }), // 已入簿的同名同额：t1 疑似重复
    r('t2', { payerName: '李四' }),
    r('t3', { payerName: '王五', amount: 300 }),
    r('t4', { payerName: '王五', amount: 400 })                       // 金额不同：不标
  ]);
  state.openid = OWNER;
  const res = await loadFunction('records').main({ action: 'pending', withRejected: true });
  assert.strictEqual(res.code, 0, res.msg);
  const by = id => res.data.list.find(x => x._id === id);
  assert.strictEqual(by('t1').suspectDup, true);
  assert.ok(!by('t2').suspectDup && !by('t3').suspectDup && !by('t4').suspectDup);
});

test('records.dupFlags：宾客自己取消的不算；自动取消的算；相差超过 30 分钟不算', () => {
  const { dupFlags } = loadFunction('records')._test;
  const t = Date.now();
  const a = { _id: 'a', payerName: '张三', amount: 500, createdAt: new Date(t) };
  assert.ok(!dupFlags([{ ...a }], [a, { _id: 'x', payerName: '张三', amount: 500, status: 'cancelled', createdAt: new Date(t) }])[0].suspectDup);
  assert.ok(dupFlags([{ ...a }], [a, { _id: 'x', payerName: '张三', amount: 500, status: 'cancelled', autoCancelled: true, createdAt: new Date(t) }])[0].suspectDup);
  assert.ok(!dupFlags([{ ...a }], [a, { _id: 'x', payerName: '张三', amount: 500, status: 'paid', createdAt: new Date(t - 31 * MIN) }])[0].suspectDup);
});

test('待确认页：列表、未点完成、大字模式显示「疑似重复」，确认弹窗带提醒；group 传递 suspectDup', () => {
  const w = read('pages/pending/pending.wxml');
  assert.strictEqual((w.match(/class="dup-tag" wx:if="\{\{item\.suspectDup\}\}"/g) || []).length, 2);
  assert.ok(/current\.suspectDup/.test(w));
  assert.ok(/\.dup-tag \{[^}]*white-space: nowrap/.test(read('pages/pending/pending.wxss')));
  assert.ok(/record\.suspectDup \? '【疑似重复】/.test(read('utils/confirm.js')));
  global.wx = {};
  const { groupRecords } = require('../miniprogram/utils/group.js');
  const g = groupRecords([{ _id: 'a', batchId: 'B', batchIdx: 0, payerName: '甲', amount: 1 }, { _id: 'b', batchId: 'B', batchIdx: 1, payerName: '乙', amount: 2, suspectDup: true }]);
  assert.strictEqual(g[0].suspectDup, true);
});

// ---- 工作台合计实时聚合
function dashAgg(count, fen) {
  db.aggList = a => {
    const s = JSON.stringify(a.stages);
    return /"status":"paid"/.test(s) && /"bookId":"b1"/.test(s) && !/payDay/.test(s) ? [{ _id: null, count, fen }] : [];
  };
}
const dash = async m => { state.openid = OWNER; const r = await m.main({ action: 'dashboard' }); assert.strictEqual(r.code, 0, r.msg); return r.data; };

test('dashboard：礼簿合计用实时聚合；与累计值不一致时置 statReady=false（下次打开礼簿列表重算）', async () => {
  seed([]);
  db.data.books[0].statCount = 1; db.data.books[0].statFen = 50000; // 漏加了一笔
  dashAgg(2, 110000);
  const d = await dash(loadFunction('records'));
  assert.strictEqual(d.book.count, 2);
  assert.strictEqual(d.book.sum, 1100);
  assert.strictEqual(db.data.books[0].statReady, false);
  db.aggList = null;
});

test('dashboard：实时合计实例内缓存，累计值没变 30 秒内不重复聚合；有新入簿（累计值变了）立即重算', async () => {
  seed([]);
  db.data.books[0].statCount = 2; db.data.books[0].statFen = 110000;
  dashAgg(2, 110000);
  const m = loadFunction('records');
  await dash(m);
  const n0 = db.log.filter(l => l.op === 'aggregate' && /"bookId":"b1"/.test(JSON.stringify(l.stages)) && !/payDay/.test(JSON.stringify(l.stages)) && /"status":"paid"/.test(JSON.stringify(l.stages))).length;
  await dash(m);
  const n1 = db.log.filter(l => l.op === 'aggregate' && /"bookId":"b1"/.test(JSON.stringify(l.stages)) && !/payDay/.test(JSON.stringify(l.stages)) && /"status":"paid"/.test(JSON.stringify(l.stages))).length;
  assert.strictEqual(n1, n0, '命中缓存');
  db.data.books[0].statCount = 3; db.data.books[0].statFen = 160000;
  dashAgg(3, 160000);
  const d = await dash(m);
  assert.strictEqual(d.book.sum, 1600);
  assert.strictEqual(db.data.books[0].statReady, true, '一致时不动累计值');
  db.aggList = null;
});

test('dashboard：实时聚合失败退回累计值', async () => {
  seed([]);
  db.data.books[0].statCount = 1; db.data.books[0].statFen = 50000;
  db.aggList = a => { if (/"status":"paid"/.test(JSON.stringify(a.stages)) && !/payDay/.test(JSON.stringify(a.stages))) throw new Error('db busy'); return []; };
  const d = await dash(loadFunction('records'));
  assert.strictEqual(d.book.sum, 500);
  db.aggList = null;
});
