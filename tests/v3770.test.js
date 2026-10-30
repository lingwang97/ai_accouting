// v3.77.0：「未收到」类通知独立模板（双模板订阅、各自消耗、旧前端不发）；宾客申诉跨礼簿计数 / 列表 / 处理（canBook 范围、归档礼簿规则）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction } = require('./helpers/sdk-stub.js');
const gn = require('../cloudfunctions/payment/guestnotify.js');

const ROOT = path.join(__dirname, '..');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const OWNER = 'o-owner';
const sent = [];
const REJ_TMPL = 'pOZ1wk9YDF5aSPc89guSJwQH6ay0Xdu7QJN5hb6Jc0U';

function seed(records, opt) {
  const o = opt || {};
  db.reset().applyUpdates = true;
  sent.length = 0;
  sdk.openapi.subscribeMessage = { send: async x => { sent.push(x); } };
  sdk.openapi.security = { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) };
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府', activeBookId: 'b1', orgMode: !!o.org }])
    .seed('users', [{ openid: OWNER, nickname: '主家' }, { openid: 'clerk-a', nickname: '甲' }, { openid: 'clerk-b', nickname: '乙' }])
    .seed('books', [
      { _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜', type: 'wedding', statReady: true },
      { _id: 'b2', ownerOpenid: OWNER, name: '乔迁之喜', type: 'other', hostName: '张府', statReady: true, archived: !!o.archived2 },
      { _id: 'b3', ownerOpenid: OWNER, name: '满月酒', type: 'other', statReady: true }
    ])
    .seed('members', [
      { _id: 'm1', aid: 'acc1', memberOpenid: 'clerk-a', role: 'clerk', bookIds: ['b1'], perms: ['confirm', 'desk'] },
      { _id: 'm2', aid: 'acc1', memberOpenid: 'clerk-b', role: 'clerk', bookIds: ['b1', 'b2'], perms: ['confirm', 'desk'] }
    ])
    .seed('records', records);
}
const rec = (id, extra) => ({ _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', themeName: '新婚之喜', payerOpenid: 'g1', payerName: '王五', amount: 600, payMethod: 'wechat', status: 'transferred', createdAt: new Date(), transferredAt: new Date(), ...extra });
const rej = (id, extra) => rec(id, { status: 'rejected', rejectedAt: new Date(), rejectedFrom: 'transferred', rejectReason: 'nofound', trail: [{ at: new Date(), who: 'owner', act: 'reject' }], ...extra });
const ap = (id, extra) => rej(id, { appealStatus: 'open', appealN: 1, appealAt: new Date(), ...extra });
const as = (openid, fnName, ev) => { state.openid = openid; return loadFunction(fnName).main(ev); };
const data = id => db.data.records.find(x => x._id === id);

// ---- 模板字段
test('buildReject：新模板字段 thing4 / time1 / amount2 / thing3，不含入簿模板字段；各字段 ≤20 字，金额两位小数', () => {
  const t = '2026年10月30日 10:00';
  const d = gn.buildReject({ hostName: '张府', themeName: '新婚之喜', amount: 600, count: 1, reason: 'nofound' }, t);
  assert.deepStrictEqual(Object.keys(d).sort(), ['amount2', 'thing3', 'thing4', 'time1']);
  assert.strictEqual(d.thing4.value, '张府 新婚之喜');
  assert.strictEqual(d.amount2.value, '600.00元');
  assert.strictEqual(d.time1.value, t);
  assert.strictEqual(d.thing3.value, '主家未查到到账，点此查看');
  assert.strictEqual(gn.buildReject({ amount: 1, count: 1, kept: true }, t).thing3.value, '主家核对后仍未收到，点此查看');
  assert.strictEqual(gn.buildReject({ amount: 1, count: 1, funeral: true }, t).thing3.value, '暂未核实到账，点此查看');
  assert.strictEqual(gn.buildReject({ amount: 1, count: 4 }, t).thing3.value, '4人未查到到账，点此查看');
  for (const v of Object.values(gn.buildReject({ hostName: '欧阳府😀', themeName: '一二三四五六七八九十一二三四五六七八九十', amount: 1, count: 12, kept: true }, t))) assert.ok(v.value.length <= 20, v.value);
  assert.strictEqual(gn.GUEST_REJECT_TMPL_ID, REJ_TMPL);
  assert.notStrictEqual(gn.GUEST_REJECT_TMPL_ID, gn.GUEST_TMPL_ID);
  assert.ok(rd('miniprogram/config.js').includes(REJ_TMPL), 'config.js 与云端模板 ID 一致');
});

// ---- 订阅标记
test('订阅标记：transferred / 现金登记 / 申诉分别记 guestNotify 与 guestRejectNotify；旧前端只带 guestNotify 则没有 guestRejectNotify', async () => {
  seed([rec('r1', { status: 'pending' }), rec('r2', { status: 'pending', payerOpenid: 'g2' }), rec('r3', { status: 'pending', payerOpenid: 'g3' }), rej('r4', { payerOpenid: 'g4' })]);
  await as('g1', 'payment', { action: 'transferred', rid: 'r1', envVersion: 'trial', guestNotify: true, guestRejectNotify: true });
  assert.strictEqual(data('r1').guestNotify, true);
  assert.strictEqual(data('r1').guestRejectNotify, true);
  assert.strictEqual(data('r1').guestEnv, 'trial');
  await as('g2', 'payment', { action: 'transferred', rid: 'r2', guestNotify: true }); // 旧前端
  assert.strictEqual(data('r2').guestNotify, true);
  assert.strictEqual(data('r2').guestRejectNotify, undefined);
  await as('g3', 'payment', { action: 'transferred', rid: 'r3', guestRejectNotify: true }); // 只同意未收到模板
  assert.strictEqual(data('r3').guestNotify, undefined);
  assert.strictEqual(data('r3').guestRejectNotify, true);
  const a = await as('g4', 'payment', { action: 'appeal', rid: 'r4', note: '转了', guestNotify: true, guestRejectNotify: true });
  assert.strictEqual(a.code, 0, a.msg);
  assert.strictEqual(data('r4').guestNotify, true);
  assert.strictEqual(data('r4').guestRejectNotify, true);
});

// ---- 各自消耗
test('未收到通知只用新模板、只消耗 guestRejectNotify；guestNotify 保留，之后入簿仍能发入簿通知', async () => {
  seed([rec('r1', { guestNotify: true, guestRejectNotify: true, guestEnv: 'trial' })]);
  await as(OWNER, 'payment', { action: 'reject', rid: 'r1', reason: 'nofound' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].templateId, REJ_TMPL);
  assert.strictEqual(sent[0].page, 'pages/myreceipts/myreceipts');
  assert.strictEqual(sent[0].data.thing3.value, '主家未查到到账，点此查看');
  assert.strictEqual(data('r1').guestRejectNotify, false);
  assert.strictEqual(data('r1').guestNotify, true, '入簿额度未被占用');
  // 撤销后再标未收到：未收到额度已用完，不再发
  await as(OWNER, 'payment', { action: 'unreject', rid: 'r1' });
  await as(OWNER, 'payment', { action: 'reject', rid: 'r1' });
  assert.strictEqual(sent.length, 1);
  // 之后确认入簿：仍发入簿通知，用入簿模板
  await as(OWNER, 'payment', { action: 'unreject', rid: 'r1' });
  await as(OWNER, 'payment', { action: 'confirm', rid: 'r1' });
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1].templateId, gn.GUEST_TMPL_ID);
  assert.strictEqual(sent[1].page, 'pages/receipt/receipt?rid=r1');
  assert.strictEqual(data('r1').guestNotify, true);
  assert.strictEqual(data('r1').guestRejectNotify, false);
});

test('入簿通知不消耗 guestRejectNotify：入簿后该标记仍在', async () => {
  seed([rec('r1', { guestNotify: true, guestRejectNotify: true })]);
  await as(OWNER, 'payment', { action: 'confirm', rid: 'r1' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].templateId, gn.GUEST_TMPL_ID);
  assert.strictEqual(data('r1').guestRejectNotify, true);
});

test('旧前端（只有 guestNotify、没有 guestRejectNotify）：标未收到 / 维持未收到都不发通知，也不借用入簿模板，guestNotify 不变', async () => {
  seed([rec('r1', { guestNotify: true }), ap('r2', { guestNotify: true })]);
  const r = await as(OWNER, 'payment', { action: 'reject', rid: 'r1', reason: 'amount' });
  assert.strictEqual(r.code, 0, r.msg);
  const k = await as(OWNER, 'payment', { action: 'resolveAppeal', rid: 'r2', decision: 'keep' });
  assert.strictEqual(k.code, 0, k.msg);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(data('r1').guestNotify, true);
  assert.strictEqual(data('r2').guestNotify, true);
});

test('维持未收到：用新模板发「核对后仍未收到」；批次一条取合计', async () => {
  const b = (id, i) => ap(id, { batchId: 'B1', batchIdx: i, batchSize: 2, payerName: '甲' + i, amount: 100, guestRejectNotify: true });
  seed([b('a0', 0), b('a1', 1)]);
  const k = await as(OWNER, 'payment', { action: 'resolveAppeal', rid: 'a1', decision: 'keep' });
  assert.strictEqual(k.code, 0, k.msg);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].templateId, REJ_TMPL);
  assert.strictEqual(sent[0].data.amount2.value, '200.00元');
  assert.strictEqual(sent[0].data.thing3.value, '2人核对后仍未收到，点此查看');
});

// ---- 跨礼簿申诉：计数 / 列表
test('records：申诉数含其他礼簿（canBook 范围内），pendingStat 返回 appeal 合计与 appealOther；pending 的 appeals 带礼簿名', async () => {
  seed([ap('r1'), ap('r2', { bookId: 'b2', themeName: '乔迁之喜' }), ap('r3', { bookId: 'b3' }), rej('r4', { bookId: 'b2' }), ap('r5', { bookId: 'b2', ownerOpenid: 'other-owner' })]);
  const st = await as(OWNER, 'records', { action: 'pendingStat', withExtra: true });
  assert.strictEqual(st.code, 0, st.msg);
  assert.strictEqual(st.data.appeal, 3);
  assert.strictEqual(st.data.appealOther, 2);
  const p = await as(OWNER, 'records', { action: 'pending', withRejected: true });
  assert.deepStrictEqual(p.data.appeals.map(x => x._id).sort(), ['r1', 'r2', 'r3']);
  assert.strictEqual(p.data.appealOther, 2);
  const r2 = p.data.appeals.find(x => x._id === 'r2');
  assert.strictEqual(r2.bookOther, true);
  assert.strictEqual(r2.bookName, '张府 · 乔迁之喜');
  assert.strictEqual(p.data.appeals.find(x => x._id === 'r1').bookOther, undefined);
  assert.ok(!JSON.stringify(p.data.appeals).includes('g1'), '不含宾客 openid');
});

test('records：记账人只看到自己负责礼簿的申诉；无确认权限的角色不返回申诉', async () => {
  seed([ap('r1'), ap('r2', { bookId: 'b2' }), ap('r3', { bookId: 'b3' })], { org: true });
  const a = await as('clerk-a', 'records', { action: 'pendingStat', withExtra: true });
  assert.strictEqual(a.data.appeal, 1); // 只负责 b1
  const b = await as('clerk-b', 'records', { action: 'pendingStat', withExtra: true });
  assert.strictEqual(b.data.appeal, 2);
  const pb = await as('clerk-b', 'records', { action: 'pending', withRejected: true });
  assert.deepStrictEqual(pb.data.appeals.map(x => x._id).sort(), ['r1', 'r2']);
  db.data.members.find(m => m._id === 'm2').perms = ['desk'];
  const c = await as('clerk-b', 'records', { action: 'pendingStat', withExtra: true });
  assert.strictEqual(c.data.appeal, 0);
});

// ---- 跨礼簿处理
test('resolveAppeal：不再限当前礼簿，主家可处理其他礼簿的申诉；accept 入簿到该礼簿并更新它的合计，不动当前礼簿', async () => {
  seed([ap('r1', { bookId: 'b2', themeName: '乔迁之喜', guestNotify: true })]);
  const r = await as(OWNER, 'payment', { action: 'resolveAppeal', rid: 'r1', decision: 'accept' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(data('r1').status, 'paid');
  assert.strictEqual(data('r1').appealStatus, 'accepted');
  const b2 = db.data.books.find(x => x._id === 'b2');
  assert.strictEqual(b2.statCount, 1);
  assert.strictEqual(b2.statFen, 60000);
  assert.strictEqual(db.data.books.find(x => x._id === 'b1').statCount, undefined);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].templateId, gn.GUEST_TMPL_ID); // 入簿通知仍用入簿模板
});

test('resolveAppeal keep：其他礼簿也可维持；批次整批 accept 跨礼簿', async () => {
  const b = (id, i) => ap(id, { bookId: 'b2', batchId: 'B1', batchIdx: i, batchSize: 2, payerName: '甲' + i, amount: 100 });
  seed([b('a0', 0), b('a1', 1), ap('k1', { bookId: 'b3' })]);
  const k = await as(OWNER, 'payment', { action: 'resolveAppeal', rid: 'k1', decision: 'keep' });
  assert.strictEqual(k.code, 0, k.msg);
  assert.strictEqual(data('k1').appealStatus, 'kept');
  const a = await as(OWNER, 'payment', { action: 'resolveAppeal', rid: 'a0', decision: 'accept' });
  assert.strictEqual(a.code, 0, a.msg);
  assert.strictEqual(db.data.books.find(x => x._id === 'b2').statCount, 2);
});

test('resolveAppeal：记账人只能处理自己负责（canBook）礼簿的申诉，其余拒绝且不改数据；负责的其他礼簿可以', async () => {
  seed([ap('r1', { bookId: 'b2' }), ap('r2', { bookId: 'b3' })], { org: true });
  const no = await as('clerk-a', 'payment', { action: 'resolveAppeal', rid: 'r1', decision: 'accept' }); // clerk-a 只负责 b1
  assert.notStrictEqual(no.code, 0);
  assert.strictEqual(data('r1').status, 'rejected');
  const nok = await as('clerk-a', 'payment', { action: 'resolveAppeal', rid: 'r1', decision: 'keep' });
  assert.notStrictEqual(nok.code, 0);
  assert.strictEqual(data('r1').appealStatus, 'open');
  const no3 = await as('clerk-b', 'payment', { action: 'resolveAppeal', rid: 'r2', decision: 'accept' }); // b3 不在 clerk-b 范围
  assert.notStrictEqual(no3.code, 0);
  assert.strictEqual(data('r2').status, 'rejected');
  const yes = await as('clerk-b', 'payment', { action: 'resolveAppeal', rid: 'r1', decision: 'accept' }); // b2 在范围内，虽非「当前」礼簿
  assert.strictEqual(yes.code, 0, yes.msg);
  assert.strictEqual(data('r1').status, 'paid');
});

test('归档礼簿：accept 入簿被拒并提示先取消归档（不改记录、不动合计）；keep 仍可；取消归档后可入簿；机构模式用「场次」', async () => {
  seed([ap('r1', { bookId: 'b2' }), ap('r2', { bookId: 'b2', payerName: '李四', payerOpenid: 'g2' })], { archived2: true });
  const r = await as(OWNER, 'payment', { action: 'resolveAppeal', rid: 'r1', decision: 'accept' });
  assert.notStrictEqual(r.code, 0);
  assert.ok(/已归档.*取消归档/.test(r.msg), r.msg);
  assert.ok(r.msg.includes('礼簿'));
  assert.strictEqual(data('r1').status, 'rejected');
  assert.strictEqual(data('r1').appealStatus, 'open');
  assert.strictEqual(db.data.books.find(x => x._id === 'b2').statCount, undefined);
  const k = await as(OWNER, 'payment', { action: 'resolveAppeal', rid: 'r2', decision: 'keep' });
  assert.strictEqual(k.code, 0, k.msg);
  assert.strictEqual(data('r2').appealStatus, 'kept');
  db.data.books.find(x => x._id === 'b2').archived = false;
  const ok = await as(OWNER, 'payment', { action: 'resolveAppeal', rid: 'r1', decision: 'accept' });
  assert.strictEqual(ok.code, 0, ok.msg);
  seed([ap('r3', { bookId: 'b2' })], { archived2: true, org: true });
  const o = await as(OWNER, 'payment', { action: 'resolveAppeal', rid: 'r3', decision: 'accept' });
  assert.ok(o.msg.includes('场次'), o.msg);
});

test('普通确认 / 标记未收到仍限定当前礼簿（不受放宽影响）', async () => {
  seed([rec('r1', { bookId: 'b2' })]);
  assert.notStrictEqual((await as(OWNER, 'payment', { action: 'confirm', rid: 'r1' })).code, 0);
  assert.notStrictEqual((await as(OWNER, 'payment', { action: 'reject', rid: 'r1' })).code, 0);
  assert.strictEqual(data('r1').status, 'transferred');
});

// ---- 前端 / 配置接线
test('guestsub.ask：一次请求两个模板，分别返回同意结果；拒绝 / 失败 / 无接口都全为 false；flags 只带同意的', async () => {
  const cfg = require('../miniprogram/config.js');
  const mod = f => { delete require.cache[require.resolve('../miniprogram/utils/guestsub.js')]; return require('../miniprogram/utils/guestsub.js'); };
  let asked = null;
  global.wx = { requestSubscribeMessage: o => { asked = o.tmplIds; o.success({ [cfg.GUEST_NOTIFY_TMPL_ID]: 'accept', [cfg.GUEST_REJECT_TMPL_ID]: 'reject' }); } };
  let g = mod();
  assert.deepStrictEqual(await g.ask(), { guestNotify: true, guestRejectNotify: false });
  assert.deepStrictEqual(asked, [cfg.GUEST_NOTIFY_TMPL_ID, cfg.GUEST_REJECT_TMPL_ID]);
  assert.strictEqual(cfg.GUEST_REJECT_TMPL_ID, REJ_TMPL);
  global.wx = { requestSubscribeMessage: o => o.success({ [cfg.GUEST_NOTIFY_TMPL_ID]: 'accept', [cfg.GUEST_REJECT_TMPL_ID]: 'accept' }) };
  g = mod();
  const both = await g.ask();
  assert.deepStrictEqual(both, { guestNotify: true, guestRejectNotify: true });
  assert.deepStrictEqual(g.flags(both), { guestNotify: true, guestRejectNotify: true });
  assert.deepStrictEqual(g.flags({ guestNotify: false, guestRejectNotify: true }), { guestRejectNotify: true });
  assert.deepStrictEqual(g.flags(null), {});
  global.wx = { requestSubscribeMessage: o => o.fail({}) };
  g = mod();
  assert.deepStrictEqual(await g.ask(), { guestNotify: false, guestRejectNotify: false });
  global.wx = {};
  g = mod();
  assert.deepStrictEqual(await g.ask(), { guestNotify: false, guestRejectNotify: false });
  delete global.wx;
});

test('前端接线：随礼 / 申诉的订阅仍在第一个 await 之前；请求带两个标记；待确认页「其他礼簿申诉」提示条；FAQ 与提审文档', () => {
  const pay = rd('miniprogram/pages/pay/pay.js');
  assert.ok(/const subP = pm === 'cash' \? this\.askGuestNotify\(\) : null;[\s\S]*await subP/.test(pay));
  assert.ok(/const subP = this\.askGuestNotify\(\);[\s\S]*await subP/.test(pay));
  assert.ok(/const subP = guestsub\.ask\(\);[\s\S]*await subP/.test(rd('miniprogram/components/my-gifts/index.js')));
  const rq = rd('miniprogram/utils/request.js');
  assert.ok(rq.includes('guestsub.flags(sub)'));
  const wxml = rd('miniprogram/pages/pending/pending.wxml');
  assert.ok(wxml.includes('还有 {{appealsOther.length}} 条宾客申诉') && wxml.includes('onOtherAp') && wxml.includes('item.bookName'));
  assert.ok(wxml.includes('宾客申诉（{{appeals.length}}）'));
  assert.ok(rd('miniprogram/pages/guide/faq.js').includes('其他礼簿还有 N 条宾客申诉'));
  const doc = rd('docs/提审与隐私说明.md');
  assert.ok(doc.includes('GUEST_REJECT_TMPL_ID') && doc.includes('owner_status_appeal'));
  const src = rd('cloudfunctions/system/index.js');
  assert.ok(src.includes("'owner_status_appeal'"));
});
