// v3.73.0 「未收到」原因与追溯、宾客可见：reject 带原因 / trail、unreject 清理、宾客 myReceipts 返回未收到与取消（30 天 / 3 天）、
// 未收到通知（复用入簿模板、白事用词、一次订阅一条）、不泄露 openid 与记账人姓名
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
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜', type: 'wedding' }])
    .seed('records', records);
}
const rec = (id, extra) => ({ _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', themeName: '新婚之喜', payerOpenid: 'g1', payerName: '王五', amount: 600, payMethod: 'wechat', status: 'transferred', createdAt: new Date(), transferredAt: new Date(), ...extra });
const owner = ev => { state.openid = OWNER; return loadFunction('payment').main(ev); };
const guest = (ev, id) => { state.openid = id || 'g1'; return loadFunction('payment').main(ev); };

test('buildReject：按原因写备注；白事统一「暂未核实到账」；批次写人数；每个字段不超过 20 字', () => {
  const t = '2026年10月29日 10:00';
  assert.strictEqual(gn.buildReject({ amount: 600, count: 1, reason: 'nofound' }, t).thing3.value, '主家未查到到账，点此查看');
  assert.strictEqual(gn.buildReject({ amount: 600, count: 1, reason: 'amount' }, t).thing3.value, '主家核对金额不符，点此查看');
  assert.strictEqual(gn.buildReject({ amount: 600, count: 1 }, t).thing3.value, '主家暂未确认收到，点此查看');
  assert.strictEqual(gn.buildReject({ amount: 600, count: 1, funeral: true, reason: 'nofound' }, t).thing3.value, '暂未核实到账，点此查看');
  assert.strictEqual(gn.buildReject({ amount: 600, count: 3 }, t).thing3.value, '3人未查到到账，点此查看');
  for (const v of Object.values(gn.buildReject({ hostName: '欧阳府', themeName: '新婚之喜', amount: 1, count: 12, funeral: true }, t))) assert.ok(v.value.length <= 20, v.value);
});

test('reject：记原因、补充说明（20 字）、rejectedBy、trail；非法原因码忽略', async () => {
  seed([rec('r1')]);
  const r = await owner({ action: 'reject', rid: 'r1', reason: 'amount', note: '一二三四五六七八九十一二三四五六七八九十多余' });
  assert.strictEqual(r.code, 0, r.msg);
  const d = db.data.records[0];
  assert.strictEqual(d.status, 'rejected');
  assert.strictEqual(d.rejectReason, 'amount');
  assert.strictEqual(d.rejectNote.length, 20);
  assert.ok(d.rejectedBy);
  assert.strictEqual(d.trail.length, 1);
  assert.strictEqual(d.trail[0].act, 'reject');
  assert.strictEqual(d.trail[0].who, 'owner');
  seed([rec('r2')]);
  await owner({ action: 'reject', rid: 'r2', reason: 'hack' });
  assert.strictEqual(db.data.records[0].rejectReason, undefined);
  assert.strictEqual(db.data.records[0].status, 'rejected'); // 原因选填
});

test('unreject：恢复状态、清掉原因，trail 追加（reject + unreject）', async () => {
  seed([rec('r1')]);
  await owner({ action: 'reject', rid: 'r1', reason: 'nofound' });
  const r = await owner({ action: 'unreject', rid: 'r1' });
  assert.strictEqual(r.code, 0, r.msg);
  const d = db.data.records[0];
  assert.strictEqual(d.status, 'transferred');
  assert.strictEqual(d.rejectReason, undefined);
  assert.deepStrictEqual(d.trail.map(x => x.act), ['reject', 'unreject']);
});

test('trail 最多保留 20 条', async () => {
  const old = Array.from({ length: 20 }, (_, i) => ({ at: new Date(), who: 'owner', act: 'reject', note: 'n' + i }));
  seed([rec('r1', { trail: old })]);
  await owner({ action: 'reject', rid: 'r1' });
  const t = db.data.records[0].trail;
  assert.strictEqual(t.length, 20);
  assert.strictEqual(t[19].act, 'reject');
  assert.strictEqual(t[0].note, 'n1');
});

test('通知：订阅过的宾客收到一条；发后订阅标记作废，之后不再发；批次一条；没订阅 / 礼台代记不发；发送失败不影响标记', async () => {
  seed([rec('r1', { guestRejectNotify: true, guestEnv: 'trial' })]);
  await owner({ action: 'reject', rid: 'r1', reason: 'nofound' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].touser, 'g1');
  assert.strictEqual(sent[0].templateId, gn.GUEST_REJECT_TMPL_ID);
  assert.strictEqual(sent[0].page, 'pages/myreceipts/myreceipts');
  assert.strictEqual(sent[0].miniprogramState, 'trial');
  assert.strictEqual(sent[0].data.thing3.value, '主家未查到到账，点此查看');
  assert.strictEqual(db.data.records[0].guestRejectNotify, false);
  await owner({ action: 'unreject', rid: 'r1' });
  await owner({ action: 'reject', rid: 'r1' });
  assert.strictEqual(sent.length, 1);
  const b = (id, i) => rec(id, { batchId: 'B1', batchIdx: i, batchSize: 2, payerName: '甲' + i, amount: 100, guestRejectNotify: true });
  seed([b('a0', 0), b('a1', 1)]);
  await owner({ action: 'reject', rid: 'a1' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].data.amount2.value, '200.00元');
  assert.strictEqual(sent[0].data.thing3.value, '2人未查到到账，点此查看');
  seed([rec('r2'), rec('r3', { guestRejectNotify: true, payerOpenid: '' }), rec('r4', { guestRejectNotify: true, payerOpenid: OWNER })]);
  for (const id of ['r2', 'r3', 'r4']) await owner({ action: 'reject', rid: id });
  assert.strictEqual(sent.length, 0);
  seed([rec('r5', { guestRejectNotify: true })]);
  sdk.openapi.subscribeMessage = { send: async () => { const e = new Error('x'); e.errCode = 43101; throw e; } };
  const r = await owner({ action: 'reject', rid: 'r5' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(db.data.records[0].status, 'rejected');
});

test('宾客 myReceipts：未收到（30 天）带原因与时间线、已取消（3 天）；超期与他人的不出现；不含 openid 与记账人姓名', async () => {
  const day = 86400000;
  seed([
    rec('r1', { status: 'rejected', rejectedAt: new Date(), rejectReason: 'nofound', rejectNote: '核对两遍', rejectedBy: '记账人小李',
      trail: [{ at: new Date(), who: 'clerk', name: '记账人小李', act: 'reject', reason: 'nofound', note: '核对两遍' }] }),
    rec('r2', { status: 'rejected', rejectedAt: new Date(Date.now() - 31 * day) }),
    rec('r3', { status: 'cancelled', autoCancelled: true }),
    rec('r4', { status: 'cancelled', createdAt: new Date(Date.now() - 4 * day) }),
    rec('r5', { status: 'rejected', rejectedAt: new Date(), payerOpenid: 'g2' })
  ]);
  const r = await guest({ action: 'myReceipts' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(r.data.rejected.length, 1);
  const x = r.data.rejected[0];
  assert.strictEqual(x._id, 'r1');
  assert.strictEqual(x.reasonText, '未查到到账：核对两遍');
  assert.ok(x.timeline.some(t => t.text.includes('主家未确认收到') && t.text.includes('未查到到账')));
  assert.strictEqual(r.data.cancelled.length, 1);
  assert.strictEqual(r.data.cancelled[0].auto, true);
  const s = JSON.stringify(r.data);
  assert.ok(!s.includes('g1') && !s.includes('g2') && !s.includes(OWNER) && !s.includes('小李'), '不得泄露 openid / 记账人姓名');
});

test('白事 myReceipts 时间线用「暂未核实到账」', async () => {
  seed([rec('f1', { bookType: 'funeral', status: 'rejected', rejectedAt: new Date(), trail: [{ at: new Date(), who: 'owner', act: 'reject' }] })]);
  const r = await guest({ action: 'myReceipts' });
  assert.ok(r.data.rejected[0].funeral);
  assert.ok(r.data.rejected[0].timeline.some(t => t.text.startsWith('主家暂未核实到账')));
});

test('status：被标未收到时带原因文字；无关的人不能查', async () => {
  seed([rec('r1', { status: 'rejected', rejectedAt: new Date(), rejectReason: 'amount' })]);
  const r = await guest({ action: 'status', rid: 'r1' });
  assert.strictEqual(r.data.status, 'rejected');
  assert.strictEqual(r.data.reasonText, '金额不符');
  assert.notStrictEqual((await guest({ action: 'status', rid: 'r1' }, 'g9')).code, 0);
});

test('前端：往来页第三栏「随礼记录」使用共用组件，宾客页同一组件；「我的」仅记账人 / 机构模式有入口（v3.74.4）；索引已加', () => {
  const rd = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const wxml = rd('miniprogram/pages/renqing/renqing.wxml');
  assert.ok(wxml.includes('>随礼记录</view>') && !wxml.includes('>随礼回执<'));
  assert.ok(wxml.includes('<my-gifts'));
  assert.ok(rd('miniprogram/pages/myreceipts/myreceipts.wxml').includes('<my-gifts'));
  // v3.74.4：记账人、机构模式没有「往来」，「我的」里有条件入口；其他身份不显示
  const mine = rd('miniprogram/pages/mine/mine.wxml');
  assert.ok(/goMyGifts"[^>]*wx:if="\{\{role === 'clerk' \|\| \(account && account\.orgMode\)\}\}"/.test(mine));
  assert.ok(rd('miniprogram/pages/mine/mine.js').includes('goMyGifts'));
  assert.ok(JSON.parse(rd('miniprogram/pages/renqing/renqing.json')).usingComponents['my-gifts']);
  assert.ok(rd('cloudfunctions/system/index.js').includes("'payer_status_rejected'"));
});
