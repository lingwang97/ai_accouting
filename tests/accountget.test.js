// v3.66.2：account.get 的刷新档位 / 高峰到期共用一次套餐读取（原先 pollLevelOf、peakOf 各读一次），输出不变
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction } = require('./helpers/sdk-stub.js');

const OWNER = 'o-owner';
const HOUR = 3600 * 1000;

function seed(opts) {
  const o = opts || {};
  db.reset().applyUpdates = true;
  db.seed('subscriptions', o.free ? [] : [{ _id: OWNER, plan: 'pro', expiresAt: new Date(Date.now() + 30 * 24 * HOUR) }])
    .seed('settings', o.free ? [{ _id: 'plans', free: { name: '免费版', features: { peakMode: false, fastRefresh: false } }, pro: { name: '专业版', features: {} } }] : [])
    .seed('users', [{ openid: OWNER, pollLevel: 'mid' }, { openid: 'c-desk', pollLevel: 'high' }, { openid: 'v1', pollLevel: 'high' }])
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1', accountName: '张府', peakUntil: new Date(Date.now() + HOUR) }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '礼簿', statReady: true }])
    .seed('members', [
      { _id: 'm1', aid: 'acc1', memberOpenid: 'c-desk', role: 'clerk', soloBookId: 'b1', perms: ['desk'] },
      { _id: 'm2', aid: 'acc1', memberOpenid: 'v1', role: 'viewer', bookIds: ['b1'] },
      { _id: 'm3', aid: 'acc1', memberOpenid: 'p1', role: 'clerk', status: 'pending' }
    ]);
}

// 统计 subscriptions 的读取次数（planOf 每次读一次）
const origCol = db.collection.bind(db);
let subReads = 0;
db.collection = name => {
  const c = origCol(name);
  if (name !== 'subscriptions') return c;
  return new Proxy(c, { get(t, k) { if (k === 'doc') return (...a) => { const d = t.doc(...a); return new Proxy(d, { get(dt, dk) { if (dk === 'get') return (...x) => { subReads++; return dt.get(...x); }; const v = dt[dk]; return typeof v === 'function' ? v.bind(dt) : v; } }); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
};

const get = async who => { state.openid = who; const r = await loadFunction('account').main({ action: 'get' }); assert.strictEqual(r.code, 0, r.msg); return r.data; };

test('account.get：套餐只读一次，刷新档位 / 高峰到期 / 待处理申请数 / 身份列表与原来一致', async () => {
  seed();
  subReads = 0;
  const d = await get(OWNER);
  assert.strictEqual(subReads, 1, '套餐订阅只读一次');
  assert.strictEqual(d.pollLevel, 'off', 'v3.70.0 起没有手动档位：恒为 off（旧前端按标准刷新）');
  assert.ok(d.peakUntil > Date.now());
  assert.strictEqual(d.role, 'owner');
  assert.strictEqual(d.pendingMembers, 1);
  assert.deepStrictEqual(d.identities.map(x => x.role), ['owner']);
});

test('account.get：无确认权限记账人 / 家人 / 免费版 档位为 off、高峰为 0，且不读套餐', async () => {
  seed();
  subReads = 0;
  const c = await get('c-desk'), v = await get('v1');
  assert.deepStrictEqual([c.pollLevel, c.peakUntil, c.pendingMembers], ['off', 0, 0]);
  assert.deepStrictEqual([v.pollLevel, v.peakUntil], ['off', 0]);
  assert.strictEqual(subReads, 0);
  seed({ free: true });
  const f = await get(OWNER);
  assert.deepStrictEqual([f.pollLevel, f.peakUntil], ['off', 0]);
});
