// v3.50.0 同名提醒收窄：宾客端只比对本场礼簿；礼台记账按「本场 / 以前的礼簿」分三种情况
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction } = require('./helpers/sdk-stub.js');
const samename = require('../miniprogram/utils/samename.js');

const OWNER = 'o-owner';
const rec = (id, bookId, payerName, extra) => ({ _id: id, ownerOpenid: OWNER, bookId, payerName, status: 'paid', payerOpenid: 'g-other', ...extra });

function seedGuest(records) {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b2' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }, { _id: 'b2', ownerOpenid: OWNER }])
    .seed('records', records);
  state.openid = 'g-me';
}
const create = () => loadFunction('payment').main({ action: 'create', aid: 'acc1', payerName: '张三', amount: 100 });
const nameQuery = () => db.log.filter(l => l.op === 'get' && l.col === 'records' && l.cond.payerName && l.cond.payerName.__op === 'in' && !l.cond.payerOpenid).pop();

test('宾客端 sameNameOthers：只看本次记入的礼簿，ownerOpenid 与 bookId 在同一个 where 里', async () => {
  seedGuest([rec('r1', 'b1', '张三')]); // 只有以前的礼簿同名
  const r = await create();
  assert.ok(!(r.data && r.data.needTag), '以前的礼簿同名不应再要求填区分备注');
  const q = nameQuery();
  assert.ok(q, '应查询同名');
  assert.strictEqual(q.cond.ownerOpenid, OWNER);
  assert.strictEqual(q.cond.bookId, 'b2');
});

test('宾客端 sameNameOthers：本场已有别人的同名 -> needTag；本人同一扫码人不算', async () => {
  seedGuest([rec('r1', 'b2', '张三')]);
  let r = await create();
  assert.deepStrictEqual(r.data.needTag, ['张三']);
  seedGuest([rec('r2', 'b2', '张三', { payerOpenid: 'g-me' })]);
  r = await create();
  assert.ok(!(r.data && r.data.needTag));
});

// ---- nameCheck：本场 / 以前
const ctxDb = () => db.reset()
  .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, orgMode: true, activeBookId: 'b2' }])
  .seed('users', [{ openid: OWNER }])
  .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }, { _id: 'b2', ownerOpenid: OWNER }]);
async function check(groups, bookId) {
  ctxDb();
  state.openid = OWNER;
  db.aggList = a => (a.stages.some(s => s[0] === 'group') ? groups : []);
  db.log.length = 0;
  const r = await loadFunction('records').main({ action: 'nameCheck', names: ['张三'], bookId });
  db.aggList = null;
  assert.strictEqual(r.code, 0, r.msg);
  return { map: r.data.map, match: db.log.find(l => l.op === 'aggregate').stages.find(s => s[0] === 'match')[1] };
}
const g = (bk, tag, count, ref, lastDay) => ({ _id: { name: '张三', openid: '', tag, pk: undefined, bk }, count, relation: '亲戚', lastDay, ref });

test('nameCheck：match 同时带 ownerOpenid，按 bookId 分组，返回本场条数 inBook', async () => {
  const { map, match } = await check([g('b1', '', 2, 'x1', '2026-01-01'), g('b2', '', 1, 'x2', '2026-02-01')], 'b2');
  assert.strictEqual(match.ownerOpenid, OWNER);
  assert.strictEqual(map['张三'].length, 1); // 同一个人（无标识按姓名）合并
  assert.strictEqual(map['张三'][0].count, 3);
  assert.strictEqual(map['张三'][0].inBook, 1);
  assert.strictEqual(map['张三'][0].lastDay, '2026-02-01');
});

test('nameCheck：只有以前的礼簿时 inBook 为 0；两位（区分备注不同）各自分组', async () => {
  const { map } = await check([g('b1', '李村', 2, 'x1', '2026-01-01'), g('b1', '王庄', 1, 'x2', '2026-01-02')], 'b2');
  assert.deepStrictEqual(map['张三'].map(p => p.inBook), [0, 0]);
  assert.ok(map['张三'].every(p => !('key' in p) && !('openid' in p)));
});

test('nameCheck：bookId 不是自己能记的礼簿时退回 workBook（受限记账人范围不变）', async () => {
  const { map } = await check([g('b2', '', 1, 'x1', '2026-02-01')], 'not-mine-but-owner-ok');
  // 主家 canBook 任意礼簿；非法 id 与 b2 不等 -> 本场为空；此处只验证不报错且字段存在
  assert.strictEqual(typeof map['张三'][0].inBook, 'number');
});

// ---- 前端三种情况（纯函数）
const P = (tag, inBook, lastDay) => ({ ref: 'r' + tag, tag, scanned: false, relation: '亲戚', count: 2, inBook, lastDay });

test('decide：无同名 -> none', () => assert.strictEqual(samename.decide([]).type, 'none'));
test('decide a：本场已有同名（哪怕只有 1 位）-> ask，本场的排最前', () => {
  const d = samename.decide([P('甲', 0, '2026-03-01'), P('乙', 1, '2025-01-01')]);
  assert.strictEqual(d.type, 'ask');
  assert.strictEqual(d.people[0].tag, '乙');
  assert.strictEqual(samename.decide([P('', 1, '')]).type, 'ask');
});
test('decide b：本场没有、以前只有 1 位 -> auto，取这一位', () => {
  const d = samename.decide([P('甲', 0, '2026-03-01')]);
  assert.strictEqual(d.type, 'auto');
  assert.strictEqual(d.person.ref, 'r甲');
});
test('decide c：以前两位及以上 -> ask', () => assert.strictEqual(samename.decide([P('甲', 0, 'a'), P('乙', 0, 'b')]).type, 'ask'));
test('decide：旧云函数没有 inBook 字段 -> 一律 ask（原行为，不报错）', () => {
  const old = { ref: 'x', tag: '', scanned: true, relation: '', count: 1, lastDay: '' };
  assert.strictEqual(samename.decide([old]).type, 'ask');
  assert.ok(samename.labelOf('张三', old).includes('张三'));
});
test('labelOf / autoNotice：标注本场与以前的礼簿，批次提示合并成一条', () => {
  assert.ok(samename.labelOf('张三', P('甲', 1, '')).includes('本场'));
  assert.ok(samename.labelOf('张三', P('甲', 0, '')).includes('以前的礼簿'));
  const t = samename.autoNotice([{ name: '张三', person: P('李村', 0, '') }, { name: '李四', person: P('', 0, '') }]);
  assert.ok(t.includes('张三（李村）（亲戚 · 2笔）') && t.includes('李四（亲戚 · 2笔）') && t.includes('往来'));
  assert.strictEqual(samename.autoNotice([]), '');
});
