// v3.64.0 办事日高峰模式（刷新 3 秒 + 预热 + 8 小时自动恢复）与传统礼簿 PDF 笔数上限随套餐
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction } = require('./helpers/sdk-stub.js');
const P = require('../tools/cloud-shared/plans.js');
const A = require('../miniprogram/utils/advperm.js');
const poller = require('../miniprogram/utils/poller.js');

const OWNER = 'o-owner';
const HOUR = 3600 * 1000;

// ---- poller：hold 期间不退回标准行为
function harness(opt) {
  const realST = global.setTimeout, realCT = global.clearTimeout, realNow = Date.now;
  let now = 1e12, pending = null;
  global.setTimeout = (fn, ms) => { pending = { fn, ms }; return pending; };
  global.clearTimeout = () => { pending = null; };
  Date.now = () => now;
  const p = poller.create(async () => false, opt);
  return {
    p,
    advance(ms) { now += ms; },
    async tick() { const t = pending; pending = null; await t.fn(); },
    next() { return pending && pending.ms; },
    restore() { global.setTimeout = realST; global.clearTimeout = realCT; Date.now = realNow; }
  };
}

test('poller hold：高峰期间长时间没有变化仍固定 3 秒，优先于加速窗口；hold 结束后退回（v3.70.0 智能刷新）', async () => {
  poller.resetBoost();
  let holding = true;
  const h = harness({ base: 10000, boost: 5000, peak: 3000, hold: () => holding });
  try {
    h.p.start();
    assert.strictEqual(h.next(), 3000);
    h.advance(2 * 3600 * 1000); await h.tick();
    assert.strictEqual(h.next(), 3000, '高峰期间不放慢');
    holding = false; // 高峰结束，没有新转账：标准深度放慢
    h.advance(1000); await h.tick();
    assert.ok(h.next() >= 30000, '退回标准的放慢行为：' + h.next());
  } finally { h.restore(); poller.resetBoost(); }
});

// ---- plans
test('plans：bookMaxOf 缺项 3000，设了取值，最高 10000；默认 free 3000 / pro 6000；peakMode 仅 pro', () => {
  assert.strictEqual(P.bookMaxOf({}), 3000);
  assert.strictEqual(P.bookMaxOf(undefined), 3000);
  assert.strictEqual(P.bookMaxOf({ bookMax: 0 }), 3000);
  assert.strictEqual(P.bookMaxOf({ bookMax: 'x' }), 3000);
  assert.strictEqual(P.bookMaxOf({ bookMax: 6000 }), 6000);
  assert.strictEqual(P.bookMaxOf({ bookMax: 99999 }), 10000);
  assert.strictEqual(P.bookMaxOf(P.DEFAULT_PLANS.free.features), 3000);
  assert.strictEqual(P.bookMaxOf(P.DEFAULT_PLANS.pro.features), 6000);
  assert.strictEqual(P.DEFAULT_PLANS.free.features.peakMode, false, 'v3.65.1 起高峰模式仅会员');
  assert.strictEqual(P.DEFAULT_PLANS.pro.features.peakMode, true);
  assert.strictEqual(P.PEAK_HOURS, 8);
  assert.strictEqual(P.normalizeWarmup({ mode: 'peak' }).mode, 'peak');
  assert.strictEqual(P.normalizeWarmup({ mode: 'always' }).mode, 'always');
  assert.strictEqual(P.normalizeWarmup({ mode: 'xx' }).mode, 'paid');
});

test('advperm.peakItem：主家可开关；记账人跟随；套餐关闭时不能开启但已开启的能关；剩余时间文案', () => {
  const now = 1e12;
  const off = A.peakItem({ role: 'owner', features: {}, peakUntil: 0, now });
  assert.ok(off.enabled && !off.on && !off.vip);
  const on = A.peakItem({ role: 'owner', features: {}, peakUntil: now + 7 * HOUR + 30 * 60000, now });
  assert.ok(on.enabled && on.on);
  assert.strictEqual(on.leftText, '7 小时 30 分钟');
  assert.strictEqual(A.peakItem({ role: 'owner', features: {}, peakUntil: now + 20 * 60000, now }).leftText, '20 分钟');
  assert.strictEqual(A.peakItem({ role: 'owner', features: {}, peakUntil: now - 1, now }).on, false, '已到期');
  const closed = A.peakItem({ role: 'owner', features: { peakMode: false }, peakUntil: 0, now });
  assert.ok(!closed.enabled && closed.vip && closed.contact);
  assert.ok(A.peakItem({ role: 'owner', features: { peakMode: false }, peakUntil: now + HOUR, now }).enabled, '已开启时可关闭');
  const clerk = A.peakItem({ role: 'clerk', features: {}, peakUntil: 0, now });
  assert.ok(!clerk.enabled && !clerk.contact && /主家/.test(clerk.reason));
  assert.ok(!A.peakItem({ role: 'viewer', features: {}, peakUntil: 0, now }).enabled);
});

// ---- account
const plansDoc = f => [{ _id: 'plans', free: { name: '免费版', features: f }, pro: { name: '专业版', features: {} } }];
const CLERK_CONFIRM = { _id: 'm1', aid: 'acc1', memberOpenid: 'c1', role: 'clerk', soloBookId: 'b1', perms: ['confirm'] };
const CLERK_DESK = { _id: 'm2', aid: 'acc1', memberOpenid: 'c2', role: 'clerk', soloBookId: 'b1', perms: ['desk'] };
const VIEWER = { _id: 'm3', aid: 'acc1', memberOpenid: 'v1', role: 'viewer', bookIds: ['b1'] };
// 默认主家是会员（有效 pro 订阅）；free = true 时是免费版（没有订阅）
function seed(features, peakUntil, free) {
  db.reset().applyUpdates = true;
  db.seed('subscriptions', free ? [] : [{ _id: OWNER, plan: 'pro', expiresAt: new Date(Date.now() + 30 * 24 * HOUR) }]);
  db.seed('users', [{ openid: OWNER, pollLevel: 'low' }, { openid: 'c1' }, { openid: 'c2' }, { openid: 'v1' }])
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1', accountName: '张府', ...(peakUntil ? { peakUntil } : {}) }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '礼簿' }])
    .seed('members', [CLERK_CONFIRM, CLERK_DESK, VIEWER])
    .seed('settings', features ? plansDoc(features) : []);
}
const call = (openid, ev) => { state.openid = openid; return loadFunction('account').main(ev); };

test('account.setPeak：主家开启写入 8 小时后到期；关闭清除；只有主家', async () => {
  seed();
  const t0 = Date.now();
  const r = await call(OWNER, { action: 'setPeak', on: true });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(Math.abs(r.data.peakUntil - (t0 + 8 * HOUR)) < 5000);
  const off = await call(OWNER, { action: 'setPeak', on: false });
  assert.strictEqual(off.data.peakUntil, 0);
  for (const who of ['c1', 'c2', 'v1']) {
    assert.notStrictEqual((await call(who, { action: 'setPeak', on: true })).code, 0, who);
  }
});

test('account.setPeak：套餐关闭 peakMode 时不能开启，但可以关闭', async () => {
  seed({ peakMode: false }, 0, true);
  const r = await call(OWNER, { action: 'setPeak', on: true });
  assert.notStrictEqual(r.code, 0);
  assert.ok(/会员/.test(r.msg));
  assert.strictEqual((await call(OWNER, { action: 'setPeak', on: false })).code, 0);
});

test('account.get：peakUntil 只给主家与有确认权限的记账人；到期 / 套餐关闭 / 家人 / 无权限为 0；pollLevel 恒 off', async () => {
  const until = Date.now() + 3 * HOUR;
  seed(null, new Date(until));
  let r = await call(OWNER, { action: 'get' });
  assert.strictEqual(r.data.peakUntil, until);
  assert.strictEqual(r.data.pollLevel, 'off', 'v3.70.0 起没有手动档位，恒为 off');
  assert.strictEqual((await call('c1', { action: 'get' })).data.peakUntil, until, '有确认权限的记账人跟随主家');
  assert.strictEqual((await call('c2', { action: 'get' })).data.peakUntil, 0);
  assert.strictEqual((await call('v1', { action: 'get' })).data.peakUntil, 0);
  seed(null, new Date(Date.now() - 1000));
  assert.strictEqual((await call(OWNER, { action: 'get' })).data.peakUntil, 0, '已到期');
  seed({ peakMode: false }, new Date(until), true);
  assert.strictEqual((await call(OWNER, { action: 'get' })).data.peakUntil, 0, '套餐关闭后不再生效');
  seed();
  assert.strictEqual((await call(OWNER, { action: 'get' })).data.peakUntil, 0);
});

test('免费版（默认套餐）：setPeak 被拒并提示「高峰模式属于会员功能」，不写库；会员正常；免费版能关闭', async () => {
  seed(null, 0, true);
  const r = await call(OWNER, { action: 'setPeak', on: true });
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(r.msg, '高峰模式属于会员功能');
  assert.ok(!db.data.accounts[0].peakUntil);
  assert.strictEqual((await call(OWNER, { action: 'setPeak', on: false })).code, 0, '关闭始终可以');
  seed(null, 0, false);
  assert.strictEqual((await call(OWNER, { action: 'setPeak', on: true })).code, 0, '会员可开启');
});

test('免费版：遗留的 peakUntil 读取时无效（account.get 为 0）；会员有效', async () => {
  const until = Date.now() + 3 * HOUR;
  seed(null, new Date(until), true);
  let r = await call(OWNER, { action: 'get' });
  assert.strictEqual(r.data.peakUntil, 0);
  assert.strictEqual(r.data.pollLevel, 'off');
  assert.strictEqual((await call('c1', { action: 'get' })).data.peakUntil, 0, '记账人跟随主家的免费状态');
  seed(null, new Date(until), false);
  r = await call(OWNER, { action: 'get' });
  assert.strictEqual(r.data.peakUntil, until);
  assert.strictEqual((await call('c1', { action: 'get' })).data.peakUntil, until);
});

test('advperm.peakItem：免费版（peakMode false）开关置灰 + 会员标签 + 联系我们', () => {
  const r = A.peakItem({ role: 'owner', features: P.DEFAULT_PLANS.free.features, peakUntil: 0, now: 1e12 });
  assert.ok(!r.enabled && r.vip && r.contact);
  const pro = A.peakItem({ role: 'owner', features: P.DEFAULT_PLANS.pro.features, peakUntil: 0, now: 1e12 });
  assert.ok(pro.enabled && !pro.vip);
});

// ---- warmer：有人开高峰才预热
test('warmer.hasPeak：只数未到期的 accounts.peakUntil', async () => {
  db.reset().seed('accounts', [{ _id: 'a1', ownerOpenid: 'x' }]);
  const W = loadFunction('warmer')._test;
  assert.strictEqual(await W.hasPeak(), false);
  const member = o => ({ _id: o, plan: 'pro', expiresAt: new Date(Date.now() + 30 * 24 * HOUR) });
  db.reset().seed('subscriptions', [member('y')]).seed('accounts', [{ _id: 'a1', ownerOpenid: 'x', peakUntil: new Date(Date.now() - 1000) }, { _id: 'a2', ownerOpenid: 'y', peakUntil: new Date(Date.now() + HOUR) }]);
  assert.strictEqual(await W.hasPeak(), true);
  db.reset().seed('accounts', [{ _id: 'a2', ownerOpenid: 'free1', peakUntil: new Date(Date.now() + HOUR) }]);
  assert.strictEqual(await W.hasPeak(), false, '免费版遗留的 peakUntil 不触发预热');
  db.reset().seed('accounts', [{ _id: 'a1', ownerOpenid: 'x', peakUntil: new Date(Date.now() - 1000) }]);
  assert.strictEqual(await W.hasPeak(), false);
});

async function warmRun(mode, opts) {
  db.reset();
  db.seed('settings', [{ _id: 'warmup', enabled: true, mode, intervalMin: 5, functions: ['account'] }])
    .seed('subscriptions', (opts.paid ? [{ _id: 'o1', plan: 'pro', expiresAt: new Date(Date.now() + HOUR) }] : []).concat(opts.peak ? [{ _id: 'x', plan: 'pro', expiresAt: new Date(Date.now() + HOUR) }] : []))
    .seed('accounts', opts.peak ? [{ _id: 'a1', ownerOpenid: 'x', peakUntil: new Date(Date.now() + HOUR) }] : []);
  state.calls.length = 0;
  state.openid = ''; // 定时触发没有用户身份
  const W = loadFunction('warmer');
  await W.main({ Type: 'Timer', TriggerName: 'warm' });
  return state.calls.filter(c => c.data && c.data.action === '__warm').length;
}

test('warmer 预热模式：paid = 付费订阅或高峰；peak = 仅高峰；always 始终', async () => {
  // 预热只在 5 分钟整点轮次执行（见 warmer 的间隔判断），测试里无论哪个整点轮次 intervalMin=5 都会执行
  assert.strictEqual(await warmRun('paid', { paid: false, peak: false }), 0);
  assert.strictEqual(await warmRun('paid', { paid: true, peak: false }), 1);
  assert.strictEqual(await warmRun('paid', { paid: false, peak: true }), 1, '免费用户开高峰也预热');
  assert.strictEqual(await warmRun('peak', { paid: true, peak: false }), 0, 'peak 模式有付费也不预热');
  assert.strictEqual(await warmRun('peak', { paid: false, peak: true }), 1);
  assert.strictEqual(await warmRun('always', { paid: false, peak: false }), 1);
});
