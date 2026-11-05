// v3.86.10：上线前审查修复——凭证防伪造（过滤 / 占位覆盖）、删簿共用截止时间、并发降到 8、72 小时锁只管金额 / 姓名 / 作废
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const ST = require('../cloudfunctions/payment/status.js');

const OWNER = 'o-owner';
const H = 3600 * 1000;
const RealDate = Date;
const NOW = ST.LOCK_SINCE + 30 * 24 * H; // 缓冲期之后

function setNow(ms) {
  global.Date = class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(ms); else super(...a); }
    static now() { return ms; }
  };
}
async function at(ms, fn) {
  setNow(ms);
  try { return await fn(); } finally { global.Date = RealDate; }
}
const ago = h => new Date(NOW - h * H);

function seed(records) {
  db.reset().applyUpdates = true;
  db.persist = true;
  sdk.openapi = {
    subscribeMessage: { send: async () => {} },
    security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) }
  };
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER, nickname: '主家' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜', type: 'wedding', statReady: true, statCount: 0, statFen: 0 }])
    .seed('records', records);
}
const rec = (id, extra) => ({
  _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', themeName: '新婚之喜', hostName: '张府',
  payerOpenid: 'g1', payerName: '王五', amount: 600, payMethod: 'wechat', status: 'paid', handlerOpenid: OWNER, handlerName: '主家',
  remark: '备注', relation: '朋友', createdAt: ago(100), transferredAt: ago(100), paidAt: ago(100), sortAt: ago(100), guestRejectNotify: true, guestEnv: 'trial', ...extra
});
const owner = ev => { state.openid = OWNER; return loadFunction('payment').main(ev); };
const guest = (ev, id) => { state.openid = id || 'g1'; return loadFunction('payment').main(ev); };
const get = id => db.data.records.find(r => r._id === id);
const snapDoc = (id, extra) => ({
  _id: id, guestOpenid: 'g1', ownerOpenid: 'o-x', bookId: 'bx', status: 'paid', amount: 200, payerName: '王五', hostName: '李府', themeName: '寿宴',
  bookType: 'birthday', createdAt: ago(900), paidAt: ago(900), trail: [], snapshotAt: ago(100), ...extra
});

// —— 中1：凭证防伪造 ——
test('凭证：myReceipts（分页 all 最后一页与旧版整页）不显示带 _openid 的伪造凭证，查询条件带 _openid 不存在', async () => {
  await at(NOW, async () => {
    seed([rec('live')]);
    db.seed('guest_receipts', [snapDoc('real'), snapDoc('fake', { _openid: 'o-evil', hostName: '骗子府', amount: 99999 })]);
    const t = await guest({ action: 'myReceipts', tab: 'all' });
    assert.strictEqual(t.code, 0, t.msg);
    assert.deepStrictEqual((t.data.vouchers || []).map(v => v._id), ['real']);
    const old = await guest({ action: 'myReceipts' });
    assert.strictEqual(old.code, 0, old.msg);
    assert.deepStrictEqual(old.data.vouchers.map(v => v._id), ['real']);
    assert.ok(!JSON.stringify([t.data, old.data]).includes('骗子府'));
    const q = db.log.filter(x => x.op === 'get' && x.col === 'guest_receipts');
    assert.ok(q.length >= 2 && q.every(x => x.cond._openid && x.cond._openid.__op === 'exists' && x.cond._openid.v === false), JSON.stringify(q.map(x => x.cond)));
  });
});

test('凭证：已有同 _id 的伪造占位文档时，快照仍写入真凭证（先删占位再写，不再带 _openid）；真凭证已存在的照旧跳过', async () => {
  const Snap = require('../cloudfunctions/books/snapshot.js');
  await at(NOW, async () => {
    seed([rec('s1'), rec('s2', { payerName: '李四', payerOpenid: 'g2' })]);
    db.seed('guest_receipts', [
      { _id: 's1', _openid: 'o-evil', guestOpenid: 'g1', ownerOpenid: OWNER, amount: 1, hostName: '假的', snapshotAt: ago(1) },
      { _id: 's2', guestOpenid: 'g2', ownerOpenid: OWNER, amount: 600, hostName: '张府', payerName: '原样', snapshotAt: ago(1) }
    ]);
    assert.strictEqual(await Snap.snapshotRecords(db, OWNER, { bookId: 'b1' }, 0), true);
    const s1 = db.data.guest_receipts.find(x => x._id === 's1');
    assert.ok(!('_openid' in s1), '占位被真凭证覆盖');
    assert.strictEqual(s1.amount, 600);
    assert.strictEqual(s1.hostName, '张府');
    assert.strictEqual(s1.guestOpenid, 'g1');
    assert.strictEqual(db.data.guest_receipts.find(x => x._id === 's2').payerName, '原样', '真凭证已存在不重写');
    assert.strictEqual(db.data.guest_receipts.length, 2);
  });
});

test('凭证：deleteVoucher 条件仍为本人 guestOpenid（伪造的同名文档本人可删，别人的删不到）', async () => {
  await at(NOW, async () => {
    seed([]);
    db.log.length = 0;
    const r = await guest({ action: 'deleteVoucher', rids: ['a1'] });
    assert.strictEqual(r.code, 0);
    const rm = db.log.find(x => x.op === 'remove' && x.col === 'guest_receipts');
    assert.strictEqual(rm.cond.guestOpenid, 'g1');
  });
});

test('管理员页集合权限检查：提示试读查不出「仅创建者可读写」、guest_receipts 必须所有用户不可读写；清单 20 个集合', () => {
  const pf = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/admin/preflight.js'), 'utf8');
  assert.ok(pf.includes('仅创建者可读写') && pf.includes('guest_receipts'));
  const sys = fs.readFileSync(path.join(ROOT, 'cloudfunctions/system/index.js'), 'utf8');
  const { COLLECTIONS } = require('../tools/cloud-shared/collections.js');
  assert.ok(sys.includes(`'${COLLECTIONS.length} 个集合权限均为「所有用户不可读写」'`), '清单集合数与 collections.js 一致');
});

// —— 中2：删簿共用截止时间、并发 8 ——
test('trash.moveToTrash：留凭证与移动共用一个截止时间（总 15 秒，留凭证最晚到截止前 5 秒），没做完返回 false 且礼簿还在', async () => {
  const trash = require('../cloudfunctions/books/trash.js');
  const Snap = require('../cloudfunctions/books/snapshot.js');
  assert.strictEqual(trash.TOTAL_MS, 15 * 1000);
  assert.strictEqual(trash.MOVE_MIN_MS, 5 * 1000);
  assert.ok(trash.TOTAL_MS < 20 * 1000, '低于 books 超时');
  const orig = Snap.snapshotRecords;
  let seen = null;
  try {
    seed([rec('s1')]);
    Snap.snapshotRecords = async (d, o, c, deadline) => { seen = deadline - Date.now(); return false; };
    const done = await trash.moveToTrash(db, OWNER, 'b1', { _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜' }, { aid: 'acc1' }, 15);
    assert.strictEqual(done, false);
    assert.ok(seen > 9000 && seen <= 10000, String(seen));
    assert.ok(!(db.data.trash_books || []).length, '没做完不移动、不建回收站文档');
    assert.ok(get('s1'), '记录还在');
  } finally { Snap.snapshotRecords = orig; }
  // 源码：moveToTrash 不再单独再起一个 12 秒移动预算
  const src = fs.readFileSync(path.join(ROOT, 'tools/cloud-shared/trash.js'), 'utf8');
  const body = src.slice(src.indexOf('async function moveToTrash'), src.indexOf('async function restore'));
  assert.ok(!body.includes('BUDGET_MS') && body.includes('TOTAL_MS'));
  // 副本已同步（books / warmer）
  ['books', 'warmer'].forEach(f => assert.strictEqual(fs.readFileSync(path.join(ROOT, `cloudfunctions/${f}/trash.js`), 'utf8'), src, f));
});

test('并发：快照写入与 sortAt 回填都降到 8', () => {
  const Snap = require('../tools/cloud-shared/snapshot.js');
  assert.strictEqual(Snap.CONC, 8);
  const sys = fs.readFileSync(path.join(ROOT, 'cloudfunctions/system/index.js'), 'utf8');
  assert.ok(/const BACKFILL_CONC = 8;/.test(sys));
  assert.ok(!/rows\.slice\(i, i \+ 20\)/.test(sys.slice(sys.indexOf('async function backfillSort'))));
});

// —— 中3：72 小时锁只管金额 / 姓名 / 作废 ——
test('amend 超期：关系、备注仍可改（不写 trail / chgAt / changeNotifyAt / amendedAt，记 amendLog 与版本号，无 paidAt 条件）', async () => {
  await at(NOW, async () => {
    seed([rec('r1'), rec('cash', { payerOpenid: '', deskEntry: true, payMethod: 'cash' })]);
    const r = await owner({ action: 'amend', rid: 'r1', relation: '同事', remark: '老同学' });
    assert.strictEqual(r.code, 0, r.msg);
    const d = get('r1');
    assert.strictEqual(d.relation, '同事');
    assert.strictEqual(d.remark, '老同学');
    assert.strictEqual(d.amendN, 1);
    assert.strictEqual(d.amendLog.length, 1);
    assert.deepStrictEqual(d.amendLog[0].changes.relation, ['朋友', '同事']);
    ['trail', 'chgAt', 'changeNotifyAt', 'amendedAt'].forEach(k => assert.ok(!(k in d), k));
    const upd = db.log.filter(x => x.op === 'update' && x.col === 'records').pop();
    assert.ok(!JSON.stringify(upd.cond).includes('paidAt'), '只改关系备注不加 paidAt 条件');
    // 宾客侧：不标「已更正」、没有变动、不亮红点
    const g = await guest({ action: 'myReceipts', tab: 'all' });
    const row = g.data.rows.find(x => x._id === 'r1');
    assert.strictEqual(row.amended, false);
    assert.deepStrictEqual(row.changes, []);
    const st = await guest({ action: 'giftStat' });
    assert.strictEqual(st.data.lastChangeAt, 0);
    // 现金无身份记录：关系 / 备注同样可改
    assert.strictEqual((await owner({ action: 'amend', rid: 'cash', remark: '红包' })).code, 0);
  });
});

test('amend 超期：金额、姓名仍被锁（连同关系一起提交也整笔拒绝）；现金无身份记录说明无法更正；作废仍被锁', async () => {
  await at(NOW, async () => {
    seed([rec('r1'), rec('cash', { payerOpenid: '', deskEntry: true, payMethod: 'cash' })]);
    const a = await owner({ action: 'amend', rid: 'r1', amount: 800 });
    assert.strictEqual(a.code, 1);
    assert.ok(/72 小时/.test(a.msg) && /金额或姓名/.test(a.msg) && /申请更正/.test(a.msg), a.msg);
    const n = await owner({ action: 'amend', rid: 'r1', payerName: '王六', relation: '同事' });
    assert.strictEqual(n.code, 1);
    assert.strictEqual(get('r1').payerName, '王五');
    assert.strictEqual(get('r1').relation, '朋友', '整笔拒绝');
    const c = await owner({ action: 'amend', rid: 'cash', amount: 1 });
    assert.ok(/无法申请更正/.test(c.msg), c.msg);
    assert.strictEqual((await owner({ action: 'void', rid: 'r1' })).code, 1);
  });
  // 72 小时内：金额修改照旧写 amendedAt / chgAt，带 paidAt 条件
  await at(NOW, async () => {
    seed([rec('r2', { paidAt: ago(5) })]);
    assert.strictEqual((await owner({ action: 'amend', rid: 'r2', amount: 700 })).code, 0);
    const d = get('r2');
    assert.ok(d.amendedAt && d.chgAt && d.changeNotifyAt);
    const upd = db.log.filter(x => x.op === 'update' && x.col === 'records').pop();
    assert.ok(JSON.stringify(upd.cond).includes('paidAt'));
  });
});

test('前端：超期后「修改」仍可点，弹层里金额姓名只读、关系备注可改并给「申请更正」入口；「更多」里有「申请更正」；倒计时文案', () => {
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/records/records.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/records/records.wxml'), 'utf8');
  assert.ok(!/stateOf\(r\) === 'locked'\) return this\.onCorrect/.test(js), '超期不再直接跳申请更正');
  assert.ok(js.includes("items.push(['申请更正'"));
  assert.ok(js.includes('onAmendToCorrect'));
  assert.ok(wxml.includes('bindtap="onAmendToCorrect"') && wxml.includes('amend.lockTip'));
  assert.ok(!wxml.includes('item.editOpen}}" data-idx="{{index}}" bindtap="onAmend"'), '修改按钮不再只在 72 小时内显示');
  const lock = require('../miniprogram/utils/editlock.js');
  assert.strictEqual(lock.hint({ editUntil: Date.now() - 1 }), '金额姓名已锁定');
  assert.ok(/^金额姓名还可改 \d+ 小时$/.test(lock.hint({ editUntil: Date.now() + 5 * H })));
});
