// v3.63.0 数量额度（礼簿 / 记账人，只限制新增）与回收站保留天数（15 / 30 / 60，到期日删除时固化）
// 现阶段 free 的 maxBooks / maxClerks 为 0（不限）：默认不限制，只有套餐文档里写了正数才生效
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction } = require('./helpers/sdk-stub.js');
const P = require('../tools/cloud-shared/plans.js');
const A = require('../miniprogram/utils/advperm.js');

const OWNER = 'o-owner';
const DAY = 24 * 3600 * 1000;

test('plans：limitOf 0 / 缺项不限；effectiveTrashDays 按套餐上限收窄，非法值回默认', () => {
  assert.strictEqual(P.DEFAULT_PLANS.free.features.maxBooks, 0);
  assert.strictEqual(P.DEFAULT_PLANS.free.features.maxClerks, 0);
  assert.strictEqual(P.limitOf({ maxBooks: 0 }, 'maxBooks'), Infinity);
  assert.strictEqual(P.limitOf({}, 'maxBooks'), Infinity);
  assert.strictEqual(P.limitOf(undefined, 'maxBooks'), Infinity);
  assert.strictEqual(P.limitOf({ maxBooks: 3 }, 'maxBooks'), 3);
  assert.strictEqual(P.effectiveTrashDays(60, {}), 60, '缺项 = 全部开放');
  assert.strictEqual(P.effectiveTrashDays(undefined, {}), 15, '默认 15');
  assert.strictEqual(P.effectiveTrashDays(60, { trashDays: 15 }), 15);
  assert.strictEqual(P.effectiveTrashDays(60, { trashDays: 30 }), 30);
  assert.strictEqual(P.effectiveTrashDays(45, { trashDays: 60 }), 15, '非选项值回默认');
  assert.strictEqual(P.effectiveTrashDays(30, { trashDays: 10 }), 15, '上限低于 15 也至少 15');
  assert.ok(/3 本礼簿/.test(P.quotaMsg('免费版', 'books', 3, false)));
  assert.ok(/2 个场次/.test(P.quotaMsg('免费版', 'books', 2, true)));
  assert.ok(/2 位礼台人员/.test(P.quotaMsg('免费版', 'clerks', 2, true)));
  assert.ok(/2 位记账人/.test(P.quotaMsg('免费版', 'clerks', 2, false)));
});

test('advperm：回收站选项权限；额度卡文案（不限 / 有上限 / 机构称谓）', () => {
  const owner = A.trashItem({ role: 'owner', features: {} });
  assert.ok(owner.enabled && !owner.vip);
  [15, 30, 60].forEach(d => assert.ok(A.trashOptionEnabled(owner, d)));
  const capped = A.trashItem({ role: 'owner', features: { trashDays: 15 } });
  assert.ok(capped.vip && capped.contact);
  assert.ok(A.trashOptionEnabled(capped, 15) && !A.trashOptionEnabled(capped, 30));
  const clerk = A.trashItem({ role: 'clerk', features: {} });
  assert.ok(!clerk.enabled && !clerk.contact);
  assert.ok(!A.trashOptionEnabled(clerk, 15));

  assert.strictEqual(A.quotaItem({ role: 'clerk', adv: { books: 1, clerks: 1, maxBooks: 0, maxClerks: 0 } }).show, false);
  assert.strictEqual(A.quotaItem({ role: 'owner', adv: null }).show, false);
  const u = A.quotaItem({ role: 'owner', orgMode: false, adv: { books: 4, clerks: 1, maxBooks: 0, maxClerks: 0 } });
  assert.ok(u.show && !u.limited && !u.full);
  assert.ok(/礼簿 4 本（当前不限）/.test(u.bookLine) && /记账人 1 位（当前不限）/.test(u.clerkLine));
  const l = A.quotaItem({ role: 'owner', orgMode: true, adv: { books: 3, clerks: 1, maxBooks: 3, maxClerks: 2 } });
  assert.ok(l.limited && l.full);
  assert.ok(/场次 3 个，上限 3 个/.test(l.bookLine) && /礼台人员 1 位，上限 2 位/.test(l.clerkLine));
});

// ---- books.save 额度
const planDoc = f => [{ _id: 'plans', free: { name: '免费版', features: f }, pro: { name: '专业版', features: {} } }];
function seedBooks(features, n, org) {
  db.reset().applyUpdates = true;
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b0', accountName: '张府', orgMode: !!org }])
    .seed('books', Array.from({ length: n }, (_, i) => ({ _id: 'b' + i, ownerOpenid: OWNER, name: '礼簿' + i, type: 'wedding', archived: i > 0 })))
    .seed('settings', features ? planDoc(features) : []);
  state.openid = OWNER;
}
const newBook = () => loadFunction('books').main({ action: 'save', book: { name: '新礼簿', type: 'wedding' } });

test('books.save：默认不限，新增不受影响', async () => {
  seedBooks(null, 5);
  const r = await newBook();
  assert.strictEqual(r.code, 0, r.msg);
});

test('books.save：设了上限后，满额时新增被拒（含已归档），编辑旧礼簿不受影响；机构模式称场次', async () => {
  seedBooks({ maxBooks: 3 }, 3);
  const r = await newBook();
  assert.notStrictEqual(r.code, 0);
  assert.ok(/3 本礼簿/.test(r.msg), r.msg);
  const edit = await loadFunction('books').main({ action: 'save', book: { _id: 'b1', name: '改名', type: 'wedding' } });
  assert.strictEqual(edit.code, 0, edit.msg);
  seedBooks({ maxBooks: 3 }, 2);
  assert.strictEqual((await newBook()).code, 0, '未满可新增');
  seedBooks({ maxBooks: 3 }, 4); // 已超额的老用户：不删不冻结，只是不能再新增
  assert.notStrictEqual((await newBook()).code, 0);
  assert.strictEqual(db.data.books.length, 4);
  seedBooks({ maxBooks: 2 }, 2, true);
  assert.ok(/2 个场次/.test((await newBook()).msg));
});

// ---- account：记账人额度 / advGet / setTrashDays
const CLERK = n => ({ _id: 'm' + n, aid: 'acc1', ownerOpenid: OWNER, memberOpenid: 'c' + n, role: 'clerk', soloBookId: 'b0', perms: ['desk'], status: 'active' });
function seedAcc(features, clerks, extra) {
  db.reset().applyUpdates = true;
  db.persist = true;
  db.seed('users', [{ openid: OWNER }])
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b0', accountName: '张府', orgMode: false, ...(extra || {}) }])
    .seed('books', [{ _id: 'b0', ownerOpenid: OWNER, name: '礼簿', type: 'wedding' }])
    .seed('members', Array.from({ length: clerks }, (_, i) => CLERK(i + 1)).concat([{ _id: 'mv', aid: 'acc1', memberOpenid: 'v1', role: 'viewer', bookIds: ['b0'] }]))
    .seed('settings', features ? planDoc(features) : []);
  state.openid = OWNER;
}
const acc = ev => loadFunction('account').main(ev);

test('account.createInvite：记账人额度（家人共享不计）；默认不限；viewer 邀请不受限', async () => {
  seedAcc(null, 5);
  assert.strictEqual((await acc({ action: 'createInvite', type: 'clerk' })).code, 0);
  seedAcc({ maxClerks: 2 }, 2);
  const r = await acc({ action: 'createInvite', type: 'clerk' });
  assert.notStrictEqual(r.code, 0);
  assert.ok(/2 位记账人/.test(r.msg), r.msg);
  assert.strictEqual((await acc({ action: 'createInvite', type: 'viewer', bookIds: ['b0'] })).code, 0, '家人共享只读不受记账人额度限制');
  seedAcc({ maxClerks: 2 }, 1);
  assert.strictEqual((await acc({ action: 'createInvite', type: 'clerk' })).code, 0);
});

test('account.acceptInvite：满额时新记账人加入被拒，已是成员的不受影响', async () => {
  const inv = { _id: 'tk1', type: 'clerk', aid: 'acc1', ownerOpenid: OWNER, fromOpenid: OWNER, used: false, uses: 0, maxUses: 5, perms: ['desk'], allBooks: false, bookIds: ['b0'], solo: true, expiresAt: new Date(Date.now() + DAY) };
  seedAcc({ maxClerks: 1 }, 1);
  db.seed('invites', [inv]);
  state.openid = 'newcomer';
  const r = await acc({ action: 'acceptInvite', token: 'tk1', displayName: '王大锤' });
  assert.notStrictEqual(r.code, 0);
  assert.ok(/1 位记账人/.test(r.msg), r.msg);
  assert.strictEqual(db.data.members.filter(m => m.role === 'clerk').length, 1, '没有新增成员');
  seedAcc(null, 1);
  db.seed('invites', [inv]);
  state.openid = 'newcomer';
  const ok2 = await acc({ action: 'acceptInvite', token: 'tk1', displayName: '王大锤' });
  assert.strictEqual(ok2.code, 0, ok2.msg);
  assert.strictEqual(db.data.members.filter(m => m.role === 'clerk').length, 2);
});

test('account.advGet / setTrashDays：只有主家；默认 15，可选 30 / 60；套餐限制时拒绝更长', async () => {
  seedAcc(null, 1);
  let r = await acc({ action: 'advGet' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.deepStrictEqual([r.data.books, r.data.clerks, r.data.maxBooks, r.data.maxClerks, r.data.trashDays, r.data.trashMax], [1, 1, 0, 0, 15, 60]);
  assert.strictEqual((await acc({ action: 'setTrashDays', days: 30 })).data.trashDays, 30);
  assert.strictEqual((await acc({ action: 'setTrashDays', days: 45 })).code === 0, false);
  seedAcc(null, 1, { trashDays: 60 });
  assert.strictEqual((await acc({ action: 'advGet' })).data.trashDays, 60);
  seedAcc({ trashDays: 15 }, 1, { trashDays: 60 });
  r = await acc({ action: 'advGet' });
  assert.strictEqual(r.data.trashDays, 15, '套餐收窄后生效值回落');
  assert.strictEqual(r.data.trashMax, 15);
  assert.notStrictEqual((await acc({ action: 'setTrashDays', days: 30 })).code, 0);
  assert.strictEqual((await acc({ action: 'setTrashDays', days: 15 })).code, 0);
  // 记账人不能看 / 改
  seedAcc(null, 1);
  state.openid = 'c1';
  assert.notStrictEqual((await acc({ action: 'advGet' })).code, 0);
  assert.notStrictEqual((await acc({ action: 'setTrashDays', days: 30 })).code, 0);
});

// ---- books.remove：到期日按删除时的设置固化
async function removeWith(trashDays, features) {
  db.reset().applyUpdates = true;
  db.persist = true;
  db.seed('users', [{ openid: OWNER }])
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b0', accountName: '张府', ...(trashDays ? { trashDays } : {}) }])
    .seed('books', [{ _id: 'b0', ownerOpenid: OWNER, name: '当前', type: 'wedding' }, { _id: 'b1', ownerOpenid: OWNER, name: '旧场', type: 'wedding', archived: true }])
    .seed('settings', features ? planDoc(features) : []);
  state.openid = OWNER;
  const fn = loadFunction('books');
  const pv = await fn.main({ action: 'removePreview', bookId: 'b1' });
  const r = await fn.main({ action: 'remove', bookId: 'b1' });
  assert.strictEqual(r.code, 0, r.msg);
  const t = db.data.trash_books && db.data.trash_books.find(x => x._id === 'b1');
  return { pv, t };
}

test('books.remove：purgeAt 按所选天数固化（默认 15，选 30 / 60；套餐收窄时取上限）', async () => {
  for (const [saved, feat, want] of [[0, null, 15], [30, null, 30], [60, null, 60], [60, { trashDays: 30 }, 30]]) {
    const { pv, t } = await removeWith(saved, feat);
    assert.strictEqual(pv.data.days, want, '预览天数');
    assert.ok(t, '进了回收站');
    const days = Math.round((new Date(t.purgeAt) - new Date(t.deletedAt)) / DAY);
    assert.strictEqual(days, want);
  }
});

test('books.trashList：回传当前设置天数；旧记录自带 purgeAt 不变', async () => {
  db.reset();
  db.seed('users', [{ openid: OWNER }])
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b0', trashDays: 30 }])
    .seed('books', [{ _id: 'b0', ownerOpenid: OWNER, name: '当前', type: 'wedding' }])
    .seed('trash_books', [{ _id: 'x1', ownerOpenid: OWNER, name: '旧', type: 'wedding', trashStatus: 'done', deletedAt: new Date(), purgeAt: new Date(Date.now() + 5 * DAY) }]);
  state.openid = OWNER;
  const r = await loadFunction('books').main({ action: 'trashList' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(r.data.days, 30);
  assert.strictEqual(r.data.list.length, 1);
});
