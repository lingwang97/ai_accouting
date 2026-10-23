// records.list 的查询条件：状态筛选、排序白名单、礼簿范围、关键词；以及待确认口径
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction } = require('./helpers/sdk-stub.js');

const OWNER = 'o-owner';
function seed() {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, orgMode: true, activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }, { openid: 'u-part', currentAid: 'acc1' }])
    .seed('members', [{ _id: 'm1', aid: 'acc1', memberOpenid: 'u-part', role: 'clerk', bookIds: ['b1', 'b2'], perms: ['confirm'] }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }, { _id: 'b2', ownerOpenid: OWNER }, { _id: 'b3', ownerOpenid: OWNER }]);
}

/** 跑一次 records.list，返回列表那条查询（带 skip / limit）与其余查询的日志 */
async function runList(openid, event) {
  seed();
  state.openid = openid;
  const fn = loadFunction('records');
  db.log.length = 0;
  const r = await fn.main({ action: 'list', ...event });
  assert.strictEqual(r.code, 0, r.msg);
  const gets = db.log.filter(l => l.op === 'get' && l.col === 'records');
  return { r, listQ: gets[gets.length - 1], log: db.log.slice() };
}
const statusOf = cond => {
  const c = cond.__op === 'and' ? cond.v[0] : cond;
  return c.status;
};
const baseOf = cond => (cond.__op === 'and' ? cond.v[0] : cond);

test('默认列表：已入簿 + 待确认 + 未点转账，时间倒序且带 _id 作第二键', async () => {
  const { listQ } = await runList(OWNER, {});
  assert.strictEqual(statusOf(listQ.cond).__op, 'in');
  assert.deepStrictEqual(statusOf(listQ.cond).v, ['paid', 'transferred', 'pending']);
  assert.deepStrictEqual(listQ.orders, [['createdAt', 'desc'], ['_id', 'desc']]);
  assert.strictEqual(baseOf(listQ.cond).ownerOpenid, OWNER);
});

test('status=confirm 只列待确认（transferred），status=paid 只列已入簿', async () => {
  let { listQ } = await runList(OWNER, { status: 'confirm' });
  assert.deepStrictEqual(statusOf(listQ.cond).v, ['transferred']);
  ({ listQ } = await runList(OWNER, { status: 'paid' }));
  assert.deepStrictEqual(statusOf(listQ.cond).v, ['paid']);
  ({ listQ } = await runList(OWNER, { status: 'whatever' })); // 非法值回落到全部
  assert.deepStrictEqual(statusOf(listQ.cond).v, ['paid', 'transferred', 'pending']);
});

test('排序：time_asc / amount_desc / 非法值回落时间倒序', async () => {
  assert.deepStrictEqual((await runList(OWNER, { sort: 'time_asc' })).listQ.orders, [['createdAt', 'asc'], ['_id', 'asc']]);
  assert.deepStrictEqual((await runList(OWNER, { sort: 'amount_desc' })).listQ.orders, [['amount', 'desc'], ['_id', 'desc']]);
  assert.deepStrictEqual((await runList(OWNER, { sort: 'name; drop' })).listQ.orders, [['createdAt', 'desc'], ['_id', 'desc']]);
});

test('分页参数：pageSize 限制在 1~50，page 至少 1', async () => {
  let { listQ } = await runList(OWNER, { page: 3, pageSize: 20 });
  assert.strictEqual(listQ.skip, 40); assert.strictEqual(listQ.limit, 20);
  ({ listQ } = await runList(OWNER, { page: -5, pageSize: 9999 }));
  assert.strictEqual(listQ.skip, 0); assert.strictEqual(listQ.limit, 50);
  ({ listQ } = await runList(OWNER, { page: 'x', pageSize: 0 }));
  assert.strictEqual(listQ.skip, 0); assert.strictEqual(listQ.limit, 20); // 0 视为未传，取默认 20
});

test('合计 / 笔数只统计 paid，待确认数只统计 transferred，与列表状态筛选无关', async () => {
  const { log } = await runList(OWNER, { status: 'confirm' });
  const counts = log.filter(l => l.op === 'count' && l.col === 'records').map(l => statusOf(l.cond));
  assert.ok(counts.includes('paid') && counts.includes('transferred'));
  const agg = log.find(l => l.op === 'aggregate');
  assert.strictEqual(statusOf(agg.stages[0][1]), 'paid');
});

test('只负责部分礼簿的记账人：未指定礼簿时限制为负责的礼簿，指定了范围外礼簿则落到 __none__', async () => {
  let { listQ } = await runList('u-part', {});
  assert.deepStrictEqual(baseOf(listQ.cond).bookId.v, ['b1', 'b2']);
  ({ listQ } = await runList('u-part', { bookId: 'b2' }));
  assert.strictEqual(baseOf(listQ.cond).bookId, 'b2');
  ({ listQ } = await runList('u-part', { bookId: 'b3' }));
  assert.strictEqual(baseOf(listQ.cond).bookId, '__none__');
});

test('主家可按任意礼簿 / 日期筛选；关键词用 and 组合而不是覆盖 where', async () => {
  const { listQ } = await runList(OWNER, { bookId: 'b3', payDay: '2026-10-01', keyword: '张' });
  assert.strictEqual(listQ.cond.__op, 'and');
  const base = listQ.cond.v[0];
  assert.strictEqual(base.bookId, 'b3'); assert.strictEqual(base.payDay, '2026-10-01');
  assert.strictEqual(listQ.cond.v[1].payerName.__op, 'regexp');
});

test('无身份的调用者不会读到别人的记录（ownerOpenid 为调用者自己）', async () => {
  const { listQ } = await runList('stranger', {});
  assert.strictEqual(baseOf(listQ.cond).ownerOpenid, 'stranger');
});

test('待确认页：待确认 / 宾客未点完成 / 未收到 三类的状态与时间阈值（3 分钟、24 小时）', async () => {
  seed();
  state.openid = OWNER;
  const fn = loadFunction('records');
  db.log.length = 0;
  const before = Date.now();
  const r = await fn.main({ action: 'pending', withRejected: true });
  assert.strictEqual(r.code, 0, r.msg);
  const conds = db.log.filter(l => l.op === 'get' && l.col === 'records').map(l => l.cond);
  const flat = JSON.stringify(conds, function (k, v) { const o = this[k]; return o instanceof Date ? 'D' + o.getTime() : v; });
  assert.ok(flat.includes('"status":"transferred"'), '待确认');
  assert.ok(flat.includes('"status":"pending"') && flat.includes('"status":"cancelled"') && flat.includes('"autoCancelled":true'), '宾客未点完成');
  assert.ok(flat.includes('"status":"rejected"'), '未收到');
  const times = [...flat.matchAll(/"__op":"(lt|gt)","v":"D(\d+)"/g)].map(m => [m[1], Number(m[2])]);
  const near = (t, ms) => Math.abs((before - t) - ms) < 60 * 1000; // 允许测试执行耗时
  assert.ok(times.some(([op, t]) => op === 'lt' && near(t, 3 * 60 * 1000)), '3 分钟阈值');
  assert.ok(times.filter(([op, t]) => op === 'gt' && near(t, 24 * 3600 * 1000)).length >= 2, '24 小时阈值（自动取消 + 未收到）');
});

test('expirePending：超过 30 分钟未点转账的 pending 被置为 cancelled(autoCancelled)', async () => {
  seed();
  state.openid = OWNER;
  const fn = loadFunction('records');
  db.log.length = 0;
  await fn.main({ action: 'list' });
  const upd = db.log.find(l => l.op === 'update' && l.col === 'records');
  assert.ok(upd, '应触发 expirePending');
  const c = upd.cond;
  assert.strictEqual(c.status, 'pending');
  const lt = c.createdAt;
  assert.strictEqual(lt.__op, 'lt');
  assert.ok(Math.abs((Date.now() - 30 * 60 * 1000) - lt.v.getTime()) < 60 * 1000);
});
