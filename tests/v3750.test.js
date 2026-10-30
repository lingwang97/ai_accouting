// v3.75.0 payment.status 实例内 3 秒缓存：命中、过期、写后失效、不同 openid 不命中、Map 上限
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction } = require('./helpers/sdk-stub.js');

const OWNER = 'o-owner';
function seed(records) {
  db.reset().applyUpdates = true;
  sdk.openapi.subscribeMessage = { send: async () => {} };
  sdk.openapi.security = { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) };
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER, nickname: '主家' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜', type: 'wedding' }])
    .seed('records', records);
}
const rec = (id, extra) => ({ _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', payerOpenid: 'g1', payerName: '王五', amount: 600, payMethod: 'wechat', status: 'transferred', createdAt: new Date(), transferredAt: new Date(), ...extra });
/** 同一个已加载的实例（缓存在模块里）：连续调用 */
function inst() {
  const m = loadFunction('payment');
  return { m, call: (ev, id) => { state.openid = id || 'g1'; return m.main(ev); } };
}
const st = (i, id) => i.call({ action: 'status', rid: 'r1' }, id);

test('status 缓存：3 秒内命中不读库（库里被改了仍返回旧值），过期后重新读', async () => {
  seed([rec('r1')]);
  const i = inst();
  const realNow = Date.now; let now = realNow();
  Date.now = () => now;
  try {
    assert.strictEqual((await st(i)).data.status, 'transferred');
    db.data.records[0].status = 'paid'; // 绕过云函数直接改库，模拟别的实例的写入
    now += 2900;
    assert.strictEqual((await st(i)).data.status, 'transferred', '3 秒内命中缓存');
    now += 200;
    assert.strictEqual((await st(i)).data.status, 'paid', '过期后重新读库');
  } finally { Date.now = realNow; }
});

test('status 缓存：本实例内写操作（cancel / transferred / confirm / reject 等）后立即失效', async () => {
  seed([rec('r1', { status: 'pending' })]);
  const i = inst();
  assert.strictEqual((await st(i)).data.status, 'pending');
  assert.strictEqual((await i.call({ action: 'transferred', rid: 'r1' })).code, 0);
  assert.strictEqual((await st(i)).data.status, 'transferred', '宾客转账后立刻看到新状态');
  assert.strictEqual((await st(i)).data.status, 'transferred');
  state.openid = OWNER;
  assert.strictEqual((await i.m.main({ action: 'reject', rid: 'r1', reason: 'nofound' })).code, 0);
  assert.strictEqual((await st(i)).data.status, 'rejected', '主家标记未收到后立刻失效');
  // 读操作不清缓存；其他 action 一律视为写
  const keep = i.m._test.statusCache.size();
  await i.call({ action: 'myReceipts' });
  assert.strictEqual(i.m._test.statusCache.size(), keep);
  await i.call({ action: 'cancel', rid: 'r1' }); // 即使失败的写操作也清空
  assert.strictEqual(i.m._test.statusCache.size(), 0);
});

test('status 缓存：不同 openid 不共享，无权的人不会命中别人的缓存', async () => {
  seed([rec('r1')]);
  const i = inst();
  assert.strictEqual((await st(i, 'g1')).code, 0);
  const r = await st(i, 'g9');
  assert.notStrictEqual(r.code, 0, '陌生人查不到');
  assert.strictEqual(r.data, null);
  assert.strictEqual((await st(i, 'g1')).code, 0, '本人仍可命中');
  assert.ok(!JSON.stringify(await st(i, 'g1')).includes('g1'), '缓存的结果不含 openid');
});

test('status 缓存：出错结果不缓存；Map 上限 2000，先清过期、再删最早', () => {
  const C = require('../cloudfunctions/payment/statuscache.js');
  C.clear();
  assert.strictEqual(C.TTL_MS, 3000);
  for (let k = 0; k < 2000; k++) C.set('o', 'r' + k, { v: k }, 1000);
  assert.strictEqual(C.size(), 2000);
  C.set('o', 'new', { v: 'n' }, 1500); // 都未过期：删最早的 r0
  assert.strictEqual(C.size(), 2000);
  assert.strictEqual(C.get('o', 'r0', 1500), null);
  assert.deepStrictEqual(C.get('o', 'r1', 1500), { v: 1 });
  C.set('o', 'new2', { v: 'n2' }, 5000); // 此时前面都已过期：全部清掉
  assert.strictEqual(C.size(), 1);
  assert.strictEqual(C.get('o', 'new2', 8000), null, '到期即失效');
  C.clear();
});
