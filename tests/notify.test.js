// v3.60.3 转账提醒提速：收件人口径、60 秒名单缓存、复用已读记录
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction } = require('./helpers/sdk-stub.js');

const OWNER = 'o-owner';
const sent = [];
sdk.openapi.subscribeMessage = { send: async o => { sent.push(o.touser); } };

function seed(members, extra) {
  db.reset().applyUpdates = true;
  sent.length = 0;
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1', orgMode: false, ...(extra || {}) }])
    .seed('members', members)
    .seed('records', [{ _id: 'r1', aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', payerOpenid: 'g1', payerName: '张三', amount: 100, status: 'pending', createdAt: new Date() }]);
  state.openid = 'g1';
}
const m = (id, extra) => ({ _id: 'm-' + id, aid: 'acc1', memberOpenid: id, role: 'clerk', soloBookId: 'b1', ...extra });
const go = (fn) => (fn || loadFunction('payment')).main({ action: 'transferred', rid: 'r1' });
const membersQueries = () => db.log.filter(l => l.op === 'get' && l.col === 'members').length;

test('提醒收件人：主家 + 有确认权限且负责本礼簿的记账人；家人 / 待同意 / 无权限 / 别的礼簿 / 伪造不发', async () => {
  seed([
    m('c-ok'), m('c-noperm', { perms: ['book'] }), m('c-pending', { status: 'pending' }),
    m('c-other', { soloBookId: 'b2' }), m('v-family', { role: 'viewer' }), m('c-fake', { _openid: 'x' })
  ]);
  const r = await go();
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(sent.sort(), [OWNER, 'c-ok'].sort());
});

test('提醒：不重复读记录，members / accounts 各查一次', async () => {
  seed([m('c-ok')]);
  await go();
  const recGets = db.log.filter(l => l.op === 'get' && l.col === 'records' && l.cond && l.cond._id === 'r1');
  assert.strictEqual(recGets.length, 0, 'notifyOwner 不应再按 id 读 records');
  assert.strictEqual(membersQueries(), 1);
});

test('收件人名单缓存 60 秒：同礼簿第二笔不再查 members，过期后重查', async () => {
  seed([m('c-ok')]);
  const fn = loadFunction('payment');
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    await go(fn);
    assert.strictEqual(membersQueries(), 1);
    db.data.records[0].status = 'pending';
    sent.length = 0;
    await go(fn);
    assert.strictEqual(membersQueries(), 1, '缓存命中');
    assert.deepStrictEqual(sent.sort(), [OWNER, 'c-ok'].sort());
    t += 61000;
    db.data.records[0].status = 'pending';
    await go(fn);
    assert.strictEqual(membersQueries(), 2, '过期重查');
  } finally { Date.now = realNow; }
});

test('已转账过的幂等调用不再提醒', async () => {
  seed([m('c-ok')]);
  const fn = loadFunction('payment');
  await go(fn);
  assert.ok(sent.length > 0);
  sent.length = 0;
  db.applyUpdates = false; // 第二次条件更新 0 条 = 已推进过
  const r = await go(fn);
  assert.strictEqual(r.data.changed, false);
  assert.strictEqual(sent.length, 0);
});
