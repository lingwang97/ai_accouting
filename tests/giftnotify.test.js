// v3.66.3 新礼金微信提醒默认关闭、按人开启：notifyOwner 只发给开启者、setGiftNotify 权限、account.get 返回、advperm 卡片
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction } = require('./helpers/sdk-stub.js');
const A = require('../miniprogram/utils/advperm.js');

const OWNER = 'o-owner';
const sent = [];
sdk.openapi.subscribeMessage = { send: async o => { sent.push(o.touser); } };

const m = (id, extra) => ({ _id: 'm-' + id, aid: 'acc1', memberOpenid: id, role: 'clerk', soloBookId: 'b1', ...extra });
function seed(users, members) {
  db.reset().applyUpdates = true;
  sent.length = 0;
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1', orgMode: false, accountName: '张府' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }])
    .seed('members', members || [])
    .seed('users', users)
    .seed('records', [{ _id: 'r1', aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', payerOpenid: 'g1', payerName: '张三', amount: 100, status: 'pending', createdAt: new Date() }]);
}
const transfer = () => { state.openid = 'g1'; return loadFunction('payment').main({ action: 'transferred', rid: 'r1' }); };
const call = (openid, ev) => { state.openid = openid; return loadFunction('account').main(ev); };
const userUpdates = () => db.log.filter(l => l.op === 'update' && l.col === 'users');

test('notifyOwner：只发给开启了新礼金提醒的人（主家与记账人各自决定）', async () => {
  seed([{ openid: OWNER }, { openid: 'c1', giftNotify: true }, { openid: 'c2', giftNotify: false }, { openid: 'c3' }],
    [m('c1'), m('c2'), m('c3')]);
  const r = await transfer();
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(sent, ['c1']);
});

test('notifyOwner：伪造的 users 文档（带 _openid）不算开启', async () => {
  seed([{ openid: OWNER, giftNotify: true, _openid: 'x' }], []);
  await transfer();
  assert.deepStrictEqual(sent, []);
});

test('notifyOwner：全员都没开启时不发送，也不读批次、不写 lastNotify', async () => {
  seed([{ openid: OWNER }, { openid: 'c1' }], [m('c1')]);
  const r = await transfer();
  assert.strictEqual(r.code, 0);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(userUpdates().length, 0);
});

test('notifyOwner：缓存 60 秒内开关变化不生效，过期后生效', async () => {
  seed([{ openid: OWNER }], []);
  const fn = loadFunction('payment');
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    state.openid = 'g1';
    await fn.main({ action: 'transferred', rid: 'r1' });
    assert.strictEqual(sent.length, 0);
    db.data.users[0].giftNotify = true;
    db.data.records[0].status = 'pending';
    await fn.main({ action: 'transferred', rid: 'r1' });
    assert.strictEqual(sent.length, 0, '名单缓存中，最多延迟 60 秒');
    t += 61000;
    db.data.records[0].status = 'pending';
    await fn.main({ action: 'transferred', rid: 'r1' });
    assert.deepStrictEqual(sent, [OWNER]);
  } finally { Date.now = realNow; }
});

const CLERK_CONFIRM = m('c1', { perms: ['confirm'] });
const CLERK_DESK = m('c2', { perms: ['desk'] });
const VIEWER = m('v1', { role: 'viewer', bookIds: ['b1'] });
const USERS = [{ openid: OWNER }, { openid: 'c1' }, { openid: 'c2' }, { openid: 'v1' }];

test('account.setGiftNotify：主家 / 有确认权限的记账人可打开；家人与无确认权限的不能；非布尔值拒绝', async () => {
  seed(USERS, [CLERK_CONFIRM, CLERK_DESK, VIEWER]);
  let r = await call(OWNER, { action: 'setGiftNotify', on: true });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.giftNotify, true);
  const u = userUpdates().pop();
  assert.strictEqual(u.cond.openid, OWNER);
  assert.deepStrictEqual(u.data, { giftNotify: true });
  assert.strictEqual((await call('c1', { action: 'setGiftNotify', on: true })).code, 0);
  const n = userUpdates().length;
  assert.notStrictEqual((await call('c2', { action: 'setGiftNotify', on: true })).code, 0);
  assert.notStrictEqual((await call('v1', { action: 'setGiftNotify', on: true })).code, 0);
  for (const bad of ['true', 1, undefined, null]) assert.notStrictEqual((await call(OWNER, { action: 'setGiftNotify', on: bad })).code, 0, String(bad));
  assert.strictEqual(userUpdates().length, n);
  r = await call(OWNER, { action: 'setGiftNotify', on: false });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.data.giftNotify, false);
});

test('account.get / dashboard：giftNotify 缺省为 false，开启后只对有权限的身份为 true', async () => {
  seed([{ openid: OWNER, giftNotify: true }, { openid: 'c1', giftNotify: true }, { openid: 'c2', giftNotify: true }, { openid: 'v1', giftNotify: true }], [CLERK_CONFIRM, CLERK_DESK, VIEWER]);
  assert.strictEqual((await call(OWNER, { action: 'get' })).data.giftNotify, true);
  assert.strictEqual((await call('c1', { action: 'get' })).data.giftNotify, true);
  assert.strictEqual((await call('c2', { action: 'get' })).data.giftNotify, false, '没有确认权限');
  assert.strictEqual((await call('v1', { action: 'get' })).data.giftNotify, false, '家人只读');
  seed(USERS, []);
  assert.strictEqual((await call(OWNER, { action: 'get' })).data.giftNotify, false, '旧用户没有该字段 = 关闭');
  state.openid = OWNER;
  const d = await loadFunction('records').main({ action: 'dashboard' });
  assert.strictEqual(d.data.giftNotify, false);
});

test('advperm.giftItem：主家 / 有确认权限的记账人可用；家人与无确认权限的置灰并说明原因，不带会员标签', () => {
  assert.strictEqual(A.giftItem({ role: 'owner', perms: [] }).enabled, true);
  assert.strictEqual(A.giftItem({ role: 'clerk', perms: ['confirm'] }).enabled, true);
  const c = A.giftItem({ role: 'clerk', perms: ['desk'] });
  assert.deepStrictEqual([c.enabled, c.vip, c.contact], [false, false, false]);
  assert.ok(/确认收礼/.test(c.reason));
  assert.strictEqual(A.giftItem({ role: 'clerk', perms: null }).enabled, false);
  const v = A.giftItem({ role: 'viewer', perms: [] });
  assert.strictEqual(v.enabled, false);
  assert.ok(/只读/.test(v.reason));
});
