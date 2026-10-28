// v3.69.0：轮询减负（身份、其他礼簿个数、合计、往来红点缓存），warmer.hasPeak 减负（刷新档位套餐化的用例已随 v3.70.0 智能刷新移除）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction, ROOT } = require('./helpers/sdk-stub.js');

const OWNER = 'o-owner';
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function seedAcc(plansDoc, level) {
  db.reset().applyUpdates = true;
  db.seed('users', [{ _id: 'u1', openid: OWNER, pollLevel: level }])
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1', orgMode: false, accountName: '张府' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }])
    .seed('settings', plansDoc ? [{ _id: 'plans', ...plansDoc }] : []);
  state.openid = OWNER;
}
const acc = ev => loadFunction('account').main(ev);

// ---- 轮询减负
function seedRec() {
  db.reset();
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1', accountName: '张府' }])
    .seed('users', [{ openid: OWNER }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }, { _id: 'b2', ownerOpenid: OWNER }])
    .seed('records', [
      { _id: 'r1', ownerOpenid: OWNER, bookId: 'b1', status: 'transferred', amount: 100 },
      { _id: 'r2', ownerOpenid: OWNER, bookId: 'b2', status: 'transferred', amount: 200 }
    ]);
  state.openid = OWNER;
}
const reads = (col, op) => db.log.filter(l => l.col === col && (!op || l.op === op)).length;

test('pendingStat：带 aid 时 15 秒内复用身份；aid 不一致 / 不带 aid 时重新解析', async () => {
  seedRec();
  const fn = loadFunction('records');
  await fn.main({ action: 'pendingStat', aid: 'acc1' });
  db.log.length = 0;
  const r = await fn.main({ action: 'pendingStat', aid: 'acc1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(r.data.count, 1);
  assert.strictEqual(reads('users') + reads('members'), 0, '复用身份：不查 users / members');
  db.log.length = 0;
  await fn.main({ action: 'pendingStat', aid: 'other' });
  assert.ok(reads('users') > 0, 'aid 不一致：重新解析');
  db.log.length = 0;
  await fn.main({ action: 'pendingStat' });
  assert.ok(reads('users') > 0, '旧前端不带 aid：照常解析');
});

test('pendingStat：其他礼簿个数 30 秒内只查一次；合计在份数不变时不重新聚合；待确认列表刷新其他礼簿个数缓存', async () => {
  seedRec();
  const fn = loadFunction('records');
  const first = await fn.main({ action: 'pendingStat', aid: 'acc1' });
  assert.strictEqual(first.data.other, 1);
  db.log.length = 0;
  const again = await fn.main({ action: 'pendingStat', aid: 'acc1' });
  assert.strictEqual(again.data.other, 1);
  assert.strictEqual(reads('records', 'count'), 1, '只剩当前礼簿待确认计数');
  assert.strictEqual(reads('records', 'aggregate'), 0, '份数没变：沿用合计');
  // 新到一笔：份数变化 → 重新聚合
  db.data.records.push({ _id: 'r3', ownerOpenid: OWNER, bookId: 'b1', status: 'transferred', amount: 50 });
  db.log.length = 0;
  const changed = await fn.main({ action: 'pendingStat', aid: 'acc1' });
  assert.strictEqual(changed.data.count, 2);
  assert.strictEqual(reads('records', 'aggregate'), 1);
  // 待确认页拉列表：其他礼簿个数实时查询并写入缓存，之后轮询一致
  db.data.records.push({ _id: 'r4', ownerOpenid: OWNER, bookId: 'b2', status: 'transferred', amount: 1 });
  const list = await fn.main({ action: 'pending', aid: 'acc1' });
  assert.strictEqual(list.data.otherCount, 2);
  assert.strictEqual((await fn.main({ action: 'pendingStat', aid: 'acc1' })).data.other, 2);
});

test('pendingStat：往来红点 5 分钟缓存，rv 变化立即重算', async () => {
  seedRec();
  const fn = loadFunction('records');
  await fn.main({ action: 'pendingStat', aid: 'acc1', rv: '1' });
  db.log.length = 0;
  await fn.main({ action: 'pendingStat', aid: 'acc1', rv: '1' });
  assert.strictEqual(reads('reminders'), 0);
  await fn.main({ action: 'pendingStat', aid: 'acc1', rv: '2' });
  assert.strictEqual(reads('reminders'), 1);
});

test('前端轮询带 aid 与 rv；往来页刷新后更新 rv；角标刷新同样带上', () => {
  const req = read('miniprogram/utils/request.js');
  assert.ok(/pendingStat: \(\) => call\('records', \{ action: 'pendingStat', \.\.\.pollHint\(\) \}/.test(req));
  assert.ok(/recordStat: d => call\('records', \{ action: 'pendingStat', \.\.\.pollHint\(\)/.test(req));
  assert.ok(/action: 'pending', \.\.\.pollHint\(\)/.test(req));
  assert.ok(/remindVer = Date\.now\(\)/.test(read('miniprogram/pages/renqing/renqing.js')));
  assert.ok(/pollHint\(\)/.test(read('miniprogram/app.js')));
});

test('warmer.hasPeak：最多取 20 个、只取主家字段、按主家去重；system 索引清单含 accounts.peak 与 records.guest_retry', async () => {
  const HOUR = 3600 * 1000;
  db.reset().seed('subscriptions', [{ _id: 'y', plan: 'pro', expiresAt: new Date(Date.now() + HOUR) }])
    .seed('accounts', [{ _id: 'a1', ownerOpenid: 'y', peakUntil: new Date(Date.now() + HOUR) }, { _id: 'a2', ownerOpenid: 'y', peakUntil: new Date(Date.now() + HOUR) }]);
  const W = loadFunction('warmer')._test;
  assert.strictEqual(await W.hasPeak(), true);
  const q = db.log.find(l => l.col === 'accounts' && l.op === 'get');
  assert.strictEqual(q.limit, 20);
  assert.strictEqual(db.log.filter(l => l.col === 'subscriptions').length <= 1, true, '同一主家只读一次套餐');
  const sys = read('cloudfunctions/system/index.js');
  assert.ok(/\['accounts', 'peak', \[\['peakUntil', -1\]\]\]/.test(sys));
  assert.ok(/'records', 'guest_retry'/.test(sys));
});
