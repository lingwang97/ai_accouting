// v3.85.2：礼簿页「有改动」筛选（records.list status=changed）+ 改动类型标签与改动前后的值（utils/chginfo.js）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const chg = require('../miniprogram/utils/chginfo.js');

const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const OWNER = 'o-owner';
const DAY = 86400000;
const ago = d => new Date(Date.now() - d * DAY);

const rec = (id, extra) => ({ _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', payerOpenid: 'g1', payerName: '王' + id, amount: 100, payMethod: 'wechat', status: 'paid', relation: '朋友', createdAt: ago(1), paidAt: ago(1), ...extra });
function seed(records) {
  db.reset().applyUpdates = true;
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府', activeBookId: 'b1', orgMode: true }])
    .seed('users', [{ openid: OWNER }, { openid: 'clerk-a' }, { openid: 'fam' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '甲', type: 'wedding' }, { _id: 'b2', ownerOpenid: OWNER, name: '乙', type: 'other' }])
    .seed('members', [
      { _id: 'm1', aid: 'acc1', memberOpenid: 'clerk-a', role: 'clerk', bookIds: ['b1'], perms: ['confirm', 'desk'] },
      { _id: 'm2', aid: 'acc1', memberOpenid: 'fam', role: 'viewer', bookIds: ['b1'] }
    ])
    .seed('records', records);
}
const list = (openid, ev) => { state.openid = openid; return loadFunction('records').main({ action: 'list', ...ev }); };
const data = () => [
  rec('a1', { chgAt: ago(1), amendN: 1, amendedAt: ago(1), amendLog: [{ at: ago(1), by: '主家', changes: { amount: [200, 300] } }] }),
  rec('a2', { chgAt: ago(3), relation: '亲戚', payerName: '张三', amendLog: [{ at: ago(3), by: '主家', changes: { payerName: ['张三', '张山'] } }] }),
  rec('a3', { status: 'void', voidedAt: ago(2), chgAt: ago(2), bookId: 'b2' }),
  rec('old', { status: 'void', voidedAt: ago(40), chgAt: ago(40) }),
  rec('none'),
  rec('t1', { status: 'transferred', chgAt: ago(1) }),
  rec('rj', { status: 'rejected', rejectedAt: ago(1), chgAt: ago(1) })
];

test('list status=changed：已入簿 / 已作废且 chgAt 在 30 天内；按 chgAt 倒序（最早则正序）；不新增索引', async () => {
  seed(data());
  const r = await list(OWNER, { status: 'changed' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.deepStrictEqual(r.data.list.map(x => x._id).sort(), ['a1', 'a2', 'a3']);
  const q = db.log.filter(x => x.op === 'get' && x.col === 'records' && x.cond && JSON.stringify(x.cond).includes('chgAt')).pop();
  assert.deepStrictEqual(q.orders, [['chgAt', 'desc'], ['_id', 'desc']]);
  const st = q.cond.status;
  assert.deepStrictEqual(st.v.slice().sort(), ['paid', 'void']);
  assert.ok(q.cond.ownerOpenid === OWNER);
  await list(OWNER, { status: 'changed', sort: 'time_asc' });
  const q2 = db.log.filter(x => x.op === 'get' && x.col === 'records' && x.cond && JSON.stringify(x.cond).includes('chgAt')).pop();
  assert.deepStrictEqual(q2.orders, [['chgAt', 'asc'], ['_id', 'asc']]);
  // 其他筛选的口径不变
  assert.ok(!(await list(OWNER, { status: 'paid' })).data.list.some(x => x._id === 'rj'));
  // 索引：records 仍是 17 条，没有为它新增
  const sys = rd('cloudfunctions/system/index.js').replace(/\r/g, '');
  const body = sys.match(/const INDEXES = \[([\s\S]*?)\n\];/)[1];
  assert.strictEqual([...body.matchAll(/\['records', '/g)].length, 17);
  assert.ok(!/'records', '\w*chg\w*', \[\[('ownerOpenid'|'bookId')/.test(body));
  assert.ok(/chgAt[\s\S]{0,200}owner_book_status|owner_book_status[\s\S]{0,400}chgAt/.test(rd('cloudfunctions/records/index.js')), '代码注释写明索引取舍');
});

test('list status=changed：与礼簿、关系、搜索、日期叠加（同一个 where 里 AND）', async () => {
  seed(data());
  assert.deepStrictEqual((await list(OWNER, { status: 'changed', bookId: 'b1' })).data.list.map(x => x._id).sort(), ['a1', 'a2']);
  assert.deepStrictEqual((await list(OWNER, { status: 'changed', bookId: 'b2' })).data.list.map(x => x._id), ['a3']);
  assert.deepStrictEqual((await list(OWNER, { status: 'changed', relation: '亲戚' })).data.list.map(x => x._id), ['a2']);
  assert.deepStrictEqual((await list(OWNER, { status: 'changed', keyword: '张三' })).data.list.map(x => x._id), ['a2']);
  const q = db.log.filter(x => x.op === 'get' && x.col === 'records').pop();
  assert.ok(JSON.stringify(q.cond).includes('chgAt') && JSON.stringify(q.cond).includes('payerName'), '搜索与有改动在同一个 where');
  assert.deepStrictEqual((await list(OWNER, { status: 'changed', sort: 'dup' })).data.list, [], '只看重名叠加：没有同名的就为空');
  assert.strictEqual((await list(OWNER, { status: 'changed' })).data.listTotal, 3);
  // 顶部合计仍是整本已入簿口径（不随「有改动」变化）
  const all = await list(OWNER, {});
  const ch = await list(OWNER, { status: 'changed' });
  assert.strictEqual(ch.data.sum, all.data.sum);
  assert.strictEqual(ch.data.total, all.data.total);
});

test('list status=changed：记账人 / 家人共享只在负责 / 共享的礼簿范围内', async () => {
  seed(data());
  const c = await list('clerk-a', { status: 'changed' });
  assert.strictEqual(c.code, 0, c.msg);
  assert.deepStrictEqual(c.data.list.map(x => x._id).sort(), ['a1', 'a2'], '不含 b2 的 a3');
  assert.deepStrictEqual((await list('clerk-a', { status: 'changed', bookId: 'b2' })).data.list, [], '指定别的礼簿也看不到');
  const v = await list('fam', { status: 'changed' });
  assert.deepStrictEqual(v.data.list.map(x => x._id).sort(), ['a1', 'a2']);
  assert.ok(v.data.list.every(x => !x.trail && !('payerOpenid' in x)));
  assert.ok(!JSON.stringify(c.data).includes('g1'));
});

const mk = (extra) => ({ amount: 300, payerName: '张山', status: 'paid', ...extra });

test('chginfo.of：类型标签与改动前后的值（金额 / 姓名 / 作废 / 更正待确认 / 随礼人拒绝 / 已过期）', () => {
  const am = (changes, by) => ({ amendLog: [{ at: ago(5), by: by || '主家', changes: { remark: ['', 'x'] } }, { at: ago(1), by: by || '主家', changes }], amendedAt: ago(1) });
  let c = chg.of(mk(am({ amount: [200, 300] })));
  assert.strictEqual(c.tag, '已更正');
  assert.strictEqual(c.text, '金额 ￥200.00 → ￥300.00', '多次修改只显示最近一次');
  c = chg.of(mk(am({ payerName: ['张三', '张山'] })));
  assert.strictEqual(c.text, '姓名 张三 → 张山');
  c = chg.of(mk(am({ amount: [200, 300], relation: ['', '朋友'] })));
  assert.strictEqual(c.text, '金额 ￥200.00 → ￥300.00；关系 空 → 朋友');
  assert.ok(chg.of(mk(am({ amount: [1, 2] }, '随礼人同意更正'))).text.endsWith('（随礼人同意）'));
  c = chg.of(mk({ status: 'void', voidedAt: ago(1) }));
  assert.strictEqual(c.tag, '已作废');
  assert.ok(c.text.startsWith('作废前 金额 ￥300.00'));
  const corr = (kind, extra) => mk({ corrState: 'pending', corrAt: ago(1), correction: { kind, newAmount: 500, newName: '张珊', reason: '写错了', state: 'pending' }, ...extra });
  c = chg.of(corr('amount'));
  assert.strictEqual(c.tag, '更正待确认');
  assert.strictEqual(c.text, '申请 金额 ￥300.00 → ￥500.00；理由：写错了');
  assert.strictEqual(chg.of(corr('name')).text, '申请 姓名 张山 → 张珊；理由：写错了');
  assert.ok(chg.of(corr('void')).text.startsWith('申请作废这笔'));
  c = chg.of(corr('amount', { corrState: 'declined', corrDecidedAt: ago(0.5) }));
  assert.strictEqual(c.tag, '随礼人拒绝');
  assert.ok(c.text.includes('金额 ￥300.00 → ￥500.00') && c.text.includes('记录不变'));
  assert.strictEqual(chg.of(corr('amount', { corrState: 'expired' })).tag, '已过期');
  // 拒绝之前已有更晚的修改：仍显示最近的修改
  assert.strictEqual(chg.of(corr('amount', { corrState: 'declined', corrDecidedAt: ago(9), ...am({ amount: [200, 300] }) })).tag, '已更正');
  assert.strictEqual(chg.of(mk({})), null);
  assert.strictEqual(chg.of(null), null);
});

test('chginfo.detail：完整修改记录（amendLog）+ 处理经过（trail），新的在前', () => {
  const r = mk({
    amendLog: [{ at: ago(5), by: '主家', changes: { amount: [100, 200] } }, { at: ago(1), by: '小李', changes: { amount: [200, 300] } }],
    trail: [{ at: ago(4), act: 'corr_ask', who: 'owner', name: '主家', why: '写错了' }, { at: ago(3), act: 'corr_decline', who: 'guest', name: '王' }]
  });
  const d = chg.detail(r);
  assert.ok(d.startsWith('【修改记录】'));
  assert.ok(d.indexOf('￥200.00 → ￥300.00') < d.indexOf('￥100.00 → ￥200.00'), '新的在前');
  assert.ok(d.includes('【处理经过】') && d.includes('申请更正') && d.includes('拒绝更正') && d.includes('写错了'));
  assert.strictEqual(chg.detail(mk({})), '暂无');
});

test('前端接线：状态分段 5 项（全部 / 待确认 / 未收到 / 已入簿 / 有改动）、可横向滑动、标签行、合计口径提示、按钮字数', () => {
  const js = rd('miniprogram/pages/records/records.js');
  const wxml = rd('miniprogram/pages/records/records.wxml');
  const wxss = rd('miniprogram/pages/records/records.wxss');
  assert.ok(js.includes("statuses: ['全部', '待确认', '未收到', '已入簿', '有改动']"));
  assert.ok(js.includes("const ST_KEYS = ['all', 'confirm', 'rejected', 'paid', 'changed']"));
  assert.ok(/\.st-seg \{[^}]*overflow-x: auto/.test(wxss) && /\.st-seg \.seg-item \{[^}]*flex: 1 0 auto[^}]*white-space: nowrap/.test(wxss));
  assert.ok(wxml.includes('stIdx === 4 && item.chg') && wxml.includes('item.chg.tag') && wxml.includes('item.chg.text') && wxml.includes('onChgLog'));
  assert.ok(wxml.includes('合计与份数仍是整本已入簿的口径'));
  assert.ok(js.includes("title: '改动经过'") && /confirmText: '知道了'/.test(js));
  assert.ok(rd('miniprogram/pages/guide/faq.js').includes('「有改动」') && rd('miniprogram/pages/guide/guide.js').includes('「有改动」'));
});
