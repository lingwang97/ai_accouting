// v3.61.0 高级功能：待确认刷新频率（poller 固定间隔 / 30 分钟退回 / kick 恢复；取值校验；套餐 feature 关闭按 off）
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction } = require('./helpers/sdk-stub.js');
const P = require('../tools/cloud-shared/plans.js');
const poller = require('../miniprogram/utils/poller.js');

// ---- poller：用假定时器与假时钟驱动
function harness(opt) {
  const realST = global.setTimeout, realCT = global.clearTimeout, realNow = Date.now;
  let now = 1e12, pending = null;
  global.setTimeout = (fn, ms) => { pending = { fn, ms }; return pending; };
  global.clearTimeout = () => { pending = null; };
  Date.now = () => now;
  let change = false;
  const p = poller.create(async () => change, opt);
  return {
    p,
    advance(ms) { now += ms; },
    setChange(v) { change = v; },
    async tick() { const t = pending; assert.ok(t, '没有待执行的定时器'); pending = null; await t.fn(); },
    next() { return pending && pending.ms; },
    restore() { global.setTimeout = realST; global.clearTimeout = realCT; Date.now = realNow; }
  };
}

test('poller fast：连续无变化也固定间隔，不做 1 分钟放慢', async () => {
  const h = harness({ base: 10000, fast: 3000 });
  try {
    h.p.start();
    for (let i = 0; i < 40; i++) { assert.strictEqual(h.next(), 3000); h.advance(3000); await h.tick(); }
    assert.strictEqual(h.next(), 3000);
  } finally { h.restore(); }
});

test('poller fast：30 分钟没有变化退回标准行为（放慢），有变化立即恢复', async () => {
  const h = harness({ base: 10000, fast: 5000 });
  try {
    h.p.start();
    for (let i = 0; i < 13; i++) { h.advance(5000); await h.tick(); } // 累计 65 秒无变化，仍是 fast
    assert.strictEqual(h.next(), 5000);
    h.advance(poller.FAST_IDLE_MS); await h.tick();
    assert.ok(h.next() >= 30000, '退回标准：深度放慢 ' + h.next());
    h.setChange(true); h.advance(1000); await h.tick(); // 有新转账
    h.setChange(false);
    assert.strictEqual(h.next(), 5000, '有变化后恢复所选速度');
  } finally { h.restore(); }
});

test('poller fast：kick（用户操作）恢复所选速度；不设 fast 时行为不变', async () => {
  const h = harness({ base: 10000, fast: 8000 });
  try {
    h.p.start();
    h.advance(poller.FAST_IDLE_MS + 1000); await h.tick();
    assert.ok(h.next() > 8000);
    h.p.kick();
    assert.strictEqual(h.next(), 8000);
  } finally { h.restore(); }
  const g = harness({ base: 10000 });
  try {
    g.p.start();
    assert.strictEqual(g.next(), 10000);
    for (let i = 0; i < 12; i++) { g.advance(10000); await g.tick(); }
    assert.strictEqual(g.next(), 30000, '默认：约 1 分钟无变化放慢到 3 倍');
  } finally { g.restore(); }
});

test('poller：slow:false（只读家人）固定 base，fast 不影响', async () => {
  const h = harness({ base: 30000, slow: false, fast: 0 });
  try { h.p.start(); assert.strictEqual(h.next(), 30000); } finally { h.restore(); }
});

// ---- 取值校验 / 套餐
test('plans：档位白名单，非法值按 off', () => {
  assert.deepStrictEqual(P.POLL_LEVELS, ['off', 'low', 'mid', 'high']);
  ['low', 'mid', 'high', 'off'].forEach(v => assert.strictEqual(P.normalizePollLevel(v), v));
  [undefined, null, '', 'HIGH', 'fast', 3000, {}, ['high']].forEach(v => assert.strictEqual(P.normalizePollLevel(v), 'off'));
});

test('plans：fastRefresh 默认 free / pro 都开放；关闭时有效档位为 off；缺项视为开放', () => {
  assert.strictEqual(P.DEFAULT_PLANS.free.features.fastRefresh, true);
  assert.strictEqual(P.DEFAULT_PLANS.pro.features.fastRefresh, true);
  assert.strictEqual(P.effectivePollLevel('high', { fastRefresh: true }), 'high');
  assert.strictEqual(P.effectivePollLevel('high', { fastRefresh: false }), 'off');
  assert.strictEqual(P.effectivePollLevel('high', {}), 'high', '管理员旧套餐文档没有该项');
  assert.strictEqual(P.effectivePollLevel('bad', {}), 'off');
});

// ---- account：保存 / 读取
const OWNER = 'o-owner';
function seed(plansDoc, members) {
  db.reset().applyUpdates = true;
  db.seed('users', [{ _id: 'u1', openid: OWNER, pollLevel: 'mid' }, { _id: 'u2', openid: 'c1', pollLevel: 'high' }, { _id: 'u3', openid: 'v1', pollLevel: 'high' }])
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1', orgMode: false, accountName: '张府' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }])
    .seed('members', members || [])
    .seed('settings', plansDoc ? [{ _id: 'plans', ...plansDoc }] : []);
}
const call = (openid, ev) => { state.openid = openid; return loadFunction('account').main(ev); };
const updates = () => db.log.filter(l => l.op === 'update' && l.col === 'users');
// 全部开放的套餐文档（features 缺 refreshMinSec = 3 秒可用）；v3.69.0 起默认免费版最快 8 秒，见 v3690.test.js
const OPEN_PLANS = { free: { name: '免费版', features: {} }, pro: { name: '专业版', features: {} } };
const OFF_PLANS = { free: { name: '免费版', features: { fastRefresh: false } }, pro: { name: '专业版', features: { fastRefresh: false } } };
const CLERK_DESK = { _id: 'm1', aid: 'acc1', memberOpenid: 'c1', role: 'clerk', soloBookId: 'b1', perms: ['desk'] };
const VIEWER = { _id: 'm2', aid: 'acc1', memberOpenid: 'v1', role: 'viewer', bookIds: ['b1'] };

test('account.get：主家返回已保存的档位', async () => {
  seed(OPEN_PLANS);
  const r = await call(OWNER, { action: 'get' });
  assert.strictEqual(r.data.pollLevel, 'mid');
});

test('account.get：套餐关闭 fastRefresh 时按 off', async () => {
  seed(OFF_PLANS);
  const r = await call(OWNER, { action: 'get' });
  assert.strictEqual(r.data.pollLevel, 'off');
});

test('account.get：家人共享、没有确认权限的记账人按 off；有确认权限的记账人按保存值', async () => {
  seed(null, [CLERK_DESK, VIEWER]);
  assert.strictEqual((await call('c1', { action: 'get' })).data.pollLevel, 'off');
  assert.strictEqual((await call('v1', { action: 'get' })).data.pollLevel, 'off');
  seed(OPEN_PLANS, [{ ...CLERK_DESK, perms: ['confirm'] }]);
  assert.strictEqual((await call('c1', { action: 'get' })).data.pollLevel, 'high');
});

test('account.setPollLevel：合法值写入当前用户；非法值拒绝且不写库', async () => {
  seed(OPEN_PLANS);
  const r = await call(OWNER, { action: 'setPollLevel', level: 'high' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.pollLevel, 'high');
  const u = updates().pop();
  assert.strictEqual(u.cond.openid, OWNER);
  assert.deepStrictEqual(u.data, { pollLevel: 'high' });
  const n = updates().length;
  for (const bad of ['fast', '', undefined, 3000, 'HIGH']) {
    const x = await call(OWNER, { action: 'setPollLevel', level: bad });
    assert.notStrictEqual(x.code, 0, String(bad));
  }
  assert.strictEqual(updates().length, n);
});

test('account.setPollLevel：套餐关闭时拒绝高档，但可以改回 off', async () => {
  seed(OFF_PLANS);
  const x = await call(OWNER, { action: 'setPollLevel', level: 'low' });
  assert.notStrictEqual(x.code, 0);
  assert.ok(/会员/.test(x.msg), x.msg);
  assert.strictEqual(updates().length, 0);
  const y = await call(OWNER, { action: 'setPollLevel', level: 'off' });
  assert.strictEqual(y.code, 0);
});

test('account.setPollLevel：家人共享 / 无确认权限的记账人不能设置', async () => {
  seed(null, [CLERK_DESK, VIEWER]);
  assert.notStrictEqual((await call('c1', { action: 'setPollLevel', level: 'low' })).code, 0);
  assert.notStrictEqual((await call('v1', { action: 'setPollLevel', level: 'low' })).code, 0);
  assert.strictEqual(updates().length, 0);
});
