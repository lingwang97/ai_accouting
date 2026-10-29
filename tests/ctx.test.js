// 身份与权限矩阵：resolveCtx 解析出的角色，及 can / canBook / readonly / restricted / workBook / wider
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, loadFunction } = require('./helpers/sdk-stub.js');
const C = require('../tools/cloud-shared/ctx.js');

const OWNER = 'o-owner';
const ACC = { _id: 'acc1', ownerOpenid: OWNER, orgMode: true, activeBookId: 'b1' };
const members = {
  full: { _id: 'm1', aid: 'acc1', memberOpenid: 'u-full', role: 'clerk', allBooks: true, perms: ['confirm', 'desk', 'members'] },
  part: { _id: 'm2', aid: 'acc1', memberOpenid: 'u-part', role: 'clerk', bookIds: ['b1', 'b2'], perms: ['confirm', 'desk', 'show'] },
  viewer: { _id: 'm3', aid: 'acc1', memberOpenid: 'u-view', role: 'viewer', bookIds: ['b1'] },
  pending: { _id: 'm4', aid: 'acc1', memberOpenid: 'u-wait', role: 'clerk', allBooks: true, status: 'pending' },
  forged: { _id: 'm5', aid: 'acc1', memberOpenid: 'u-forged', role: 'clerk', allBooks: true, _openid: 'x' },
  old: { _id: 'm6', aid: 'acc1', memberOpenid: 'u-old', role: 'clerk', allBooks: true } // 早期记账人：allBooks 给全部权限
};

function seed() {
  db.reset()
    .seed('accounts', [{ ...ACC }])
    .seed('users', [{ openid: OWNER }, { openid: 'u-full', currentAid: 'acc1' }, { openid: 'u-part', currentAid: 'acc1' },
      { openid: 'u-view', currentAid: 'acc1' }, { openid: 'u-old', currentAid: 'acc1' }])
    .seed('members', Object.values(members).map(m => ({ ...m })))
    .seed('books', [
      { _id: 'b1', ownerOpenid: OWNER }, { _id: 'b2', ownerOpenid: OWNER },
      { _id: 'b3', ownerOpenid: OWNER }, { _id: 'b9', ownerOpenid: OWNER, archived: true }
    ]);
}

test('主家：全部权限、不限礼簿、工作礼簿为当前礼簿', async () => {
  seed();
  const c = await C.resolveCtx(db, OWNER);
  assert.strictEqual(c.role, 'owner');
  C.ALL_PERMS.forEach(p => assert.ok(C.can(c, p), p));
  assert.ok(C.canBook(c, 'anything'));
  assert.ok(!C.restricted(c) && !C.readonly(c));
  assert.strictEqual(C.workBook(c), 'b1');
});

test('全权记账人（allBooks）：按授予的 perms，不限礼簿', async () => {
  seed();
  const c = await C.resolveCtx(db, 'u-full');
  assert.strictEqual(c.role, 'clerk');
  assert.strictEqual(c.ownerOpenid, OWNER);
  assert.ok(C.can(c, 'confirm') && C.can(c, 'desk') && C.can(c, 'members'));
  assert.ok(!C.can(c, 'void') && !C.can(c, 'books') && !C.can(c, 'export'));
  assert.ok(C.canBook(c, 'b3') && !C.restricted(c));
});

test('早期记账人没有 perms 但 allBooks：给全部权限', async () => {
  seed();
  const c = await C.resolveCtx(db, 'u-old');
  assert.strictEqual(c.role, 'clerk');
  C.ALL_PERMS.forEach(p => assert.ok(C.can(c, p), p));
});

test('部分礼簿记账人：只能操作负责的礼簿，受限', async () => {
  seed();
  const c = await C.resolveCtx(db, 'u-part');
  assert.strictEqual(c.role, 'clerk');
  assert.ok(C.canBook(c, 'b1') && C.canBook(c, 'b2') && !C.canBook(c, 'b3'));
  assert.ok(C.restricted(c));
  assert.ok(C.can(c, 'show') && !C.can(c, 'void'));
  assert.ok(['b1', 'b2'].includes(C.workBook(c)));
});

test('非机构模式：记账人只负责一本（主家当前礼簿在其范围内时取当前礼簿）', async () => {
  seed();
  db.data.accounts[0].orgMode = false;
  const c = await C.resolveCtx(db, 'u-part');
  assert.deepStrictEqual(c.bookIds, ['b1']);
  assert.ok(!C.canBook(c, 'b2'));
});

test('家人共享 viewer：只读、没有任何权限项、只能看共享的礼簿', async () => {
  seed();
  const c = await C.resolveCtx(db, 'u-view');
  assert.strictEqual(c.role, 'viewer');
  assert.ok(C.readonly(c));
  C.ALL_PERMS.forEach(p => assert.ok(!C.can(c, p), p));
  assert.ok(C.canBook(c, 'b1') && !C.canBook(c, 'b2'));
  assert.ok(C.restricted(c));
});

test('待同意 / 伪造（带 _openid）的成员不生效，无身份者 role=none 无任何权限', async () => {
  seed();
  for (const id of ['u-wait', 'u-forged', 'nobody']) {
    const c = await C.resolveCtx(db, id);
    assert.strictEqual(c.role, 'none', id);
    C.ALL_PERMS.forEach(p => assert.ok(!C.can(c, p), id + ' ' + p));
    assert.ok(!C.readonly(c));
  }
});

test('伪造的 accounts（带 _openid）不被信任', async () => {
  seed();
  db.data.accounts[0]._openid = 'forged';
  assert.strictEqual((await C.resolveCtx(db, OWNER)).role, 'none');
});

test('礼簿短码：默认礼簿 id 超 32 字符，短码不超过 32 且确定', () => {
  const id = 'default_' + 'a'.repeat(32);
  assert.ok(id.length > 32);
  const code = C.shortCodeOf(id);
  assert.ok(code.length <= 32 && /^k[0-9a-f]{24}$/.test(code));
  assert.strictEqual(code, C.shortCodeOf(id));
});

test('account.wider：对方权限或礼簿超出操作人范围', () => {
  const { _test } = loadFunction('account');
  assert.ok(_test && _test.wider, 'account 需导出 _test.wider');
  const wider = _test.wider;
  const ownerCtx = { role: 'owner', account: ACC, bookIds: null, perms: C.ALL_PERMS };
  const clerk = { role: 'clerk', account: ACC, bookIds: ['b1', 'b2'], perms: ['confirm', 'desk', 'members'] };
  assert.strictEqual(wider(ownerCtx, { role: 'clerk', allBooks: true }), false); // 主家永不超出
  assert.strictEqual(wider(clerk, { role: 'clerk', bookIds: ['b1'], perms: ['confirm'] }), false);
  assert.strictEqual(wider(clerk, { role: 'clerk', bookIds: ['b1'], perms: ['void'] }), true); // 权限超出
  assert.strictEqual(wider(clerk, { role: 'clerk', bookIds: ['b3'], perms: ['confirm'] }), true); // 礼簿超出
  assert.strictEqual(wider(clerk, { role: 'clerk', allBooks: true, perms: ['confirm'] }), true); // 全部礼簿超出
  assert.strictEqual(wider(clerk, { role: 'viewer', bookIds: ['b3'] }), true); // 家人共享了范围外礼簿
  assert.strictEqual(wider(clerk, { role: 'viewer', bookIds: ['b2'] }), false);
  const viewerCtx = { role: 'viewer', account: ACC, bookIds: ['b1'], perms: [] };
  assert.strictEqual(wider(viewerCtx, { role: 'clerk', bookIds: ['b1'], perms: ['confirm'] }), true); // 家人没有权限项
});
