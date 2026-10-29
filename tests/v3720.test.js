// v3.72.0：原子限流（并发不能越过上限、reqId 重放不计数、礼簿维度）、resolveCtx 只对「不存在」降级、
// personkey 伪造文档报错不回退旧密钥、带 _openid 的伪造记录 / 人员不出现在主家侧查询、记账人扩大家人共享需主家同意
const assert = require('assert');
const crypto = require('crypto');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction } = require('./helpers/sdk-stub.js');
const { resolveCtx, srvCol } = require('../tools/cloud-shared/ctx.js');
const PKmod = require('../cloudfunctions/renqing/personkey.js');

const OWNER = 'o-owner';
const quiet = async fn => {
  const w = console.warn, e = console.error;
  console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = w; console.error = e; }
};

/** 指定集合的 add 按真实数据库语义：_id 重复时报错（fakedb 默认不检查） */
function strictRateLimits(names) {
  names = names || ['rate_limits'];
  const orig = db.collection.bind(db);
  db.collection = name => {
    const c = orig(name);
    if (!names.includes(name)) return c;
    return {
      ...c,
      add: async o => {
        const rows = db.data[name] || [];
        if (o.data._id && rows.some(d => d._id === o.data._id)) throw new Error('duplicate key _id');
        db.data[name] = rows.concat([{ ...o.data }]);
        return { _id: o.data._id };
      }
    };
  };
  return () => { delete db.collection; };
}

test('takeSlot：10 个并发请求只放行 RATE_MAX(3) 个；按姓名个数计的 10 分钟桶并发也不越过 20', async () => {
  db.reset();
  db.applyUpdates = true;
  const restore = strictRateLimits();
  try {
    const { takeSlot } = loadFunction('payment')._test;
    const now = new Date();
    const res = await Promise.all(Array.from({ length: 10 }, () => takeSlot('rp_g1', 60 * 1000, 3, 1, now)));
    assert.strictEqual(res.filter(Boolean).length, 3);
    const doc = db.data.rate_limits.find(d => d._id.startsWith('rp_g1_'));
    assert.strictEqual(doc.n, 3);
    assert.ok(doc.at instanceof Date, '带 at 供 warmer 清理');
    // 同名检查：每次 5 个姓名，上限 20 → 并发 6 次只放行 4 次
    const nc = await Promise.all(Array.from({ length: 6 }, () => takeSlot('nc_g1', 10 * 60 * 1000, 20, 5, now)));
    assert.strictEqual(nc.filter(Boolean).length, 4);
    // 一次超过上限的直接拒绝
    assert.strictEqual(await takeSlot('nc_g2', 10 * 60 * 1000, 20, 21, now), false);
    // 下一分钟是新的时间桶
    assert.strictEqual(await takeSlot('rp_g1', 60 * 1000, 3, 1, new Date(now.getTime() + 60 * 1000)), true);
  } finally { restore(); }
});

// ---- create：reqId 重放不计数；付款人 / 礼簿每分钟上限
function seedGuest() {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }])
    .seed('records', []);
  state.openid = 'g-me';
}
const minute = () => Math.floor(Date.now() / 60000);
const fullBucket = (key, n) => [minute(), minute() + 1].map(b => ({ _id: `${key}_${b}`, n, at: new Date() }));
const create = extra => quiet(() => loadFunction('payment').main({ action: 'create', aid: 'acc1', payerName: '张三', amount: 100, ...extra }));

test('create：付款人本分钟已满 3 次 → 操作太频繁；同一 reqId 上次已写入的重试直接走幂等、不计数', async () => {
  seedGuest();
  db.seed('rate_limits', fullBucket('rp_g-me', 3));
  let r = await create({ reqId: 'req-0001-abcd' });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.msg, '操作太频繁，请稍后再试');
  // 上次已写入（前端没收到结果）：记录 _id = q + md5(主家:付款人:reqId) 前 24 位 + 00
  const key = crypto.createHash('md5').update(OWNER + ':g-me:req-0001-abcd').digest('hex').slice(0, 24);
  db.seed('records', [{ _id: 'q' + key + '00', ownerOpenid: OWNER, payerOpenid: 'g-me', payerName: '张三', amount: 100, status: 'transferred', bookId: 'b1' }]);
  db.log.length = 0;
  const restore = strictRateLimits(['records']);
  try { r = await create({ reqId: 'req-0001-abcd' }); } finally { restore(); }
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(r.data.record.status, 'transferred', '按库里真实状态返回');
  assert.ok(!db.log.some(l => l.col === 'rate_limits'), '重放不读写限流计数');
});

test('create：伪造的同 _id 记录（带 _openid）不算重放，照常计数', async () => {
  seedGuest();
  db.seed('rate_limits', fullBucket('rp_g-me', 3));
  const key = crypto.createHash('md5').update(OWNER + ':g-me:req-0002-abcd').digest('hex').slice(0, 24);
  db.seed('records', [{ _id: 'q' + key + '00', _openid: 'g-me', ownerOpenid: OWNER, status: 'paid' }]);
  const r = await create({ reqId: 'req-0002-abcd' });
  assert.strictEqual(r.msg, '操作太频繁，请稍后再试');
});

test('create：同一本礼簿本分钟已满 BOOK_RATE_MAX(60) → 提示稍等；条件更新用 n <= max-k 与 _.inc', async () => {
  seedGuest();
  db.seed('rate_limits', fullBucket('rb_b1', 60));
  db.log.length = 0;
  const r = await create({});
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.msg, '现在随礼的人较多，请稍等片刻再试');
  const up = db.log.find(l => l.op === 'update' && l.col === 'rate_limits');
  assert.strictEqual(up.cond.n.__op, 'lte');
  assert.strictEqual(up.cond.n.v, 2);
  assert.strictEqual(up.data.n.__op, 'inc');
});

test('warmer.cleanRateLimits：删除 at 早于 1 天前的计数', async () => {
  db.reset();
  db.log.length = 0;
  await loadFunction('warmer')._test.cleanRateLimits();
  const rm = db.log.find(l => l.op === 'remove' && l.col === 'rate_limits');
  assert.strictEqual(rm.cond.at.__op, 'lt');
  const age = Date.now() - rm.cond.at.v.getTime();
  assert.ok(age >= 24 * 3600 * 1000 - 1000 && age < 24 * 3600 * 1000 + 60000);
});

// ---- resolveCtx：只有「集合 / 文档不存在」降级，其余错误抛出
function failing(colName, error) {
  const orig = db.collection.bind(db);
  db.collection = name => {
    if (name !== colName) return orig(name);
    const q = { limit: () => q, field: () => q, orderBy: () => q, get: async () => { throw error; }, count: async () => { throw error; } };
    return { ...orig(name), where: () => q, doc: () => ({ get: async () => { throw error; } }) };
  };
  return () => { delete db.collection; };
}

test('resolveCtx：users / members 读超时抛出 ctxFail（不再当成主家本人），云函数返回 code 2「网络异常，请重试」', async () => {
  db.reset()
    .seed('accounts', [{ _id: 'own', ownerOpenid: 'c1' }, { _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1' }])
    .seed('users', [{ openid: 'c1', currentAid: 'acc1' }])
    .seed('members', [{ _id: 'm1', aid: 'acc1', memberOpenid: 'c1', role: 'clerk', allBooks: true, status: 'active' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }]);
  // 正常：记账人身份
  assert.strictEqual((await resolveCtx(db, 'c1')).ownerOpenid, OWNER);
  for (const col of ['users', 'members', 'accounts']) {
    const restore = failing(col, Object.assign(new Error('timeout'), { errCode: -1 }));
    try {
      await assert.rejects(() => resolveCtx(db, 'c1'), e => e.ctxFail === true, col);
      state.openid = 'c1';
      const r = await quiet(() => loadFunction('records').main({ action: 'dashboard' }));
      assert.deepStrictEqual(r, { code: 2, msg: '网络异常，请重试', data: null }, col);
    } finally { restore(); }
  }
});

test('resolveCtx：集合不存在（新环境）仍降级为无身份，不报错', async () => {
  db.reset();
  const restore = failing('members', Object.assign(new Error('collection not exist'), { errCode: -502005 }));
  try {
    const ctx = await resolveCtx(db, 'nobody');
    assert.strictEqual(ctx.role, 'none');
  } finally { restore(); }
});

test('records 轮询身份缓存：解析失败不写入缓存，网络恢复后重新解析', async () => {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }]);
  state.openid = OWNER;
  const m = loadFunction('records');
  const restore = failing('users', new Error('ESOCKETTIMEDOUT'));
  let r;
  try { r = await quiet(() => m.main({ action: 'pendingStat', aid: 'acc1' })); } finally { restore(); }
  assert.strictEqual(r.code, 2);
  r = await quiet(() => m.main({ action: 'pendingStat', aid: 'acc1' }));
  assert.strictEqual(r.code, 0, r.msg);
});

test('前端 request.js：code 2 按网络错误处理（e.net，非业务错误）', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'miniprogram', 'utils', 'request.js'), 'utf8');
  assert.ok(/r\.code === 2[\s\S]{0,300}e\.net = true/.test(src));
});

// ---- personkey：伪造文档报错并告警，不回退旧默认密钥
function pkDb(doc) {
  db.reset();
  if (doc) db.seed('sys_config', [doc]);
  return db;
}

test('personkey：person_key 带 _openid → getKey 报错（forged）、告警并记录 forged 状态，不回退 LEGACY', async () => {
  pkDb({ _id: 'person_key', _openid: 'attacker', secret: 'x'.repeat(64) });
  db.persist = true;
  const errs = [];
  const e0 = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const pk = PKmod.create(db, {});
    await assert.rejects(() => pk.getKey(), e => e.forged === true);
    assert.ok(errs.some(s => s.includes('PERSON_KEY_FORGED')));
  } finally { console.error = e0; }
  const st = db.data.sys_config.find(d => d._id === 'person_key_state');
  assert.strictEqual(st.source, 'forged');
  // renqing 返回明确提示
  state.openid = OWNER;
  const r = await quiet(() => loadFunction('renqing').main({ action: 'people' }));
  assert.strictEqual(r.code, 1);
  assert.ok(/密钥/.test(r.msg));
});

test('personkey：环境变量 PERSON_KEY_SECRET 优先级不变（伪造文档也不影响）；正常文档照常使用、标识不变', async () => {
  pkDb({ _id: 'person_key', _openid: 'attacker', secret: 'x'.repeat(64) });
  const envKey = await PKmod.create(db, { PERSON_KEY_SECRET: 's3cret' }).getKey();
  assert.deepStrictEqual(envKey, crypto.createHash('sha256').update('s3cret').digest());
  pkDb({ _id: 'person_key', secret: 'y'.repeat(64) });
  const pk = PKmod.create(db, {});
  const key = await pk.getKey();
  assert.deepStrictEqual(key, crypto.createHash('sha256').update('y'.repeat(64)).digest());
  const h = pk.hideKeyWith(key, 'o:oABC_123:张三');
  assert.strictEqual(pk.showKeyWith(key, h), 'o:oABC_123:张三');
});

// ---- _openid 过滤（问1A）
test('records.list / 汇总：带 _openid 的伪造记录不出现、不计入；条件里有 _openid 不存在', async () => {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }])
    .seed('records', [
      { _id: 'r1', ownerOpenid: OWNER, bookId: 'b1', status: 'paid', payerName: '张三', amount: 100, createdAt: new Date() },
      { _id: 'f1', _openid: 'x', ownerOpenid: OWNER, bookId: 'b1', status: 'paid', payerName: '假的', amount: 9999, createdAt: new Date() }
    ]);
  state.openid = OWNER;
  db.log.length = 0;
  const r = await loadFunction('records').main({ action: 'list', bookId: 'b1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.deepStrictEqual(r.data.list.map(x => x._id), ['r1']);
  assert.strictEqual(r.data.total, 1);
  const recQ = db.log.filter(l => l.col === 'records' && (l.op === 'get' || l.op === 'count'));
  assert.ok(recQ.length && recQ.every(l => JSON.stringify(l.cond).includes('"_openid":{"__op":"exists","v":false')), '每个 records 查询都带 _openid 不存在');
  const agg = db.log.filter(l => l.op === 'aggregate' && l.col === 'records');
  assert.ok(agg.length && agg.every(l => l.stages[0][1]._openid && l.stages[0][1]._openid.v === false));
});

test('srvCol：_.and 条件并进同一层，_.or 外面套 and；已带 _openid 的条件不重复加', () => {
  const _ = db.command;
  const c = srvCol(db, 'records');
  db.log.length = 0;
  c.where(_.and([{ a: 1 }, { b: 2 }])).get();
  c.where(_.or([{ a: 1 }, { b: 2 }])).get();
  c.where({ a: 1, _openid: 'keep' }).get();
  const [q1, q2, q3] = db.log.map(l => l.cond);
  assert.strictEqual(q1.__op, 'and'); assert.strictEqual(q1.v.length, 3);
  assert.strictEqual(q2.__op, 'and'); assert.strictEqual(q2.v[0].__op, 'or');
  assert.strictEqual(q3._openid, 'keep');
});

test('payment：伪造记录（带 _openid）不能被确认 / 作废（getRecord 读后判 trusted）', async () => {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }])
    .seed('records', [{ _id: 'f1', _openid: 'x', ownerOpenid: OWNER, bookId: 'b1', status: 'transferred', payerName: '假', amount: 1 }]);
  state.openid = OWNER;
  const r = await quiet(() => loadFunction('payment').main({ action: 'confirm', rid: 'f1' }));
  assert.notStrictEqual(r.code, 0);
});

test('account：伪造的人员（带 _openid）不出现在人员列表、不能被当作记账人修改', async () => {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, orgMode: true, activeBookId: 'b1' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }])
    .seed('members', [
      { _id: 'm1', aid: 'acc1', memberOpenid: 'c1', role: 'clerk', allBooks: true, status: 'active' },
      { _id: 'mf', _openid: 'x', aid: 'acc1', memberOpenid: 'cx', role: 'clerk', allBooks: true, status: 'active' }
    ]);
  state.openid = OWNER;
  db.log.length = 0;
  const r = await quiet(() => loadFunction('account').main({ action: 'members' }));
  assert.strictEqual(r.code, 0, r.msg);
  const q = db.log.find(l => l.op === 'get' && l.col === 'members' && l.cond.aid === 'acc1');
  assert.ok(q.cond._openid && q.cond._openid.v === false);
  assert.ok(!JSON.stringify(r.data).includes('mf'));
  const u = await quiet(() => loadFunction('account').main({ action: 'memberUpdate', memberId: 'mf', title: '礼台' }));
  assert.strictEqual(u.msg, '人员不存在');
});

// ---- 问2A：记账人只能收窄家人共享，新增的礼簿需主家同意
function shareDb() {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, orgMode: true, activeBookId: 'b1' }])
    .seed('users', [{ openid: 'c1', currentAid: 'acc1', nickname: '小王' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER }, { _id: 'b2', ownerOpenid: OWNER }, { _id: 'b3', ownerOpenid: OWNER }])
    .seed('members', [
      { _id: 'm1', aid: 'acc1', memberOpenid: 'c1', role: 'clerk', allBooks: true, perms: ['members', 'confirm'], status: 'active', displayName: '王五' },
      { _id: 'v1', aid: 'acc1', memberOpenid: 'fam', role: 'viewer', bookIds: ['b1', 'b2'], status: 'active', displayName: '家人' }
    ]);
  db.persist = true;
}

test('memberUpdate（家人共享）：记账人收窄立即生效，新增的礼簿记为待主家同意的申请（addTo）', async () => {
  shareDb();
  state.openid = 'c1';
  const r = await quiet(() => loadFunction('account').main({ action: 'memberUpdate', memberId: 'v1', bookIds: ['b1', 'b3'] }));
  assert.strictEqual(r.code, 0, r.msg);
  assert.deepStrictEqual(r.data.bookIds, ['b1'], 'b2 收回、b3 不直接生效');
  assert.strictEqual(r.data.pendingAdd, 1);
  const p = db.data.members.find(m => m.addTo === 'v1');
  assert.ok(p, '应新增一条待同意申请');
  assert.strictEqual(p.status, 'pending');
  assert.deepStrictEqual(p.bookIds, ['b3']);
  assert.strictEqual(p.role, 'viewer');
  assert.strictEqual(p.inviteFrom, '王五');
  // 已有待同意申请时再加：合并到同一条，不新增
  const before = db.data.members.length;
  db.data.members.find(m => m.addTo === 'v1')._id = 'p1';
  await quiet(() => loadFunction('account').main({ action: 'memberUpdate', memberId: 'v1', bookIds: ['b1', 'b2'] }));
  assert.strictEqual(db.data.members.length, before);
});

test('memberUpdate（家人共享）：主家本人扩大照常直接生效', async () => {
  shareDb();
  state.openid = OWNER;
  const r = await quiet(() => loadFunction('account').main({ action: 'memberUpdate', memberId: 'v1', bookIds: ['b1', 'b2', 'b3'] }));
  assert.strictEqual(r.code, 0, r.msg);
  assert.deepStrictEqual(r.data.bookIds.sort(), ['b1', 'b2', 'b3']);
  assert.ok(!r.data.pendingAdd);
  assert.ok(!db.data.members.some(m => m.addTo === 'v1'));
});
