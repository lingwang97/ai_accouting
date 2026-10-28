// v3.66.0 体验修复（云端）：工作台带刷新档位、礼台一次调用完成同名检查、宾客「等待主家确认」一栏
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction } = require('./helpers/sdk-stub.js');

const OWNER = 'o-owner';
const HOUR = 3600 * 1000;

// ---- 工作台 dashboard 带 pollLevel / peakUntil，口径与 account.get 一致
function seedDash(opts) {
  const o = opts || {};
  db.reset().applyUpdates = true;
  db.seed('subscriptions', o.free ? [] : [{ _id: OWNER, plan: 'pro', expiresAt: new Date(Date.now() + 30 * 24 * HOUR) }])
    .seed('settings', o.free ? [{ _id: 'plans', free: { name: '免费版', features: { peakMode: false, fastRefresh: false } }, pro: { name: '专业版', features: {} } }] : [])
    .seed('users', [{ openid: OWNER, pollLevel: 'mid' }, { openid: 'c-desk', pollLevel: 'high' }, { openid: 'v1', pollLevel: 'high' }])
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1', accountName: '张府', peakUntil: new Date(Date.now() + HOUR) }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '礼簿', statReady: true }])
    .seed('members', [
      { _id: 'm1', aid: 'acc1', memberOpenid: 'c-desk', role: 'clerk', soloBookId: 'b1', perms: ['desk'] },
      { _id: 'm2', aid: 'acc1', memberOpenid: 'v1', role: 'viewer', bookIds: ['b1'] }
    ]);
}
const dash = async who => { state.openid = who; const r = await loadFunction('records').main({ action: 'dashboard' }); assert.strictEqual(r.code, 0, r.msg); return r.data; };
const accGet = async who => { state.openid = who; const r = await loadFunction('account').main({ action: 'get' }); assert.strictEqual(r.code, 0, r.msg); return r.data; };

test('dashboard 返回刷新档位与高峰到期，和 account.get 一致（会员主家 / 无确认权限记账人 / 家人 / 免费版）', async () => {
  seedDash();
  for (const who of [OWNER, 'c-desk', 'v1']) {
    const d = await dash(who), a = await accGet(who);
    assert.strictEqual(d.pollLevel, a.pollLevel, who);
    assert.strictEqual(d.peakUntil, a.peakUntil, who);
  }
  const d = await dash(OWNER);
  assert.strictEqual(d.pollLevel, 'off'); // v3.70.0 起恒为 off
  assert.ok(d.peakUntil > Date.now());
  assert.strictEqual((await dash('c-desk')).pollLevel, 'off'); // 没有确认收礼权限
  assert.strictEqual((await dash('v1')).peakUntil, 0);          // 家人只读
  seedDash({ free: true });
  const f = await dash(OWNER), fa = await accGet(OWNER);
  assert.deepStrictEqual([f.pollLevel, f.peakUntil], ['off', 0]);
  assert.deepStrictEqual([fa.pollLevel, fa.peakUntil], ['off', 0]);
});

// ---- 礼台记账：nameCheck:true 一次调用
function seedDesk() {
  db.reset().applyUpdates = true;
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '李府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, type: 'wedding', name: '婚宴', statReady: true }])
    .seed('records', []);
  db.persist = true;
}
// 记录 _id 已存在时 add 抛错（与真实数据库一致，幂等重试靠它）
const origCol = db.collection.bind(db);
async function withUniqueAdd(fn) {
  db.collection = name => {
    const c = origCol(name);
    if (name === 'records') {
      const add = c.add;
      c.add = async o => { if (o && o.data && o.data._id && (db.data.records || []).some(x => x._id === o.data._id)) throw new Error('duplicate key'); return add(o); };
    }
    return c;
  };
  try { await fn(); } finally { db.collection = origCol; db.aggList = null; }
}
const desk = ev => { state.openid = OWNER; return loadFunction('payment').main({ action: 'cashEntry', amount: 200, bookId: 'b1', ...ev }); };

test('礼台记账 nameCheck：没有同名直接入簿（一次调用）', async () => {
  seedDesk();
  db.aggList = () => [];
  await withUniqueAdd(async () => {
    const r = await desk({ payerName: '新人', nameCheck: true, reqId: 'req-new-0001' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(r.data.record && !r.data.needPick);
    assert.strictEqual(db.data.records.length, 1);
  });
});

test('礼台记账 nameCheck：有同名只返回名单、不入簿，名单不含 openid；选好后再提交入簿', async () => {
  seedDesk();
  db.aggList = a => (a.stages.some(s => s[0] === 'group')
    ? [{ _id: { name: '王五', openid: 'g-secret', tag: '', pk: undefined, bk: 'b1' }, count: 1, relation: '', lastDay: '2026-10-01', ref: 'r-old' }] : []);
  await withUniqueAdd(async () => {
    const r = await desk({ payerName: '王五', nameCheck: true, reqId: 'req-dup-0001' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.strictEqual(r.data.needPick, true);
    assert.strictEqual(db.data.records.length, 0); // 没有写入
    assert.ok(!JSON.stringify(r.data.map).includes('g-secret'));
    const r2 = await desk({ payerName: '王五', tag: '东村', reqId: 'req-dup-0002' });
    assert.strictEqual(r2.code, 0, r2.msg);
    assert.strictEqual(db.data.records.length, 1);
  });
});

test('礼台记账 nameCheck：同一 reqId 已入簿（上次结果没收到的重试）不再弹同名，按重复提交返回原记录', async () => {
  seedDesk();
  db.aggList = () => [];
  await withUniqueAdd(async () => {
    const r1 = await desk({ payerName: '赵六', nameCheck: true, reqId: 'req-retry-01' });
    assert.strictEqual(r1.code, 0);
    db.aggList = a => (a.stages.some(s => s[0] === 'group') ? [{ _id: { name: '赵六', openid: '', tag: '', bk: 'b1' }, count: 1, ref: r1.data.record._id }] : []);
    const r2 = await desk({ payerName: '赵六', nameCheck: true, reqId: 'req-retry-01' });
    assert.strictEqual(r2.code, 0, r2.msg);
    assert.ok(!r2.data.needPick);
    assert.strictEqual(r2.data.duplicate, true);
    assert.strictEqual(db.data.records.length, 1);
  });
});

// ---- 宾客：我的随礼记录「等待主家确认」
test('myReceipts.waiting：只返回本人扫码登记、待确认 / 未点完成的（3 天内），批次合一行，不带 openid', async () => {
  const now = Date.now();
  const r = (id, extra) => ({ _id: id, aid: 'acc1', ownerOpenid: OWNER, hostName: '', payerOpenid: 'g1', payerName: '张三', amount: 100, status: 'transferred', createdAt: new Date(now - HOUR), ...extra });
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '李府' }])
    .seed('records', [
      r('w1'),
      r('w2', { status: 'pending' }),
      r('b1', { batchId: 'B1', payerName: '甲', amount: 50 }),
      r('b2', { batchId: 'B1', payerName: '乙', amount: 60 }),
      r('old', { createdAt: new Date(now - 5 * 24 * HOUR) }),     // 太早
      r('other', { payerOpenid: 'g2' }),                           // 别人的
      r('paid', { status: 'paid', paidAt: new Date() }),           // 已入簿：在 list 里
      r('rej', { status: 'rejected' })
    ]);
  state.openid = 'g1';
  const res = await loadFunction('payment').main({ action: 'myReceipts' });
  assert.strictEqual(res.code, 0, res.msg);
  const w = res.data.waiting;
  assert.deepStrictEqual(w.map(x => x._id).sort(), ['b1', 'w1', 'w2']);
  const batch = w.find(x => x._id === 'b1');
  assert.strictEqual(batch.payerName, '甲 等 2 人');
  assert.strictEqual(batch.amount, 110);
  assert.strictEqual(w.find(x => x._id === 'w1').accountName, '李府');
  assert.ok(!/openid|g1|o-owner/i.test(JSON.stringify(w)));
  assert.deepStrictEqual(res.data.list.map(x => x._id), ['paid']);
});
