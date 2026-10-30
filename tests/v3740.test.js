// v3.74.0 宾客申诉：appeal（每笔 1 次、每人每天 5 次、仅本人、30 天）、resolveAppeal（accept 入簿 / keep 维持）、
// unreject 清申诉、批次整批、待确认页 appeals 与角标计数、不泄露、前端接线
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction } = require('./helpers/sdk-stub.js');
const gn = require('../cloudfunctions/payment/guestnotify.js');

const OWNER = 'o-owner';
const sent = [];
function seed(records) {
  db.reset().applyUpdates = true;
  sent.length = 0;
  sdk.openapi.subscribeMessage = { send: async o => { sent.push(o); } };
  sdk.openapi.security = { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) };
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER, nickname: '主家' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜', type: 'wedding', statReady: true }])
    .seed('records', records);
}
const rej = (id, extra) => ({
  _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', themeName: '新婚之喜', payerOpenid: 'g1', payerName: '王五',
  amount: 600, payMethod: 'wechat', status: 'rejected', createdAt: new Date(), transferredAt: new Date(), rejectedAt: new Date(), rejectedFrom: 'transferred',
  rejectReason: 'nofound', trail: [{ at: new Date(), who: 'owner', name: '主家', act: 'reject', reason: 'nofound' }], ...extra
});
const owner = ev => { state.openid = OWNER; return loadFunction('payment').main(ev); };
const guest = (ev, id) => { state.openid = id || 'g1'; return loadFunction('payment').main(ev); };
const rec = id => db.data.records.find(x => x._id === id);

test('appeal：写申诉状态 / 说明 / 单号后几位 / trail；重复点击幂等；已申诉过不能再来', async () => {
  seed([rej('r1')]);
  const r = await guest({ action: 'appeal', rid: 'r1', note: '昨天 14:30 转的，备注王五', ref: '8A9B-12345678', envVersion: 'trial' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(r.data.changed, true);
  const d = rec('r1');
  assert.strictEqual(d.status, 'rejected'); // 不新增 / 不改状态
  assert.strictEqual(d.appealStatus, 'open');
  assert.strictEqual(d.appealN, 1);
  assert.strictEqual(d.appealNote, '昨天 14:30 转的，备注王五');
  assert.strictEqual(d.appealRef, '8A9B12');
  assert.deepStrictEqual(d.trail.map(x => x.act), ['reject', 'appeal']);
  assert.strictEqual(d.trail[1].who, 'guest');
  const again = await guest({ action: 'appeal', rid: 'r1' });
  assert.strictEqual(again.code, 0);
  assert.strictEqual(again.data.changed, false);
  assert.strictEqual(rec('r1').trail.length, 2);
  // 主家维持后不能再申诉
  await owner({ action: 'resolveAppeal', rid: 'r1', decision: 'keep', note: '确实没收到' });
  const third = await guest({ action: 'appeal', rid: 'r1' });
  assert.notStrictEqual(third.code, 0);
});

test('appeal：只能本人、只能 rejected、30 天内、说明 50 字；重新订阅时记 guestNotify', async () => {
  seed([rej('r1'), rej('r2', { status: 'transferred' }), rej('r3', { rejectedAt: new Date(Date.now() - 31 * 86400000) })]);
  assert.notStrictEqual((await guest({ action: 'appeal', rid: 'r1' }, 'g9')).code, 0);
  assert.notStrictEqual((await guest({ action: 'appeal', rid: 'r2' })).code, 0);
  assert.notStrictEqual((await guest({ action: 'appeal', rid: 'r3' })).code, 0);
  assert.notStrictEqual((await guest({ action: 'appeal', rid: 'nope' })).code, 0);
  assert.notStrictEqual((await owner({ action: 'appeal', rid: 'r1' })).code, 0); // 主家不是付款人
  const r = await guest({ action: 'appeal', rid: 'r1', note: '一'.repeat(80), guestNotify: true, envVersion: 'trial' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(rec('r1').appealNote.length, 50);
  assert.strictEqual(rec('r1').guestNotify, true);
  assert.strictEqual(rec('r1').guestEnv, 'trial');
});

// 限流集合的 add 按真实数据库语义：_id 重复时报错
function strictRateLimits() {
  const orig = db.collection.bind(db);
  db.collection = name => {
    const c = orig(name);
    if (name !== 'rate_limits') return c;
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

test('appeal：每人每天最多 5 次', async () => {
  seed(Array.from({ length: 7 }, (_, i) => rej('r' + i)));
  const restore = strictRateLimits();
  try {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await guest({ action: 'appeal', rid: 'r' + i })).code);
    assert.deepStrictEqual(codes, [0, 0, 0, 0, 0, 1, 1]);
  } finally { restore(); }
});

test('appeal：内容审核命中违规拒绝', async () => {
  seed([rej('r1')]);
  sdk.openapi.security = { msgSecCheck: async () => ({ result: { suggest: 'risky' } }) };
  const r = await guest({ action: 'appeal', rid: 'r1', note: 'x' });
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(rec('r1').appealStatus, undefined);
});

test('resolveAppeal accept：入簿、礼簿合计 +、记 trail、申诉状态 accepted、给重新订阅的宾客发入簿通知', async () => {
  seed([rej('r1', { guestNotify: true, guestEnv: 'trial', appealStatus: 'open', appealN: 1, appealAt: new Date(), trail: [{ at: new Date(), who: 'owner', act: 'reject' }, { at: new Date(), who: 'guest', act: 'appeal' }] })]);
  const r = await owner({ action: 'resolveAppeal', rid: 'r1', decision: 'accept' });
  assert.strictEqual(r.code, 0, r.msg);
  const d = rec('r1');
  assert.strictEqual(d.status, 'paid');
  assert.ok(d.paidAt);
  assert.strictEqual(d.appealStatus, 'accepted');
  assert.strictEqual(d.rejectedFrom, undefined);
  assert.deepStrictEqual(d.trail.map(x => x.act), ['reject', 'appeal', 'accept']);
  const b = db.data.books.find(x => x._id === 'b1');
  assert.strictEqual(b.statCount, 1);
  assert.strictEqual(b.statFen, 60000);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].page, 'pages/receipt/receipt?rid=r1');
  // 再处理一次：没有待处理的申诉
  assert.notStrictEqual((await owner({ action: 'resolveAppeal', rid: 'r1', decision: 'accept' })).code, 0);
});

test('resolveAppeal accept：按实际金额入簿，记宾客登记金额 declaredAmount；合计按实收', async () => {
  seed([rej('r1', { appealStatus: 'open', appealN: 1 })]);
  const r = await owner({ action: 'resolveAppeal', rid: 'r1', decision: 'accept', amount: 500 });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(rec('r1').amount, 500);
  assert.strictEqual(rec('r1').declaredAmount, 600);
  assert.strictEqual(db.data.books.find(x => x._id === 'b1').statFen, 50000);
});

test('resolveAppeal：没有申诉的未收到记录不能直接入簿（不绕过 24 小时撤销规则）；普通 confirm 也不能确认 rejected', async () => {
  seed([rej('r1')]);
  assert.notStrictEqual((await owner({ action: 'resolveAppeal', rid: 'r1', decision: 'accept' })).code, 0);
  assert.notStrictEqual((await owner({ action: 'confirm', rid: 'r1' })).code, 0);
  assert.strictEqual(rec('r1').status, 'rejected');
  assert.notStrictEqual((await owner({ action: 'resolveAppeal', rid: 'r1', decision: 'bad' })).code, 0);
});

test('resolveAppeal 需要确认收礼权限：无关身份不能处理；OWNER_ACTIONS 与 NEED 都含 resolveAppeal', async () => {
  seed([rej('r1', { appealStatus: 'open', appealN: 1 })]);
  state.openid = 'stranger';
  const r = await loadFunction('payment').main({ action: 'resolveAppeal', rid: 'r1', decision: 'accept' });
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(rec('r1').status, 'rejected');
  const src = fs.readFileSync(path.join(__dirname, '../cloudfunctions/payment/index.js'), 'utf8');
  assert.ok(/const OWNER_ACTIONS = \[[^\]]*'resolveAppeal'/.test(src));
  assert.ok(/const NEED = \{[^}]*resolveAppeal: 'confirm'/.test(src));
});

test('resolveAppeal keep：维持未收到（终态）、可附回复、不改 status、不动礼簿合计；通知宾客「核对后仍未收到」', async () => {
  seed([rej('r1', { guestRejectNotify: true, appealStatus: 'open', appealN: 1 })]);
  const r = await owner({ action: 'resolveAppeal', rid: 'r1', decision: 'keep', note: '核对两遍没有' });
  assert.strictEqual(r.code, 0, r.msg);
  const d = rec('r1');
  assert.strictEqual(d.status, 'rejected');
  assert.strictEqual(d.appealStatus, 'kept');
  assert.strictEqual(d.appealReply, '核对两遍没有');
  assert.strictEqual(d.trail[d.trail.length - 1].act, 'keep');
  assert.strictEqual(db.data.books.find(x => x._id === 'b1').statCount, undefined);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].data.thing3.value, '主家核对后仍未收到，点此查看');
  assert.strictEqual(sent[0].page, 'pages/myreceipts/myreceipts');
  assert.notStrictEqual((await owner({ action: 'resolveAppeal', rid: 'r1', decision: 'keep' })).code, 0);
});

test('buildReject kept：白事 / 批次文案', () => {
  assert.strictEqual(gn.buildReject({ amount: 1, count: 1, kept: true, funeral: true }, 't').thing3.value, '核对后仍未核实，点此查看');
  assert.strictEqual(gn.buildReject({ amount: 1, count: 3, kept: true }, 't').thing3.value, '3人核对后仍未收到，点此查看');
});

test('unreject：清掉申诉字段（24 小时内），日志保留；之后若再被标未收到可重新申诉', async () => {
  seed([rej('r1', { appealStatus: 'open', appealN: 1, appealNote: 'x', appealAt: new Date() })]);
  const r = await owner({ action: 'unreject', rid: 'r1' });
  assert.strictEqual(r.code, 0, r.msg);
  const d = rec('r1');
  assert.strictEqual(d.status, 'transferred');
  assert.strictEqual(d.appealStatus, undefined);
  assert.strictEqual(d.appealN, undefined);
  assert.strictEqual(d.appealNote, undefined);
  assert.strictEqual(d.trail[d.trail.length - 1].act, 'unreject');
  await owner({ action: 'reject', rid: 'r1' });
  assert.strictEqual((await guest({ action: 'appeal', rid: 'r1' })).code, 0);
});

test('批次：宾客整批申诉；主家整批入簿（合计为全部）/ 整批维持', async () => {
  const b = (id, i, amt) => rej(id, { batchId: 'B1', batchIdx: i, batchSize: 2, payerName: '甲' + i, amount: amt });
  seed([b('a0', 0, 100), b('a1', 1, 200)]);
  const r = await guest({ action: 'appeal', rid: 'a1', note: '一起转的' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(rec('a0').appealStatus, 'open');
  assert.strictEqual(rec('a1').appealStatus, 'open');
  const ok = await owner({ action: 'resolveAppeal', rid: 'a0', decision: 'accept' });
  assert.strictEqual(ok.code, 0, ok.msg);
  assert.strictEqual(rec('a0').status, 'paid');
  assert.strictEqual(rec('a1').status, 'paid');
  assert.strictEqual(db.data.books.find(x => x._id === 'b1').statFen, 30000);
  seed([b('a0', 0, 100), b('a1', 1, 200)]);
  await guest({ action: 'appeal', rid: 'a0' });
  await owner({ action: 'resolveAppeal', rid: 'a1', decision: 'keep' });
  assert.strictEqual(rec('a0').appealStatus, 'kept');
  assert.strictEqual(rec('a1').appealStatus, 'kept');
});

test('宾客 myReceipts：canAppeal / 申诉进度 / 维持后的回复；不含 openid、记账人姓名、单号', async () => {
  seed([rej('r1'), rej('r2', { appealStatus: 'open', appealN: 1, appealNote: '秘密说明', appealRef: 'ABC123' }),
    rej('r3', { appealStatus: 'kept', appealN: 1, appealReply: '核对两遍没有' })]);
  const r = await guest({ action: 'myReceipts' });
  const by = id => r.data.rejected.find(x => x._id === id);
  assert.strictEqual(by('r1').canAppeal, true);
  assert.strictEqual(by('r2').canAppeal, false);
  assert.strictEqual(by('r2').appealStatus, 'open');
  assert.strictEqual(by('r3').appealStatus, 'kept');
  assert.strictEqual(by('r3').appealReply, '核对两遍没有');
  const s = JSON.stringify(r.data);
  assert.ok(!s.includes('g1') && !s.includes(OWNER) && !s.includes('ABC123'));
});

test('records：待确认页返回 appeals（不再出现在「最近未收到」），pendingStat 带申诉数用于角标', async () => {
  seed([rej('r1', { appealStatus: 'open', appealN: 1, appealAt: new Date() }), rej('r2'),
    rej('r3', { appealStatus: 'kept', appealN: 1 }), rej('r4', { bookId: 'b2', appealStatus: 'open', appealN: 1 })]);
  state.openid = OWNER;
  const fn = loadFunction('records');
  const p = await fn.main({ action: 'pending', withRejected: true });
  assert.strictEqual(p.code, 0, p.msg);
  assert.deepStrictEqual(p.data.appeals.map(x => x._id).sort(), ['r1', 'r4']); // v3.77.0：含其他礼簿的
  assert.strictEqual(p.data.appeals.find(x => x._id === 'r4').bookOther, true);
  assert.strictEqual(p.data.appealOther, 1);
  assert.deepStrictEqual(p.data.rejected.map(x => x._id).sort(), ['r2', 'r3']);
  assert.ok(!('payerOpenid' in p.data.appeals[0]));
  const st = await fn.main({ action: 'pendingStat', withExtra: true });
  assert.strictEqual(st.data.appeal, 2); // 全部礼簿合计
  assert.strictEqual(st.data.appealOther, 1);
  assert.strictEqual(st.data.rej, 2);
});

test('前端接线：申诉弹层、待确认「宾客申诉」栏、角标、处理经过、FAQ', () => {
  const rd = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const mg = rd('miniprogram/components/my-gifts/index.wxml');
  assert.ok(mg.includes('我确实转了，请再核对') && mg.includes('onAppealSubmit'));
  const js = rd('miniprogram/components/my-gifts/index.js');
  assert.ok(/const subP = guestsub\.ask\(\);[\s\S]*await subP/.test(js), '订阅必须在第一个 await 之前');
  assert.ok(rd('miniprogram/pages/pending/pending.wxml').includes('宾客申诉（{{appeals.length}}）'));
  assert.ok(rd('miniprogram/custom-tab-bar/index.js').includes('appealN'));
  assert.ok(rd('miniprogram/utils/request.js').includes("action: 'resolveAppeal'"));
  assert.ok(rd('miniprogram/pages/reconcile/reconcile.wxml').includes('宾客申诉'));
  assert.ok(rd('miniprogram/pages/guide/faq.js').includes('宾客申诉'));
});
