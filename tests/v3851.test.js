// v3.85.1：「我的随礼记录」分标签分页 + records 索引精简（随礼人侧 6 条合并为 3 条）+ sortAt / chgAt 字段与回填
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const https = require('https');
const EventEmitter = require('events');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const ST = require('../cloudfunctions/payment/status.js');

const OWNER = 'o-owner';
const ADMIN = 'o-admin';
const H = 3600 * 1000;
const DAY = 24 * H;
const RealDate = Date;
const NOW = ST.LOCK_SINCE + 30 * DAY;

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
const quiet = async fn => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

const sent = [];
function seed(records, extra) {
  db.reset().applyUpdates = true;
  db.persist = true;
  sent.length = 0;
  sdk.openapi = {
    subscribeMessage: { send: async o => { sent.push(o); } },
    security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) }
  };
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府', activeBookId: 'b1', payCodeFileID: 'cloud://x/paycodes/p.png' }])
    .seed('users', [{ openid: OWNER, nickname: '主家' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜', type: 'wedding', statReady: true, statCount: 0, statFen: 0 }])
    .seed('settings', [{ _id: 'admins', openids: [ADMIN] }])
    .seed('records', records);
  if (extra) Object.keys(extra).forEach(k => db.seed(k, extra[k]));
}
const rec = (id, extra) => ({
  _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', themeName: '新婚之喜', hostName: '张府',
  payerOpenid: 'g1', payerName: '王五', amount: 600, payMethod: 'wechat', status: 'paid', handlerOpenid: OWNER, handlerName: '主家',
  createdAt: ago(10), transferredAt: ago(10), paidAt: ago(10), sortAt: ago(10), guestRejectNotify: true, ...extra
});
const owner = ev => { state.openid = OWNER; return loadFunction('payment').main(ev); };
const guest = (ev, id) => { state.openid = id || 'g1'; return loadFunction('payment').main(ev); };
const get = id => db.data.records.find(r => r._id === id);
const tab = (t, cursor, id) => guest({ action: 'myReceipts', tab: t, ...(cursor ? { cursor } : {}) }, id);
const ids = r => r.data.rows.map(x => x._id).sort();

// ---------- sortAt / chgAt 写入路径 ----------
test('sortAt：创建（宾客登记 / 礼台记账）= createdAt；确认入簿 = paidAt；未收到 = rejectedAt；撤销回到 createdAt；作废 = voidedAt', async () => {
  await at(NOW, async () => {
    seed([]);
    state.openid = 'g1';
    const c = await loadFunction('payment').main({ action: 'create', aid: 'acc1', payerName: '张三', amount: 100 });
    assert.strictEqual(c.code, 0, c.msg);
    const created = db.data.records[0];
    assert.ok(created.sortAt && created.sortAt.getTime() === created.createdAt.getTime(), '宾客登记 sortAt = createdAt');
    seed([]);
    const d = await owner({ action: 'cashEntry', payerName: '李四', amount: 200, payMethod: 'cash' });
    assert.strictEqual(d.code, 0, d.msg);
    const cash = db.data.records[0];
    assert.strictEqual(cash.sortAt.getTime(), cash.createdAt.getTime());
    assert.strictEqual(cash.sortAt.getTime(), cash.paidAt.getTime());
    // 确认入簿：sortAt = paidAt（晚于 createdAt）
    seed([rec('t1', { status: 'transferred', paidAt: undefined, sortAt: ago(5), createdAt: ago(5) })]);
    assert.strictEqual((await owner({ action: 'confirm', rid: 't1' })).code, 0);
    assert.strictEqual(get('t1').sortAt.getTime(), get('t1').paidAt.getTime());
    assert.strictEqual(get('t1').sortAt.getTime(), NOW);
    // 未收到 / 撤销
    seed([rec('t2', { status: 'transferred', paidAt: undefined, sortAt: ago(5), createdAt: ago(5) })]);
    assert.strictEqual((await owner({ action: 'reject', rid: 't2' })).code, 0);
    assert.strictEqual(get('t2').sortAt.getTime(), get('t2').rejectedAt.getTime());
    assert.strictEqual((await owner({ action: 'unreject', rid: 't2' })).code, 0);
    assert.strictEqual(get('t2').sortAt.getTime(), ago(5).getTime(), '撤销回到 createdAt');
    // 申诉入簿：sortAt = 新 paidAt
    seed([rec('t3', { status: 'rejected', rejectedAt: ago(30), sortAt: ago(30), appealStatus: 'open', appealN: 1, paidAt: undefined, rejectedFrom: 'transferred' })]);
    assert.strictEqual((await owner({ action: 'resolveAppeal', rid: 't3', decision: 'accept' })).code, 0);
    assert.strictEqual(get('t3').sortAt.getTime(), NOW);
    // 作废：sortAt = chgAt = voidedAt
    seed([rec('t4')]);
    assert.strictEqual((await owner({ action: 'void', rid: 't4' })).code, 0);
    const v = get('t4');
    assert.strictEqual(v.sortAt.getTime(), v.voidedAt.getTime());
    assert.strictEqual(v.chgAt.getTime(), v.voidedAt.getTime());
  });
});

test('chgAt：amend（金额 / 姓名）、更正申请、同意、拒绝写入；只改备注不写；sortAt 不因修改变化；同意作废时 sortAt = voidedAt', async () => {
  await at(NOW, async () => {
    seed([rec('a'), rec('b', { paidAt: ago(100), sortAt: ago(100) })]);
    await owner({ action: 'amend', rid: 'a', remark: '只改备注' });
    assert.strictEqual(get('a').chgAt, undefined);
    await owner({ action: 'amend', rid: 'a', amount: 700 });
    assert.strictEqual(get('a').chgAt.getTime(), NOW);
    assert.strictEqual(get('a').sortAt.getTime(), ago(10).getTime(), '修改不改变排序时间');
    assert.strictEqual((await owner({ action: 'correct', rid: 'b', kind: 'void', reason: '重复录入' })).code, 0);
    assert.strictEqual(get('b').chgAt.getTime(), get('b').corrAt.getTime());
    assert.strictEqual((await guest({ action: 'correctReply', rid: 'b', decision: 'decline' })).code, 0);
    assert.strictEqual(get('b').chgAt.getTime(), NOW);
    await owner({ action: 'correct', rid: 'b', kind: 'void', reason: '再次申请' });
    assert.strictEqual((await guest({ action: 'correctReply', rid: 'b', decision: 'agree' })).code, 0);
    assert.strictEqual(get('b').status, 'void');
    assert.strictEqual(get('b').sortAt.getTime(), get('b').voidedAt.getTime());
    assert.strictEqual(get('b').chgAt.getTime(), NOW);
  });
});

// ---------- 分标签分页 ----------
function seedTabs() {
  seed([
    rec('p1', { sortAt: ago(1) }), rec('p2', { sortAt: ago(40 * 24) }),
    rec('w1', { status: 'transferred', paidAt: undefined, createdAt: ago(5), sortAt: ago(5) }),
    rec('w2', { status: 'pending', paidAt: undefined, createdAt: ago(6), sortAt: ago(6) }),
    rec('w3', { status: 'transferred', paidAt: undefined, createdAt: ago(100), sortAt: ago(100) }),
    rec('r1', { status: 'rejected', paidAt: undefined, rejectedAt: ago(48), sortAt: ago(48), rejectReason: 'nofound' }),
    rec('r2', { status: 'rejected', paidAt: undefined, rejectedAt: ago(40 * 24), sortAt: ago(40 * 24) }),
    rec('v1', { status: 'void', voidedAt: ago(3), sortAt: ago(3), chgAt: ago(3) }),
    rec('v2', { status: 'void', voidedAt: ago(40 * 24), sortAt: ago(40 * 24), chgAt: ago(40 * 24) }),
    rec('c1', { status: 'cancelled', paidAt: undefined, createdAt: ago(8), sortAt: ago(8) }),
    rec('m1', { sortAt: ago(2), amendN: 1, amendedAt: ago(2), chgAt: ago(2), trail: [{ at: ago(2), act: 'amend', changes: { amount: [500, 600] } }] }),
    rec('k1', { paidAt: ago(100), sortAt: ago(100), corrState: 'pending', corrAt: ago(1), chgAt: ago(1), correction: { kind: 'amount', newAmount: 500, reason: '多写了零', by: '小李', at: ago(1), state: 'pending' } }),
    rec('x1', { payerOpenid: 'g9' }),
    rec('cl1', { payerOpenid: '', claimedOpenid: 'g1', payerName: '认领的', sortAt: ago(4) })
  ]);
}

test('标签「全部」：已入簿不限时、未收到 / 作废 30 天、待确认 / 已取消 3 天；按 sortAt 倒序；凭证不在非最后一页', async () => {
  await at(NOW, async () => {
    seedTabs();
    const r = await tab('all');
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(ids(r), ['c1', 'cl1', 'k1', 'm1', 'p1', 'p2', 'r1', 'v1', 'w1', 'w2'], '旧的 w3 / r2 / v2 与别人的 x1 不显示');
    assert.strictEqual(r.data.next, null);
    assert.ok(Array.isArray(r.data.vouchers), '最后一页之后追加凭证');
    const q = db.log.filter(x => x.op === 'get' && x.col === 'records').pop();
    assert.deepStrictEqual(q.orders, [['sortAt', 'desc']]);
    assert.ok(JSON.stringify(q.cond).includes('payerOpenid') && JSON.stringify(q.cond).includes('claimedOpenid'));
  });
});

test('标签：已入簿 / 待确认 / 未收到 / 有变动 各自的条件', async () => {
  await at(NOW, async () => {
    seedTabs();
    assert.deepStrictEqual(ids(await tab('paid')), ['cl1', 'k1', 'm1', 'p1', 'p2']);
    assert.deepStrictEqual(ids(await tab('waiting')), ['w1', 'w2'], '待确认 = pending + transferred，3 天内');
    assert.deepStrictEqual(ids(await tab('rejected')), ['r1'], '未收到 30 天内');
    const ch = await tab('changed');
    assert.deepStrictEqual(ids(ch), ['k1', 'm1', 'v1'], '有变动 = chgAt 30 天内');
    const q = db.log.filter(x => x.op === 'get' && x.col === 'records').pop();
    assert.deepStrictEqual(q.orders, [['chgAt', 'desc']]);
    const k1 = ch.data.rows.find(x => x._id === 'k1');
    assert.strictEqual(k1.corr.kind, 'amount');
    assert.strictEqual(k1.corr.newAmount, 500);
    assert.strictEqual(k1.corr.reason, '多写了零');
    assert.ok(ch.data.rows.find(x => x._id === 'm1').changes[0].text.includes('500 → 600'));
    assert.strictEqual(ch.data.lastChangeAt, ago(1).getTime(), '第一页返回最近变动时间');
    assert.strictEqual(ch.data.vouchers, undefined);
    assert.ok(!(await tab('paid')).data.vouchers, '只有「全部」带凭证');
    // 认领人看自己的
    seedTabs();
    db.data.records.find(r => r._id === 'cl1').claimedOpenid = 'g2';
    assert.deepStrictEqual(ids(await tab('paid', 0, 'g2')), ['cl1']);
  });
});

test('分页：每页 20 条，next 为下一页游标，最后一页 next 为 null；批次在页内合成一行', async () => {
  await at(NOW, async () => {
    const many = [];
    for (let i = 0; i < 25; i++) many.push(rec('n' + String(i).padStart(2, '0'), { sortAt: ago(i + 1) }));
    many.unshift(rec('b1', { batchId: 'B1', batchIdx: 0, payerName: '甲', amount: 100, sortAt: ago(0.5) }), rec('b2', { batchId: 'B1', batchIdx: 1, payerName: '乙', amount: 50, sortAt: ago(0.5) }));
    seed(many);
    const p1 = await tab('paid');
    assert.strictEqual(p1.data.rows.length, 19, '27 条记录里前 20 条，其中批次 2 条合成 1 行');
    assert.strictEqual(p1.data.next, 20);
    const batch = p1.data.rows.find(x => x.ids.length === 2);
    assert.strictEqual(batch.payerName, '甲 等 2 人');
    assert.strictEqual(batch.amount, 150);
    const p2 = await tab('paid', 20);
    assert.strictEqual(p2.data.rows.length, 7);
    assert.strictEqual(p2.data.next, null);
    const sk = db.log.filter(x => x.op === 'get' && x.col === 'records').pop();
    assert.strictEqual(sk.skip, 20);
    assert.strictEqual(sk.limit, 21, '多取 1 条判断是否还有下一页');
    assert.strictEqual((await tab('paid', 'abc')).data.rows.length, 19, '非法游标当第一页');
  });
});

test('凭证只在「全部」最后一页之后追加；已能在实时记录里看到的不重复；不泄露 openid / 记账人', async () => {
  await at(NOW, async () => {
    const many = [];
    for (let i = 0; i < 22; i++) many.push(rec('n' + String(i).padStart(2, '0'), { sortAt: ago(i + 1) }));
    seed(many, {
      guest_receipts: [
        { _id: 'gone', guestOpenid: 'g1', ownerOpenid: 'o-x', bookId: 'bx', status: 'void', amount: 200, payerName: '王五', hostName: '李府', themeName: '寿宴', bookType: 'birthday', createdAt: ago(900), paidAt: ago(900), voidedAt: ago(800), trail: [{ at: ago(800), act: 'void' }], snapshotAt: ago(100) },
        { _id: 'n00', guestOpenid: 'g1', ownerOpenid: OWNER, bookId: 'b1', status: 'paid', amount: 600, payerName: '王五', hostName: '张府', snapshotAt: ago(1) },
        { _id: 'other', guestOpenid: 'g9', ownerOpenid: 'o-x', bookId: 'bx', status: 'paid', amount: 1, payerName: '别人', snapshotAt: ago(100) }
      ]
    });
    const p1 = await tab('all');
    assert.strictEqual(p1.data.next, 20);
    assert.strictEqual(p1.data.vouchers, undefined, '非最后一页不带凭证');
    const p2 = await tab('all', 20);
    assert.strictEqual(p2.data.next, null);
    assert.deepStrictEqual(p2.data.vouchers.map(v => v._id), ['gone'], '实时记录里已有的 n00 与别人的不显示');
    const txt = JSON.stringify([p1.data, p2.data]);
    ['o-owner', 'o-x', 'g1', 'g9', 'handlerOpenid', 'payerOpenid', 'ownerOpenid', 'guestOpenid', '小李', 'handlerName'].forEach(k => assert.ok(!txt.includes(k), '不含：' + k));
    assert.strictEqual(p1.data.rows[0].own, true);
  });
});

test('giftStat：待我确认的更正申请数 + 最近变动时间，只两次小查询；不泄露 openid', async () => {
  await at(NOW, async () => {
    seedTabs();
    db.log.length = 0;
    const r = await guest({ action: 'giftStat' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.strictEqual(r.data.correctionN, 1);
    assert.ok(r.data.lastChangeAt > 0);
    const lq = db.log.filter(x => x.op === 'get' && x.col === 'records')[0];
    assert.deepStrictEqual(lq.orders, [['chgAt', 'desc']]); // 内存库不排序，只校验取最新 1 条的写法
    assert.strictEqual(lq.limit, 1);
    assert.strictEqual(db.log.filter(x => x.col === 'records').length, 2);
    assert.deepStrictEqual(Object.keys(r.data).sort(), ['correctionN', 'lastChangeAt']);
    const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/payment/index.js'), 'utf8');
    assert.ok(/READ_ACTIONS = \[[^\]]*'giftStat'/.test(src));
    assert.ok(/READ_ACTIONS = \[[^\]]*'giftStat'/.test(fs.readFileSync(path.join(ROOT, 'miniprogram/utils/request.js'), 'utf8').replace(/\n/g, ' ')) || fs.readFileSync(path.join(ROOT, 'miniprogram/utils/request.js'), 'utf8').includes("'giftStat'"));
  });
});

test('旧版接口：不带 tab 的 myReceipts 保持原样（旧版小程序仍可用）', async () => {
  await at(NOW, async () => {
    seedTabs();
    const r = await guest({ action: 'myReceipts' });
    assert.strictEqual(r.code, 0, r.msg);
    ['list', 'waiting', 'rejected', 'cancelled', 'voided', 'corrections', 'vouchers'].forEach(k => assert.ok(Array.isArray(r.data[k]), k));
    assert.strictEqual(r.data.rows, undefined);
  });
});

// ---------- 回填与索引 ----------
test('adminBackfill：补 sortAt（入簿 paidAt / 未收到 rejectedAt / 作废 voidedAt / 其余 createdAt）与 chgAt（有修改记录、作废、更正申请）；可续跑；仅管理员', async () => {
  await at(NOW, async () => {
    const bare = (id, extra) => ({ _id: id, ownerOpenid: OWNER, payerOpenid: 'g1', amount: 1, status: 'paid', createdAt: ago(100), ...extra });
    seed([
      bare('a', { paidAt: ago(90) }),
      bare('b', { status: 'rejected', rejectedAt: ago(50) }),
      bare('c', { status: 'void', paidAt: ago(80), voidedAt: ago(20) }),
      bare('d', { status: 'transferred' }),
      bare('e', { paidAt: ago(70), amendLog: [{ at: ago(5), changes: {} }], amendedAt: ago(5) }),
      bare('f', { paidAt: ago(70), corrState: 'declined', corrAt: ago(7) }),
      bare('done', { paidAt: ago(1), sortAt: ago(1) })
    ]);
    state.openid = 'someone';
    assert.strictEqual((await loadFunction('system').main({ action: 'adminBackfill' })).code, 1, '非管理员');
    state.openid = ADMIN;
    const r = await quiet(() => loadFunction('system').main({ action: 'adminBackfill' }));
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(r.data, { done: true, updated: 6 });
    const t = id => get(id);
    assert.strictEqual(t('a').sortAt.getTime(), ago(90).getTime());
    assert.strictEqual(t('b').sortAt.getTime(), ago(50).getTime());
    assert.strictEqual(t('c').sortAt.getTime(), ago(20).getTime());
    assert.strictEqual(t('c').chgAt.getTime(), ago(20).getTime());
    assert.strictEqual(t('d').sortAt.getTime(), ago(100).getTime());
    assert.strictEqual(t('a').chgAt, undefined);
    assert.strictEqual(t('e').chgAt.getTime(), ago(5).getTime());
    assert.strictEqual(t('f').chgAt.getTime(), ago(7).getTime());
    assert.strictEqual(t('done').chgAt, undefined, '已有 sortAt 的不动');
    const again = await quiet(() => loadFunction('system').main({ action: 'adminBackfill' }));
    assert.deepStrictEqual(again.data, { done: true, updated: 0 });
  });
});

test('INDEXES：随礼人侧 6 条合并为 3 条，records 共 17 条，总数 33；旧索引在 DROP_INDEXES 里', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/system/index.js'), 'utf8').replace(/\r/g, '');
  const body = src.match(/const INDEXES = \[([\s\S]*?)\n\];/)[1];
  const names = [...body.matchAll(/\['(\w+)', '(\w+)', \[\[/g)].map(m => m[1] + '.' + m[2]);
  assert.strictEqual(names.length, 33);
  assert.strictEqual(names.filter(n => n.startsWith('records.')).length, 17);
  ['records.payer_status_sort', 'records.claimed_status_sort', 'records.payer_chg', 'records.guest_retry', 'records.corr_pending', 'records.chg_pending'].forEach(n => assert.ok(names.includes(n), n));
  const OLD = ['payer_status_paid', 'payer_time', 'payer_status_time', 'payer_status_rejected', 'claimed_status_paid', 'payer_status_void'];
  OLD.forEach(n => { assert.ok(!names.includes('records.' + n), n); assert.ok(src.match(/const DROP_INDEXES = \{[\s\S]*?\};/)[0].includes(`'${n}'`), 'DROP ' + n); });
  assert.ok(/'payer_status_sort', \[\['payerOpenid', 1\], \['status', 1\], \['sortAt', -1\]\]/.test(body));
  assert.ok(/'claimed_status_sort', \[\['claimedOpenid', 1\], \['status', 1\], \['sortAt', -1\]\]/.test(body));
  assert.ok(/'payer_chg', \[\['payerOpenid', 1\], \['chgAt', -1\]\]/.test(body));
});

function fakeHttps(handler) {
  const orig = https.request;
  const seen = [];
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = data => {
      const body = JSON.parse(data);
      seen.push({ url, body });
      const out = handler(url, body, seen);
      const res = new EventEmitter();
      process.nextTick(() => { cb(res); res.emit('data', Buffer.from(JSON.stringify(out))); res.emit('end'); });
    };
    return req;
  };
  return { seen, restore: () => { https.request = orig; } };
}

test('ensureIndexes：先删旧索引再建新的（避免 -501000 超限）；旧索引不存在也算成功；建完回填 sortAt / chgAt', async () => {
  process.env.WX_APPSECRET = 'secret-for-test';
  seed([{ _id: 'old1', ownerOpenid: OWNER, status: 'paid', createdAt: ago(5), paidAt: ago(4), payerOpenid: 'g1', amount: 1 }]);
  const h = fakeHttps((url, body) => {
    if (url.includes('stable_token')) return { access_token: 'AT' };
    if (body.drop_indexes && body.drop_indexes.length) return body.drop_indexes[0].name === 'payer_time' ? { errcode: -1, errmsg: 'index not exist' } : { errcode: 0 };
    return { errcode: 0 };
  });
  try {
    state.openid = ADMIN;
    const r = await quiet(() => loadFunction('system').main({ action: 'adminIndexes' }));
    assert.strictEqual(r.code, 0, r.msg);
    const calls = h.seen.filter(x => x.url.includes('updateindex'));
    const drops = calls.filter(x => x.body.drop_indexes.length);
    const creates = calls.filter(x => x.body.create_indexes.length);
    assert.deepStrictEqual(drops.map(x => x.body.drop_indexes[0].name).sort(), ['claimed_status_paid', 'payer_status_paid', 'payer_status_rejected', 'payer_status_time', 'payer_status_void', 'payer_time']);
    assert.ok(drops.every(x => x.body.collection_name === 'records'));
    assert.strictEqual(creates.length, 33);
    const lastDrop = Math.max(...drops.map(x => h.seen.indexOf(x)));
    const firstCreate = Math.min(...creates.map(x => h.seen.indexOf(x)));
    assert.ok(lastDrop < firstCreate, '全部删完才开始建');
    assert.strictEqual(r.data.failed, 0, '不存在的旧索引不算失败');
    assert.strictEqual(r.data.dropped, 5);
    assert.deepStrictEqual(r.data.backfill, { done: true, updated: 1 });
    assert.ok(get('old1').sortAt);
  } finally { h.restore(); }
});

test('前端：五个标签、分页、红点、空状态；320 宽小屏标签不换行可滑动；按钮 / toast 字数；页面接上 onReachBottom', () => {
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/components/my-gifts/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/components/my-gifts/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(ROOT, 'miniprogram/components/my-gifts/index.wxss'), 'utf8');
  ['全部', '已入簿', '待确认', '未收到', '有变动'].forEach(t => assert.ok(js.includes(`'${t}'`), t));
  assert.ok(js.includes('loadMore') && js.includes('myReceiptsTab') && js.includes('giftStat'));
  assert.ok(/mg-seg \{[^}]*overflow-x: auto/.test(wxss) && /mg-seg-item \{[^}]*white-space: nowrap/.test(wxss));
  assert.ok(wxml.includes('mg-dot') && wxml.includes('emptyText'));
  ['all', 'paid', 'waiting', 'rejected', 'changed'].forEach(k => assert.ok(new RegExp(`${k}:`).test(js.slice(js.indexOf('const EMPTY'))), '空状态文案 ' + k));
  (js.match(/confirmText: [^,\n]+/g) || []).forEach(m => (m.match(/'([^']+)'/g) || []).forEach(l => assert.ok(l.length - 2 <= 4, m)));
  (js.match(/title: '[^']+', icon: 'success'/g) || []).forEach(m => assert.ok(m.match(/title: '([^']+)'/)[1].length <= 7, m));
  assert.ok(/onReachBottom\(\) \{[\s\S]*loadMore/.test(fs.readFileSync(path.join(ROOT, 'miniprogram/pages/myreceipts/myreceipts.js'), 'utf8')));
  assert.ok(/tab === 'receipts'[\s\S]{0,120}loadMore/.test(fs.readFileSync(path.join(ROOT, 'miniprogram/pages/renqing/renqing.js'), 'utf8')));
  const app = fs.readFileSync(path.join(ROOT, 'miniprogram/app.js'), 'utf8');
  assert.ok(app.includes('giftStat({ silent: true })'), '红点走轻量接口');
});
