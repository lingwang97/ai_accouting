// v3.70.0 智能刷新（取代 v3.61.0 起的手动「工作台刷新频率」档位）：
// poller 有变化后 10 分钟 5 秒、窗口过后回落标准放慢、高峰 hold 优先、kick 回到标准 10 秒；服务端 pollLevel 恒为 off；setPollLevel 兼容旧前端
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
  poller.resetBoost();
  let change = false;
  const p = poller.create(async () => change, opt);
  return {
    p,
    advance(ms) { now += ms; },
    setChange(v) { change = v; },
    async tick() { const t = pending; assert.ok(t, '没有待执行的定时器'); pending = null; await t.fn(); },
    next() { return pending && pending.ms; },
    restore() { global.setTimeout = realST; global.clearTimeout = realCT; Date.now = realNow; poller.resetBoost(); }
  };
}
const STD = { base: 10000, boost: 5000, peak: 3000, hold: () => false };

test('智能刷新：没有变化按标准（10 秒起，约 1 分钟后放慢，5 分钟后 60 秒）', async () => {
  const h = harness(STD);
  try {
    h.p.start();
    assert.strictEqual(h.next(), 10000);
    for (let i = 0; i < 6; i++) { h.advance(h.next()); await h.tick(); }
    assert.strictEqual(h.next(), 20000);
    for (let i = 0; i < 6; i++) { h.advance(h.next()); await h.tick(); }
    assert.strictEqual(h.next(), 30000);
    h.advance(5 * 60 * 1000); await h.tick();
    assert.strictEqual(h.next(), 60000);
  } finally { h.restore(); }
});

test('智能刷新：检测到变化后 10 分钟内固定 5 秒（期间没有新变化也不放慢），窗口过后回落标准放慢', async () => {
  const h = harness(STD);
  try {
    h.p.start();
    h.setChange(true); h.advance(10000); await h.tick(); h.setChange(false);
    assert.strictEqual(h.next(), 5000);
    let t = 0;
    while (t + 5000 < poller.BOOST_WINDOW_MS) { h.advance(5000); t += 5000; await h.tick(); assert.strictEqual(h.next(), 5000, '窗口内 ' + t); }
    h.advance(10000); await h.tick(); // 窗口已过
    assert.ok(h.next() >= 30000, '回落到标准的放慢：' + h.next());
    assert.ok(!poller.boosting());
  } finally { h.restore(); }
});

test('智能刷新：窗口内又有变化，从这次变化起再延长 10 分钟', async () => {
  const h = harness(STD);
  try {
    h.p.start();
    h.setChange(true); h.advance(10000); await h.tick();
    h.advance(8 * 60 * 1000); await h.tick(); // 8 分钟后又一笔
    h.setChange(false);
    h.advance(5 * 60 * 1000); await h.tick();  // 距第一次 13 分钟、距第二次 5 分钟
    assert.strictEqual(h.next(), 5000);
  } finally { h.restore(); }
});

test('kick（用户操作 / 回到页面）：恢复标准 10 秒，不是 5 秒；加速窗口有效时仍是 5 秒', async () => {
  const h = harness(STD);
  try {
    h.p.start();
    h.advance(6 * 60 * 1000); await h.tick();
    assert.strictEqual(h.next(), 60000);
    h.p.kick();
    assert.strictEqual(h.next(), 10000, '没有加速窗口：kick 回到 10 秒');
    h.setChange(true); h.advance(10000); await h.tick(); h.setChange(false);
    h.p.kick();
    assert.strictEqual(h.next(), 5000, '加速窗口有效：kick 后仍 5 秒');
  } finally { h.restore(); }
});

test('高峰模式（hold）优先级最高：固定 3 秒，加速窗口内也是 3 秒；hold 结束后窗口仍有效则 5 秒', async () => {
  let holding = true;
  const h = harness({ ...STD, hold: () => holding });
  try {
    h.p.start();
    assert.strictEqual(h.next(), 3000);
    h.setChange(true); h.advance(3000); await h.tick(); h.setChange(false);
    assert.strictEqual(h.next(), 3000);
    holding = false;
    h.advance(3000); await h.tick();
    assert.strictEqual(h.next(), 5000);
  } finally { h.restore(); }
});

test('加速窗口跨页面共享：一个页面检测到变化，另一个页面的轮询也按 5 秒；不加速的（boost 0）不受影响', async () => {
  const h = harness(STD);
  try {
    h.p.start();
    h.setChange(true); h.advance(10000); await h.tick();
    const other = poller.create(async () => false, STD);
    assert.strictEqual(other.nextMs, 5000);
    const noBoost = poller.create(async () => false, { base: 10000, boost: 0 });
    assert.strictEqual(noBoost.nextMs, 10000, '没有确认权限：不加速');
  } finally { h.restore(); }
});

test('只读家人（slow:false）固定 30 秒，不加速、不触发加速窗口；boost / peak 可传函数', async () => {
  const h = harness({ base: 30000, slow: false, boost: 5000 });
  try {
    h.p.start();
    assert.strictEqual(h.next(), 30000);
    h.setChange(true); h.advance(30000); await h.tick();
    assert.strictEqual(h.next(), 30000);
    assert.ok(!poller.boosting(), '只读不开启加速窗口');
  } finally { h.restore(); }
  let ms = 0;
  const g = harness({ base: 10000, boost: () => ms });
  try {
    g.p.start();
    g.setChange(true); g.advance(10000); await g.tick();
    assert.strictEqual(g.next(), 10000, '冷启动身份未知：不加速');
    ms = 5000;
    g.setChange(true); g.advance(10000); await g.tick();
    assert.strictEqual(g.next(), 5000, '身份确定后按函数取值');
  } finally { g.restore(); }
});

// ---- 服务端：手动档位已废弃
test('plans：档位白名单与 fastRefresh / refreshMinSec 字段保留（兼容旧前端参数与旧 settings/plans 文档）', () => {
  assert.deepStrictEqual(P.POLL_LEVELS, ['off', 'low', 'mid', 'high']);
  [undefined, null, '', 'HIGH', 'fast', 3000].forEach(v => assert.strictEqual(P.normalizePollLevel(v), 'off'));
  assert.strictEqual(P.DEFAULT_PLANS.free.features.fastRefresh, true);
  assert.ok('refreshMinSec' in P.DEFAULT_PLANS.free.features);
});

const OWNER = 'o-owner';
function seed(members) {
  db.reset().applyUpdates = true;
  db.seed('users', [{ _id: 'u1', openid: OWNER, pollLevel: 'high' }, { _id: 'u2', openid: 'c1', pollLevel: 'high' }, { _id: 'u3', openid: 'v1', pollLevel: 'high' }])
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1', orgMode: false, accountName: '张府' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, statReady: true }])
    .seed('members', members || [])
    .seed('settings', [{ _id: 'plans', free: { name: '免费版', features: {} }, pro: { name: '专业版', features: {} } }]);
}
const call = (openid, ev) => { state.openid = openid; return loadFunction('account').main(ev); };
const updates = () => db.log.filter(l => l.op === 'update' && l.col === 'users');
const CLERK = { _id: 'm1', aid: 'acc1', memberOpenid: 'c1', role: 'clerk', soloBookId: 'b1', perms: ['confirm'] };

test('account.get / dashboard：pollLevel 恒为 off（库里存过 3 秒的旧值不再生效，旧前端也按标准刷新）', async () => {
  seed([CLERK]);
  assert.strictEqual((await call(OWNER, { action: 'get' })).data.pollLevel, 'off');
  assert.strictEqual((await call('c1', { action: 'get' })).data.pollLevel, 'off');
  state.openid = OWNER;
  const d = await loadFunction('records').main({ action: 'dashboard' });
  assert.strictEqual(d.code, 0, d.msg);
  assert.strictEqual(d.data.pollLevel, 'off');
});

test('account.setPollLevel（旧前端兼容）：合法值返回成功但恒为 off、不写库；非法值 / 无权限仍拒绝', async () => {
  seed([{ ...CLERK, perms: ['desk'] }, { _id: 'm2', aid: 'acc1', memberOpenid: 'v1', role: 'viewer', bookIds: ['b1'] }]);
  const r = await call(OWNER, { action: 'setPollLevel', level: 'high' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(r.data.pollLevel, 'off');
  assert.strictEqual(updates().length, 0, '不写 users.pollLevel');
  assert.notStrictEqual((await call(OWNER, { action: 'setPollLevel', level: 'fast' })).code, 0);
  assert.notStrictEqual((await call('c1', { action: 'setPollLevel', level: 'low' })).code, 0);
  assert.notStrictEqual((await call('v1', { action: 'setPollLevel', level: 'low' })).code, 0);
});

test('前端：pollcfg 只剩高峰到期与加速 / 高峰间隔；页面不再读手动档位', () => {
  const fs = require('fs'), path = require('path');
  const root = path.join(__dirname, '..', 'miniprogram');
  const cfg = fs.readFileSync(path.join(root, 'utils', 'pollcfg.js'), 'utf8');
  assert.ok(!/LEVELS|function level\(/.test(cfg));
  ['pages/index/index.js', 'pages/pending/pending.js', 'pages/records/records.js'].forEach(f => {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(/boost: pollcfg\.boostMs, peak: pollcfg\.peakMs, hold: pollcfg\.peakOn/.test(s), f);
    assert.ok(!/pollcfg\.ms\(\)|pollcfg\.level\(\)/.test(s), f);
  });
  assert.ok(!/setPollLevel/.test(fs.readFileSync(path.join(root, 'utils', 'request.js'), 'utf8')));
});

test('常见问题与教程：写智能刷新 + 高峰模式，不再提「工作台刷新频率」档位', () => {
  const fs = require('fs'), path = require('path');
  const g = f => fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'guide', f), 'utf8');
  const faq = g('faq.js'), guide = g('guide.js');
  assert.ok(/智能刷新/.test(faq) && /10 分钟每 5 秒/.test(faq) && /办事日高峰模式/.test(faq));
  assert.ok(!/工作台刷新频率/.test(faq + guide));
  assert.ok(/智能刷新/.test(guide));
});
