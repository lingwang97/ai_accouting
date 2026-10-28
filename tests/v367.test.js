// v3.67.0：adminSetPlan 三种模式（加时间 / 指定到期日 / 取消）与操作日志、预热默认函数、qrcode 预热分支
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction } = require('./helpers/sdk-stub.js');
const P = require('../tools/cloud-shared/plans.js');

const ADMIN = 'adm-openid-001';
const HOST = 'host-openid-0001';

function setup() {
  db.reset();
  db.persist = true;
  db.seed('settings', [{ _id: 'admins', openids: [ADMIN] }]);
  db.seed('accounts', [{ _id: 'a1', ownerOpenid: HOST, accountName: '张三' }]);
  state.openid = ADMIN;
  return loadFunction('system');
}
const call = (sys, o) => sys.main({ action: 'adminSetPlan', ownerOpenid: HOST, plan: 'pro', ...o });
const sub = () => db.data.subscriptions.find(x => x._id === HOST);
const lastLog = () => db.data.admin_logs[db.data.admin_logs.length - 1];
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('预热：默认函数含往来和礼簿码，WARMABLE 含 qrcode，normalizeWarmup 不丢它', () => {
  assert.ok(P.DEFAULT_WARMUP.functions.includes('renqing'));
  assert.ok(P.DEFAULT_WARMUP.functions.includes('qrcode'));
  assert.ok(P.WARMABLE.includes('qrcode') && P.WARMABLE.includes('renqing'));
  assert.ok(P.DEFAULT_WARMUP.functions.every(f => P.WARMABLE.includes(f)));
  assert.deepStrictEqual(P.normalizeWarmup({ functions: ['login', 'qrcode', 'export', 'nope'] }).functions, ['login', 'qrcode']);
  // 已保存的旧配置不迁移：原样保留管理员勾选的列表
  assert.deepStrictEqual(P.normalizeWarmup({ functions: ['login', 'account'] }).functions, ['login', 'account']);
  assert.strictEqual(P.DEFAULT_WARMUP.mode, 'paid');
});

test('qrcode：__warm 早返回（无身份也不报错，不读库）', async () => {
  db.reset();
  state.openid = '';
  const q = loadFunction('qrcode');
  const r = await q.main({ action: '__warm' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.msg, 'warm');
  state.openid = 'tester';
  const r2 = await q.main({ action: 'gen' });
  assert.notStrictEqual(r2.code, 0, '非预热调用仍按原逻辑校验');
});

test('adminSetPlan：非管理员被拒绝，不写订阅、不写日志', async () => {
  const sys = setup();
  state.openid = 'someone-else-0001';
  const r = await call(sys, { mode: 'add', days: 30 });
  assert.notStrictEqual(r.code, 0);
  assert.ok(!db.data.subscriptions || !db.data.subscriptions.length);
  assert.ok(!db.data.admin_logs || !db.data.admin_logs.length);
});

test('adminSetPlan add：加天数（缺省 30 天）、加月（日历月、月末落月末）、同套餐在原到期日上累加', async () => {
  const sys = setup();
  const t0 = Date.now();
  let r = await call(sys, { mode: 'add', days: 10 });
  assert.strictEqual(r.code, 0, r.msg);
  const e1 = new Date(sub().expiresAt).getTime();
  assert.ok(Math.abs(e1 - (t0 + 10 * 86400000)) < 5000);
  assert.strictEqual(r.data.oldPlan, 'free');
  assert.strictEqual(r.data.plan, 'pro');
  r = await call(sys, { mode: 'add', days: 5 }); // 在 e1 基础上累加
  assert.ok(Math.abs(new Date(sub().expiresAt).getTime() - (e1 + 5 * 86400000)) < 5);
  r = await sys.main({ action: 'adminSetPlan', ownerOpenid: HOST, plan: 'pro' }); // 旧调用：无 mode，默认 30 天
  assert.strictEqual(r.code, 0);
  assert.ok(Math.abs(new Date(sub().expiresAt).getTime() - (e1 + 35 * 86400000)) < 5);

  // 月末：下一年 1/31 北京时间 12:00 + 1 个月 = 2/28（或闰年 2/29）12:00
  const Y = new Date().getFullYear() + 1;
  const base = new Date(Date.UTC(Y, 0, 31, 4, 0, 0));
  db.data.subscriptions = [{ _id: HOST, plan: 'pro', expiresAt: base, source: 'admin' }];
  r = await call(sys, { mode: 'add', months: 1 });
  assert.strictEqual(r.code, 0, r.msg);
  const leap = (Y % 4 === 0 && Y % 100 !== 0) || Y % 400 === 0;
  assert.strictEqual(new Date(sub().expiresAt).toISOString(), new Date(Date.UTC(Y, 1, leap ? 29 : 28, 4, 0, 0)).toISOString());
  r = await call(sys, { mode: 'add', months: 12 }); // +1 年
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(new Date(sub().expiresAt).getUTCFullYear(), Y + 1);
});

test('adminSetPlan add：到期日不超过 5 年后', async () => {
  const sys = setup();
  const r = await call(sys, { mode: 'add', months: 60 });
  assert.strictEqual(r.code, 0, r.msg);
  const r2 = await call(sys, { mode: 'add', months: 12 }); // 已在约 5 年后，再加 1 年超限
  assert.notStrictEqual(r2.code, 0);
  assert.ok(/5 年/.test(r2.msg));
});

test('adminSetPlan until：指定到期日（北京时间当天 23:59:59），可缩短；过去、非法、超 5 年拒绝', async () => {
  const sys = setup();
  const Y = new Date().getFullYear() + 1;
  let r = await call(sys, { mode: 'until', until: `${Y}-06-15` });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(new Date(sub().expiresAt).toISOString(), new Date(`${Y}-06-15T23:59:59+08:00`).toISOString());
  // 缩短到更早的日期（仍在未来）
  r = await call(sys, { mode: 'until', until: `${Y}-03-01` });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(new Date(sub().expiresAt).toISOString(), new Date(`${Y}-03-01T23:59:59+08:00`).toISOString());
  assert.strictEqual(r.data.oldPlan, 'pro');
  const before = new Date(sub().expiresAt).getTime();
  for (const bad of [ymd(new Date(Date.now() - 2 * 86400000)), '2001-01-01', '2026-02-30', 'abc', '', `${Y + 8}-01-01`]) {
    const x = await call(sys, { mode: 'until', until: bad });
    assert.notStrictEqual(x.code, 0, '应拒绝：' + bad);
  }
  assert.strictEqual(new Date(sub().expiresAt).getTime(), before, '被拒绝的操作不改订阅');
});

test('adminSetPlan cancel：取消订阅回到免费版，无到期日；套餐不存在、openid 非法被拒绝', async () => {
  const sys = setup();
  await call(sys, { mode: 'add', days: 30 });
  let r = await sys.main({ action: 'adminSetPlan', ownerOpenid: HOST, plan: 'free', mode: 'cancel' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(sub().plan, 'free');
  assert.strictEqual(sub().expiresAt, null);
  assert.strictEqual(r.data.plan, 'free');
  assert.strictEqual(r.data.oldPlan, 'pro');
  r = await sys.main({ action: 'adminSetPlan', ownerOpenid: HOST, plan: 'nope', mode: 'add', days: 1 });
  assert.notStrictEqual(r.code, 0);
  r = await sys.main({ action: 'adminSetPlan', ownerOpenid: 'x', plan: 'pro', mode: 'add', days: 1 });
  assert.notStrictEqual(r.code, 0);
});

test('adminSetPlan：每次写操作日志（管理员、主家名、旧 / 新套餐与到期、模式），adminLogs 可读', async () => {
  const sys = setup();
  const Y = new Date().getFullYear() + 1;
  await call(sys, { mode: 'add', days: 30 });
  let l = lastLog();
  assert.strictEqual(l.action, 'setPlan');
  assert.strictEqual(l.admin, ADMIN);
  assert.strictEqual(l.ownerOpenid, HOST);
  assert.strictEqual(l.name, '张三');
  assert.strictEqual(l.mode, 'add');
  assert.strictEqual(l.oldPlan, 'free');
  assert.strictEqual(l.newPlan, 'pro');
  assert.ok(l.newExpiresAt);
  await call(sys, { mode: 'until', until: `${Y}-03-01` });
  l = lastLog();
  assert.strictEqual(l.mode, 'until');
  assert.strictEqual(l.oldPlan, 'pro');
  assert.ok(l.oldExpiresAt && l.newExpiresAt);
  await sys.main({ action: 'adminSetPlan', ownerOpenid: HOST, plan: 'free', mode: 'cancel' });
  l = lastLog();
  assert.strictEqual(l.mode, 'cancel');
  assert.strictEqual(l.newPlan, 'free');
  assert.strictEqual(db.data.admin_logs.filter(x => x.action === 'setPlan').length, 3);
  const r = await sys.main({ action: 'adminLogs' });
  assert.strictEqual(r.code, 0);
});

test('adminSetPlan：被拒绝的操作不写日志', async () => {
  const sys = setup();
  await call(sys, { mode: 'until', until: '2001-01-01' });
  assert.ok(!db.data.admin_logs || !db.data.admin_logs.length);
});
