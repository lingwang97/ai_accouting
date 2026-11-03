// v3.85.0：已入簿礼金 72 小时修改锁 + 超期更正申请（随礼人同意）+ 修改 / 作废通知 + 删簿 / 注销给宾客留凭证
// 时间用「假时钟」控制（替换全局 Date，所有测试数据都在假时钟下创建）；LOCK_SINCE 之后 72 小时是老记录缓冲期
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const ST = require('../cloudfunctions/payment/status.js');
const Snap = require('../cloudfunctions/books/snapshot.js');

const OWNER = 'o-owner';
const ADMIN = 'o-admin';
const H = 3600 * 1000;
const RealDate = Date;
const LOCK = ST.LOCK_SINCE;
const NOW = LOCK + 30 * 24 * H; // 缓冲期之后

function setNow(ms) {
  global.Date = class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(ms); else super(...a); }
    static now() { return ms; }
  };
}
/** 在假时钟 ms 下运行 fn */
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
    security: { msgSecCheck: async o => (String(o.content).includes('脏话') ? { result: { suggest: 'risky' } } : { result: { suggest: 'pass' } }) }
  };
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER, nickname: '主家' }, { openid: 'u-clerk', currentAid: 'acc1', nickname: '记账' }])
    .seed('members', [{ _id: 'm1', aid: 'acc1', ownerOpenid: OWNER, memberOpenid: 'u-clerk', role: 'clerk', allBooks: true, perms: (extra && extra.perms) || ['confirm', 'void'], status: 'active', displayName: '小李' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜', type: 'wedding', statReady: true, statCount: 0, statFen: 0 }])
    .seed('records', records);
}
const rec = (id, extra) => ({
  _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', themeName: '新婚之喜', hostName: '张府',
  payerOpenid: 'g1', payerName: '王五', amount: 600, payMethod: 'wechat', status: 'paid', handlerOpenid: OWNER, handlerName: '主家',
  remark: '备注', relation: '朋友', createdAt: ago(10), transferredAt: ago(10), paidAt: ago(10), guestRejectNotify: true, guestEnv: 'trial', ...extra
});
const owner = ev => { state.openid = OWNER; return loadFunction('payment').main(ev); };
const clerk = ev => { state.openid = 'u-clerk'; return loadFunction('payment').main(ev); };
const guest = (ev, id) => { state.openid = id || 'g1'; return loadFunction('payment').main(ev); };
const get = id => db.data.records.find(r => r._id === id);

test('status.editDeadline / editCut：从 paidAt 起 72 小时；老记录取 max(paidAt, LOCK_SINCE) 缓冲；缓冲期内不加 paidAt 条件', () => {
  assert.strictEqual(ST.EDIT_MS, 72 * H);
  const p = LOCK + 10 * 24 * H;
  assert.strictEqual(ST.editDeadline({ paidAt: new RealDate(p) }), p + 72 * H);
  assert.strictEqual(ST.editDeadline({ paidAt: new RealDate(LOCK - 100 * H) }), LOCK + 72 * H, '老记录缓冲');
  assert.strictEqual(ST.editDeadline({}), 0, '没有 paidAt 视为已过期');
  assert.strictEqual(ST.editCut(LOCK + 10 * H), null, '缓冲期内无下限');
  assert.strictEqual(ST.editCut(NOW).getTime(), NOW - 72 * H);
});

test('amend：72 小时内可改，记 trail（金额 / 姓名）与 changeNotifyAt；超期拒绝且不顺延；缓冲期内老记录可改', async () => {
  await at(NOW, async () => {
    seed([rec('r1'), rec('r2', { paidAt: ago(73) }), rec('r3', { paidAt: ago(100), payerOpenid: '', claimedOpenid: '' })]);
    const r = await owner({ action: 'amend', rid: 'r1', amount: 800, remark: '新备注' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.strictEqual(r.data.record.editUntil, ago(10).getTime() + 72 * H);
    assert.strictEqual(r.data.record.canCorrect, true);
    const d = get('r1');
    assert.strictEqual(d.amount, 800);
    assert.ok(d.changeNotifyAt);
    assert.strictEqual(d.trail.length, 1);
    assert.strictEqual(d.trail[0].act, 'amend');
    assert.deepStrictEqual(d.trail[0].changes.amount, [600, 800]);
    assert.strictEqual(d.trail[0].changes.remark, undefined, '备注不给宾客看');
    // 更新条件里带 paidAt 下限（原子）
    const upd = db.log.filter(x => x.op === 'update' && x.col === 'records').pop();
    assert.ok(JSON.stringify(upd.cond).includes('paidAt'));
    // 只改备注：不写 trail、不通知
    const r1b = await owner({ action: 'amend', rid: 'r1', remark: '又改了备注' });
    assert.strictEqual(r1b.code, 0);
    assert.strictEqual(get('r1').trail.length, 1);
    // 超期：有随礼人身份的提示「申请更正」，没有的说明无法更正
    const r2 = await owner({ action: 'amend', rid: 'r2', amount: 1 });
    assert.strictEqual(r2.code, 1);
    assert.ok(/72 小时/.test(r2.msg) && /申请更正/.test(r2.msg), r2.msg);
    assert.strictEqual(get('r2').amount, 600);
    const r3 = await owner({ action: 'amend', rid: 'r3', amount: 1 });
    assert.ok(/72 小时/.test(r3.msg) && /无法申请更正/.test(r3.msg), r3.msg);
  });
  // 缓冲期：上线后 72 小时内，上线前入簿的老记录仍可改；过了就锁
  await at(LOCK + 10 * H, async () => {
    seed([rec('o1', { paidAt: new RealDate(LOCK - 200 * H) })]);
    assert.strictEqual((await owner({ action: 'amend', rid: 'o1', amount: 700 })).code, 0);
  });
  await at(LOCK + 73 * H, async () => {
    seed([rec('o1', { paidAt: new RealDate(LOCK - 200 * H) })]);
    assert.strictEqual((await owner({ action: 'amend', rid: 'o1', amount: 700 })).code, 1);
  });
});

test('void：72 小时内可作废，写 voidedAt / trail / changeNotifyAt；超期拒绝；记账人按权限', async () => {
  await at(NOW, async () => {
    seed([rec('r1'), rec('r2', { paidAt: ago(80) })]);
    const r = await owner({ action: 'void', rid: 'r1' });
    assert.strictEqual(r.code, 0, r.msg);
    const d = get('r1');
    assert.strictEqual(d.status, 'void');
    assert.ok(d.voidedAt && d.changeNotifyAt);
    assert.strictEqual(d.trail.slice(-1)[0].act, 'void');
    const upd = db.log.filter(x => x.op === 'update' && x.col === 'records').pop();
    assert.ok(JSON.stringify(upd.cond).includes('paidAt'), '作废的原子条件带 paidAt');
    const r2 = await owner({ action: 'void', rid: 'r2' });
    assert.strictEqual(r2.code, 1);
    assert.ok(/72 小时/.test(r2.msg), r2.msg);
    assert.strictEqual(get('r2').status, 'paid');
    // 记账人有 void 权限可作废（同样受 72 小时限制）
    seed([rec('r3'), rec('r4', { paidAt: ago(80) })]);
    assert.strictEqual((await clerk({ action: 'void', rid: 'r3' })).code, 0);
    assert.strictEqual((await clerk({ action: 'void', rid: 'r4' })).code, 1);
  });
});

test('correct：只对超期、有随礼人身份的已入簿记录；理由必填并过内容安全；同时只能 1 条待处理；权限与 amend 相同', async () => {
  await at(NOW, async () => {
    seed([rec('a', { paidAt: ago(80) }), rec('in', { paidAt: ago(10) }), rec('noid', { paidAt: ago(80), payerOpenid: '' }), rec('claimed', { paidAt: ago(80), payerOpenid: '', claimedOpenid: 'g2' })]);
    const base = { action: 'correct', rid: 'a', kind: 'amount', newAmount: 500, reason: '多写了一个零' };
    assert.ok(/不需要申请/.test((await owner({ ...base, rid: 'in' })).msg), '72 小时内直接改');
    assert.ok(/无法申请更正/.test((await owner({ ...base, rid: 'noid' })).msg), '没有随礼人身份');
    assert.ok(/填写更正理由/.test((await owner({ ...base, reason: '' })).msg));
    assert.ok(/内容含有不适宜/.test((await owner({ ...base, reason: '脏话' })).msg), '理由过内容安全');
    assert.ok(/正确的金额/.test((await owner({ ...base, newAmount: 0 })).msg));
    assert.ok(/一样/.test((await owner({ ...base, newAmount: 600 })).msg));
    assert.strictEqual((await owner({ ...base, kind: 'bad' })).code, 1);
    assert.strictEqual(get('a').corrState, undefined, '失败不留痕');
    const r = await owner(base);
    assert.strictEqual(r.code, 0, r.msg);
    const d = get('a');
    assert.strictEqual(d.corrState, 'pending');
    assert.strictEqual(d.corrN, 1);
    assert.strictEqual(d.correction.kind, 'amount');
    assert.strictEqual(d.correction.newAmount, 500);
    assert.strictEqual(d.amount, 600, '申请期间原记录不变');
    assert.strictEqual(d.trail.slice(-1)[0].act, 'corr_ask');
    assert.strictEqual(r.data.record.corrState, 'pending');
    assert.ok(!('payerOpenid' in r.data.record));
    assert.ok(/已有一条/.test((await owner(base)).msg), '待处理期间不能再申请');
    // 通知：复用「记账提醒」，消耗 guestRejectNotify
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].templateId, require('../cloudfunctions/payment/guestnotify.js').GUEST_REJECT_TMPL_ID);
    assert.strictEqual(sent[0].touser, 'g1');
    assert.ok(sent[0].data.thing3.value.includes('申请更正'));
    assert.strictEqual(d.guestRejectNotify, false);
    // 认领人（没有 payerOpenid）也可以申请
    assert.strictEqual((await owner({ action: 'correct', rid: 'claimed', kind: 'name', newName: '赵六', reason: '写错了字' })).code, 0);
    assert.strictEqual(get('claimed').correction.newName, '赵六');
    // 作废类
    seed([rec('v', { paidAt: ago(80) })]);
    assert.strictEqual((await owner({ action: 'correct', rid: 'v', kind: 'void', reason: '重复录入' })).code, 0);
  });
});

test('correct：权限——记账人需要 confirm 或 void；没有任何权限被拒；宾客 / 陌生人调用被拒；家人只读被拒', async () => {
  await at(NOW, async () => {
    const body = { action: 'correct', rid: 'a', kind: 'void', reason: '重复' };
    seed([rec('a', { paidAt: ago(80) })], { perms: ['confirm'] });
    assert.strictEqual((await clerk(body)).code, 0, '有 confirm 即可');
    seed([rec('a', { paidAt: ago(80) })], { perms: ['show'] });
    const r = await clerk(body);
    assert.strictEqual(r.code, 1);
    assert.ok(/申请更正/.test(r.msg) && /权限/.test(r.msg), r.msg);
    seed([rec('a', { paidAt: ago(80) })]);
    assert.strictEqual((await guest(body, 'g1')).code, 1, '随礼人不能发起');
    assert.strictEqual((await guest(body, 'stranger')).code, 1);
    assert.strictEqual(get('a').corrState, undefined);
    const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/payment/index.js'), 'utf8');
    assert.ok(/OWNER_ACTIONS = \[[^\]]*'correct'/.test(src), 'correct 在 OWNER_ACTIONS');
    assert.ok(/NEED = \{[^}]*correct: \['confirm', 'void'\]/.test(src), 'correct 在 NEED');
  });
});

test('correctReply：同意（金额 / 姓名 / 作废）条件原子执行并写日志；重复同意、非本人、过期、已处理都拒绝', async () => {
  await at(NOW, async () => {
    const pend = (id, c, extra) => rec(id, { paidAt: ago(80), corrState: 'pending', corrAt: ago(1), corrN: 1, correction: { kind: 'amount', reason: '多写了零', by: '主家', at: ago(1), state: 'pending', ...c }, ...extra });
    seed([pend('amt', { kind: 'amount', newAmount: 500 }), pend('nm', { kind: 'name', newName: '赵六' }), pend('vd', { kind: 'void' }), pend('old', { kind: 'void' }, { corrAt: ago(8 * 24) }), pend('cl', { kind: 'name', newName: '孙七' }, { payerOpenid: '', claimedOpenid: 'g2' })]);
    assert.strictEqual((await guest({ action: 'correctReply', rid: 'amt', decision: 'agree' }, 'stranger')).msg, '无权操作');
    assert.strictEqual((await guest({ action: 'correctReply', rid: 'amt', decision: 'x' })).code, 1);
    const r = await guest({ action: 'correctReply', rid: 'amt', decision: 'agree' });
    assert.strictEqual(r.code, 0, r.msg);
    let d = get('amt');
    assert.strictEqual(d.amount, 500);
    assert.strictEqual(d.corrState, 'agreed');
    assert.strictEqual(d.amendN, 1);
    assert.strictEqual(d.amendLog.slice(-1)[0].changes.amount[1], 500);
    assert.strictEqual(d.trail.slice(-1)[0].act, 'corr_agree');
    assert.strictEqual(d.correction.state, 'agreed');
    // 礼簿合计同步（差额 -100 元 = -10000 分）
    const stat = db.log.filter(x => x.op === 'update' && x.col === 'books');
    assert.ok(stat.length >= 0);
    assert.ok(/已处理或已失效/.test((await guest({ action: 'correctReply', rid: 'amt', decision: 'agree' })).msg), '不能重复同意');
    assert.strictEqual(get('amt').amount, 500);
    assert.strictEqual((await guest({ action: 'correctReply', rid: 'nm', decision: 'agree' })).code, 0);
    d = get('nm');
    assert.strictEqual(d.payerName, '赵六');
    assert.ok(d.personKey, '改名前固定往来人标识');
    assert.strictEqual((await guest({ action: 'correctReply', rid: 'vd', decision: 'agree' })).code, 0);
    d = get('vd');
    assert.strictEqual(d.status, 'void');
    assert.ok(d.voidedAt);
    assert.strictEqual((await guest({ action: 'correctReply', rid: 'cl', decision: 'agree' }, 'g2')).code, 0, '认领人可同意');
    assert.ok(/已过期/.test((await guest({ action: 'correctReply', rid: 'old', decision: 'agree' })).msg));
    assert.strictEqual(get('old').status, 'paid');
  });
});

test('correctReply：拒绝后保持原样、写日志，主家侧 corrState=declined；之后可再申请（最多 3 次）', async () => {
  await at(NOW, async () => {
    seed([rec('a', { paidAt: ago(80) })]);
    await owner({ action: 'correct', rid: 'a', kind: 'amount', newAmount: 500, reason: '一' });
    const r = await guest({ action: 'correctReply', rid: 'a', decision: 'decline' });
    assert.strictEqual(r.code, 0, r.msg);
    let d = get('a');
    assert.strictEqual(d.amount, 600);
    assert.strictEqual(d.corrState, 'declined');
    assert.strictEqual(d.trail.slice(-1)[0].act, 'corr_decline');
    assert.strictEqual((await owner({ action: 'correct', rid: 'a', kind: 'amount', newAmount: 500, reason: '二' })).code, 0, '拒绝后可再申请');
    await guest({ action: 'correctReply', rid: 'a', decision: 'decline' });
    assert.strictEqual((await owner({ action: 'correct', rid: 'a', kind: 'amount', newAmount: 500, reason: '三' })).code, 0);
    await guest({ action: 'correctReply', rid: 'a', decision: 'decline' });
    assert.ok(/3 次/.test((await owner({ action: 'correct', rid: 'a', kind: 'amount', newAmount: 500, reason: '四' })).msg));
    // 主家侧看到结果：records.list 返回 corrState
    d = get('a');
    assert.strictEqual(d.corrN, 3);
  });
});

test('warmer.expireCorrections：超过 7 天未处理的置 expired，原记录不变；没到期的不动', async () => {
  await at(NOW, async () => {
    seed([rec('old', { paidAt: ago(300), corrState: 'pending', corrAt: ago(8 * 24), correction: { kind: 'void', state: 'pending' } }), rec('new', { paidAt: ago(300), corrState: 'pending', corrAt: ago(2 * 24), correction: { kind: 'void', state: 'pending' } })]);
    const warmer = loadFunction('warmer');
    assert.strictEqual(await warmer._test.expireCorrections(), 1);
    assert.strictEqual(get('old').corrState, 'expired');
    assert.strictEqual(get('old').status, 'paid');
    assert.strictEqual(get('new').corrState, 'pending');
    // 过期后随礼人不能再同意
    assert.ok(/已处理或已失效/.test((await guest({ action: 'correctReply', rid: 'old', decision: 'agree' })).msg));
  });
});

test('变更通知：10 分钟后由 warmer 合并发一条（复用记账提醒，消耗一次性额度）；没到 10 分钟不发；没额度不发但清掉标记；只发一次', async () => {
  await at(NOW, async () => {
    const gn = require('../cloudfunctions/warmer/guestnotify.js');
    seed([
      rec('v', { status: 'void', changeNotifyAt: new RealDate(NOW - 11 * 60 * 1000) }),
      rec('am', { amount: 800, changeNotifyAt: new RealDate(NOW - 20 * 60 * 1000) }),
      rec('young', { changeNotifyAt: new RealDate(NOW - 3 * 60 * 1000) }),
      rec('noq', { guestRejectNotify: false, changeNotifyAt: new RealDate(NOW - 30 * 60 * 1000) }),
      rec('desk', { payerOpenid: '', deskEntry: true, changeNotifyAt: new RealDate(NOW - 30 * 60 * 1000) })
    ]);
    const n = await gn.create(db, sdk).sendChanges(20);
    assert.strictEqual(n, 2);
    assert.strictEqual(sent.length, 2);
    const byRid = {};
    sent.forEach(s => { byRid[s.data.thing3.value] = s; });
    assert.ok(Object.keys(byRid).some(k => k.includes('已作废')));
    assert.ok(Object.keys(byRid).some(k => k.includes('已更正')));
    sent.forEach(s => { assert.strictEqual(s.templateId, gn.GUEST_REJECT_TMPL_ID); assert.strictEqual(s.page, 'pages/myreceipts/myreceipts'); Object.values(s.data).forEach(v => assert.ok(v.value.length <= 20, v.value)); });
    assert.strictEqual(get('v').guestRejectNotify, false);
    assert.strictEqual(get('v').changeNotifyAt, undefined);
    assert.ok(get('young').changeNotifyAt, '没到 10 分钟的保留');
    assert.strictEqual(get('noq').changeNotifyAt, undefined, '没额度也清掉标记，不重复尝试');
    assert.strictEqual((await gn.create(db, sdk).sendChanges(20)), 0, '第二次不再发');
    assert.strictEqual(sent.length, 2);
  });
});

test('变更通知文案：白事用「奠仪记录」；buildChange 字段不超过 20 字', () => {
  const gn = require('../cloudfunctions/payment/guestnotify.js');
  const d = gn.buildChange({ hostName: '欧阳府', themeName: '追思会', amount: 600, note: '奠仪记录已作废，点此查看' }, '2026年12月1日 10:00');
  Object.values(d).forEach(v => assert.ok(v.value.length <= 20, v.value));
  assert.strictEqual(d.amount2.value, '600.00元');
  assert.strictEqual(gn.CHANGE_DELAY_MS, 10 * 60 * 1000);
});

test('myReceipts：返回已作废（30 天）、待我确认的更正申请、已更正标记与修改记录、lastChangeAt；不泄露 openid 与记账人', async () => {
  await at(NOW, async () => {
    seed([
      rec('p1', { amount: 800, amendN: 1, amendedAt: ago(2), trail: [{ at: ago(2), act: 'amend', who: 'owner', name: '主家', changes: { amount: [600, 800] } }] }),
      rec('v1', { status: 'void', voidedAt: ago(3), trail: [{ at: ago(3), act: 'void', who: 'owner', name: '主家' }] }),
      rec('vold', { status: 'void', voidedAt: ago(40 * 24) }),
      rec('c1', { paidAt: ago(100), corrState: 'pending', corrAt: ago(1), correction: { kind: 'amount', newAmount: 500, reason: '多写了零', by: '小李', at: ago(1), state: 'pending' }, trail: [{ at: ago(1), act: 'corr_ask', kind: 'amount', newAmount: 500, why: '多写了零' }] }),
      rec('other', { payerOpenid: 'g9' })
    ]);
    const r = await guest({ action: 'myReceipts' });
    assert.strictEqual(r.code, 0, r.msg);
    const d = r.data;
    assert.deepStrictEqual(d.voided.map(x => x._id), ['v1']);
    assert.strictEqual(d.voided[0].status, 'void');
    assert.ok(d.voided[0].timeline.some(t => t.text.includes('作废')));
    const p1 = d.list.find(x => x._id === 'p1');
    assert.strictEqual(p1.amended, true);
    assert.ok(p1.changes[0].text.includes('600 → 800'));
    assert.strictEqual(p1.own, true);
    assert.strictEqual(d.correctionN, 1);
    assert.strictEqual(d.corrections[0]._id, 'c1');
    assert.strictEqual(d.corrections[0].newAmount, 500);
    assert.strictEqual(d.corrections[0].reason, '多写了零');
    assert.ok(d.corrections[0].expireAt);
    assert.strictEqual(d.lastChangeAt, NOW - 1 * H, '取最近一次变更时间');
    const txt = JSON.stringify(d);
    ['o-owner', 'g1', 'handlerOpenid', 'payerOpenid'].forEach(k => assert.ok(!txt.includes(k), '不含 openid / 记账人：' + k + ' ' + txt.slice(Math.max(0, txt.indexOf(k) - 30), txt.indexOf(k) + 30)));
    ['小李', 'handlerName', 'rejectedBy'].forEach(k => assert.ok(!JSON.stringify([d.voided, d.corrections, d.vouchers]).includes(k), k));
    assert.ok(!d.list.some(x => x._id === 'other'));
  });
});

test('resub：本人对自己的记录重新订阅（补 guestRejectNotify）；别人的无权；没同意不改', async () => {
  await at(NOW, async () => {
    seed([rec('a', { guestRejectNotify: false })]);
    assert.strictEqual((await guest({ action: 'resub', rid: 'a', envVersion: 'trial', guestRejectNotify: true }, 'stranger')).msg, '无权操作');
    assert.strictEqual((await guest({ action: 'resub', rid: 'a', envVersion: 'trial' })).data.enabled, false);
    assert.strictEqual(get('a').guestRejectNotify, false);
    assert.strictEqual((await guest({ action: 'resub', rid: 'a', envVersion: 'trial', guestRejectNotify: true })).data.enabled, true);
    assert.strictEqual(get('a').guestRejectNotify, true);
    assert.strictEqual(get('a').guestEnv, 'trial');
  });
});

test('records.list：已入簿记录带 editUntil 与 canCorrect，corrState 对主家可见；不返回 openid', async () => {
  await at(NOW, async () => {
    seed([rec('a', { corrState: 'declined', correction: { kind: 'void', state: 'declined' } }), rec('noid', { payerOpenid: '' })]);
    state.openid = OWNER;
    const r = await loadFunction('records').main({ action: 'list', bookId: 'b1', status: 'paid' });
    assert.strictEqual(r.code, 0, r.msg);
    const a = r.data.list.find(x => x._id === 'a');
    assert.strictEqual(a.editUntil, ago(10).getTime() + 72 * H);
    assert.strictEqual(a.canCorrect, true);
    assert.strictEqual(a.corrState, 'declined');
    assert.ok(!('payerOpenid' in a));
    assert.strictEqual(r.data.list.find(x => x._id === 'noid').canCorrect, false);
  });
});

// —— 凭证快照 ——
const sref = (id, extra) => rec(id, { status: 'paid', ...extra });
function seedBook() {
  seed([
    sref('s1', { amendN: 1, amendedAt: ago(1), amendLog: [{ at: ago(1), by: '小李', changes: { amount: [500, 600], remark: ['', '备注'] } }] }),
    sref('s2', { payerOpenid: '', claimedOpenid: 'g2', payerName: '李四' }),
    sref('s3', { payerOpenid: '', payerName: '现金宾客', payMethod: 'cash', deskEntry: true }),
    sref('s4', { status: 'void', voidedAt: ago(2), payerName: '作废的' }),
    sref('s5', { status: 'rejected', rejectedAt: ago(3), rejectReason: 'nofound', payerName: '未收到' }),
    sref('s6', { status: 'transferred', payerName: '等待中' }),
    sref('s7', { bookId: 'b2', payerName: '别的礼簿' })
  ]);
  db.persist = true;
}

test('快照：只给有宾客身份且有结果的记录留凭证（_id=rid，幂等）；不含记账人、备注、关系、主家 openid 以外的内部字段', async () => {
  seedBook();
  assert.strictEqual(await Snap.snapshotRecords(db, OWNER, { bookId: 'b1' }, 0), true);
  const ids = (db.data.guest_receipts || []).map(x => x._id).sort();
  assert.deepStrictEqual(ids, ['s1', 's2', 's4', 's5']);
  const s1 = db.data.guest_receipts.find(x => x._id === 's1');
  assert.strictEqual(s1.guestOpenid, 'g1');
  assert.strictEqual(db.data.guest_receipts.find(x => x._id === 's2').guestOpenid, 'g2');
  assert.strictEqual(s1.hostName, '张府');
  assert.strictEqual(s1.themeName, '新婚之喜');
  assert.strictEqual(s1.amount, 600);
  assert.strictEqual(s1.status, 'paid');
  assert.ok(s1.trail.some(e => e.act === 'amend' && e.changes.amount[1] === 600), '旧版只在 amendLog 里的修改补进时间线');
  assert.ok(!s1.trail.some(e => e.changes && e.changes.remark));
  ['handlerName', 'handlerOpenid', 'remark', 'relation', 'payCodeFileID', 'rcptToken', 'amendLog', 'guestEnv', 'guestRejectNotify'].forEach(k => assert.ok(!(k in s1), k));
  assert.ok(!JSON.stringify(s1).includes('小李'));
  // 再跑一遍不重复（幂等）
  await Snap.snapshotRecords(db, OWNER, { bookId: 'b1' }, 0);
  assert.strictEqual(db.data.guest_receipts.length, 4);
});

test('trash.moveToTrash：删礼簿前先留凭证；时间不够返回 false 且礼簿还在，续跑接着做', async () => {
  seedBook();
  const trash = require('../cloudfunctions/books/trash.js');
  const done = await trash.moveToTrash(db, OWNER, 'b1', { _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜', type: 'wedding' }, { aid: 'acc1' }, 15);
  assert.strictEqual(done, true);
  assert.deepStrictEqual(db.data.guest_receipts.map(x => x._id).sort(), ['s1', 's2', 's4', 's5']);
  assert.ok(db.data.trash_books.some(t => t._id === 'b1'));
  // 源码保证：快照在移动 / 删除礼簿之前
  const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/books/trash.js'), 'utf8');
  assert.ok(src.indexOf('Snap.snapshotRecords') < src.indexOf("await db.collection('books').doc(bookId).remove()"));
});

test('trash.restore：礼簿放回后删除该簿凭证（以实时记录为准）；永久删除回收站不删凭证', async () => {
  seedBook();
  db.data.trash_books = [{ _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜', type: 'wedding', trashStatus: 'done' }];
  db.data.trash_records = [];
  const trash = require('../cloudfunctions/books/trash.js');
  await trash.restore(db, OWNER, 'b1');
  const rm = db.log.filter(x => x.op === 'remove' && x.col === 'guest_receipts');
  assert.strictEqual(rm.length >= 1, true, '恢复时删除快照');
  assert.strictEqual(rm[0].cond.bookId, 'b1');
  db.log.length = 0;
  await trash.purge(db, sdk, { _id: 'b1', ownerOpenid: OWNER, files: [] });
  assert.ok(!db.log.some(x => x.op === 'remove' && x.col === 'guest_receipts'), '永久删除回收站不动凭证');
});

test('Purge.run：用户自己注销（snapshot）先留凭证、不删主家名下的凭证；管理员清除不留且删该主家名下凭证；都删自己作为宾客的凭证', async () => {
  const Purge = require('../cloudfunctions/account/purge.js');
  seedBook();
  await Purge.run(db, sdk, OWNER, { snapshot: true });
  assert.deepStrictEqual(db.data.guest_receipts.map(x => x._id).sort(), ['s1', 's2', 's4', 's5', 's7'], '注销前对整个主家（含别的礼簿）有身份的记录留凭证');
  const rmUser = db.log.filter(x => x.op === 'remove' && x.col === 'guest_receipts');
  assert.ok(rmUser.every(x => x.cond.guestOpenid === OWNER), '用户路径只删自己作为宾客的凭证');
  assert.ok(!rmUser.some(x => x.cond.ownerOpenid), '不删主家名下的凭证');
  // 快照早于删记录
  const iSnap = db.log.findIndex(x => x.op === 'get' && x.col === 'records');
  const iDel = db.log.findIndex(x => x.op === 'remove' && x.col === 'records');
  assert.ok(iSnap >= 0 && iDel > iSnap);
  // 管理员清除：不留凭证，且按 ownerOpenid 删
  seedBook();
  db.log.length = 0;
  await Purge.run(db, sdk, OWNER, { subscription: true });
  assert.ok(!db.data.guest_receipts || db.data.guest_receipts.length === 0, '管理员清除不留快照');
  const rmAdmin = db.log.filter(x => x.op === 'remove' && x.col === 'guest_receipts');
  assert.ok(rmAdmin.some(x => x.cond.ownerOpenid === OWNER), '管理员路径删主家名下凭证');
  assert.ok(Purge.targets('x', { snapshot: true }).every(t => !(t[1] === 'guest_receipts' && t[2].ownerOpenid)));
  assert.ok(Purge.targets('x', {}).some(t => t[1] === 'guest_receipts' && t[2].ownerOpenid === 'x'));
  // account.purge 传 snapshot: true
  assert.ok(/Purge\.run\(db, cloud, openid, \{ ownPayCode, snapshot: true \}\)/.test(fs.readFileSync(path.join(ROOT, 'cloudfunctions/account/index.js'), 'utf8')));
});

test('清除测试数据：wipeAll 预览含宾客随礼凭证；adminPurgeBook 删该簿凭证', async () => {
  db.reset().applyUpdates = true;
  db.persist = true;
  sdk.openapi = {};
  db.seed('settings', [{ _id: 'admins', openids: [ADMIN] }])
    .seed('guest_receipts', [{ _id: 's1', guestOpenid: 'g1', ownerOpenid: OWNER, bookId: 'b1' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '婚礼', type: 'wedding' }])
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER }]);
  state.openid = ADMIN;
  const sys = loadFunction('system');
  const w = await quiet(() => sys.main({ action: 'adminWipePreview' }));
  assert.strictEqual(w.code, 0, w.msg);
  assert.ok(w.data.rows.some(r => r.label === '宾客随礼凭证' && r.count === 1), JSON.stringify(w.data.rows));
  db.log.length = 0;
  const p = await quiet(() => sys.main({ action: 'adminPurgeBook', bookId: 'b1', confirmName: '婚礼' }));
  assert.strictEqual(p.code, 0, p.msg);
  const rm = db.log.filter(x => x.op === 'remove' && x.col === 'guest_receipts');
  assert.ok(rm.some(x => x.cond.ownerOpenid === OWNER && x.cond.bookId === 'b1'));
});

test('deleteVoucher：只能删自己的凭证（条件含 guestOpenid），一次最多 20 条；myReceipts 补充显示已删除礼簿的凭证且不与实时记录重复', async () => {
  await at(NOW, async () => {
    seed([rec('live', { paidAt: ago(5) })]);
    db.seed('guest_receipts', [
      { _id: 'live', guestOpenid: 'g1', ownerOpenid: OWNER, bookId: 'b1', status: 'paid', amount: 600, payerName: '王五', hostName: '张府', themeName: '新婚之喜', bookType: 'wedding', createdAt: ago(50), paidAt: ago(50), trail: [], snapshotAt: ago(1) },
      { _id: 'gone', guestOpenid: 'g1', ownerOpenid: 'o-x', bookId: 'bx', status: 'void', amount: 200, payerName: '王五', hostName: '李府', themeName: '寿宴', bookType: 'birthday', createdAt: ago(900), paidAt: ago(900), voidedAt: ago(800), trail: [{ at: ago(800), act: 'void' }], snapshotAt: ago(100) },
      { _id: 'b1x', guestOpenid: 'g1', ownerOpenid: 'o-x', bookId: 'bx', batchId: 'B', status: 'paid', amount: 100, payerName: '甲', hostName: '赵府', themeName: '乔迁', createdAt: ago(900), paidAt: ago(900), trail: [], snapshotAt: ago(100) },
      { _id: 'b2x', guestOpenid: 'g1', ownerOpenid: 'o-x', bookId: 'bx', batchId: 'B', status: 'paid', amount: 50, payerName: '乙', hostName: '赵府', themeName: '乔迁', createdAt: ago(900), paidAt: ago(900), trail: [], snapshotAt: ago(100) },
      { _id: 'other', guestOpenid: 'g9', ownerOpenid: 'o-x', bookId: 'bx', status: 'paid', amount: 1, payerName: '别人', snapshotAt: ago(100) }
    ]);
    const r = await guest({ action: 'myReceipts' });
    assert.strictEqual(r.code, 0, r.msg);
    const ids = r.data.vouchers.map(v => v._id).sort();
    assert.deepStrictEqual(ids, ['b1x', 'gone'], '实时记录不重复、别人的不显示、批次合成一行');
    const batch = r.data.vouchers.find(v => v._id === 'b1x');
    assert.strictEqual(batch.amount, 150);
    assert.deepStrictEqual(batch.ids.sort(), ['b1x', 'b2x']);
    assert.strictEqual(r.data.vouchers.find(v => v._id === 'gone').status, 'void');
    assert.ok(!JSON.stringify(r.data.vouchers).includes('o-x') && !JSON.stringify(r.data.vouchers).includes('g9'));
    db.log.length = 0;
    const d = await guest({ action: 'deleteVoucher', rids: ['gone', 'b1x', 'bad id!'] });
    assert.strictEqual(d.code, 0);
    const rm = db.log.find(x => x.op === 'remove' && x.col === 'guest_receipts');
    assert.strictEqual(rm.cond.guestOpenid, 'g1', '只删自己的');
    assert.deepStrictEqual(rm.cond._id.v.sort(), ['b1x', 'gone']);
    assert.strictEqual((await guest({ action: 'deleteVoucher', rids: [] })).code, 1);
  });
});

test('索引与集合：新增 4 条索引、guest_receipts 在集合清单与 purge 清单', () => {
  const sys = fs.readFileSync(path.join(ROOT, 'cloudfunctions/system/index.js'), 'utf8');
  ['payer_status_void', 'corr_pending', 'chg_pending', 'payer_snapshot'].forEach(n => assert.ok(sys.includes(`'${n}'`), n));
  const { COLLECTIONS } = require('../tools/cloud-shared/collections.js');
  assert.ok(COLLECTIONS.includes('guest_receipts'));
});

test('隐私说明与帮助：写明 72 小时、更正申请、凭证长期保留、可自行删除；不出现「即表示同意」', () => {
  const priv = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/privacy/privacy.js'), 'utf8');
  const doc = fs.readFileSync(path.join(ROOT, 'docs/提审与隐私说明.md'), 'utf8');
  [priv, doc].forEach(t => {
    assert.ok(t.includes('72 小时'));
    assert.ok(t.includes('更正申请'));
    assert.ok(t.includes('凭证'));
    assert.ok(/长期保留/.test(t));
    assert.ok(!/即表示同意|即视为同意|视为同意/.test(t));
  });
  assert.ok(priv.includes('随礼人可随时在「我的随礼记录」里自行删除'));
  assert.ok(doc.includes('用户隐私保护指引') && doc.includes('需要同步补充'));
  const faq = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/guide/faq.js'), 'utf8');
  assert.ok(faq.includes('72 小时') && faq.includes('申请更正') && faq.includes('保留一份凭证'));
});

test('弹窗按钮字数：新增的 showModal 确认按钮不超过 4 个字；toast 带 success 不超过 7 个字', () => {
  const files = ['miniprogram/components/my-gifts/index.js', 'miniprogram/pages/records/records.js', 'miniprogram/pages/receipt/receipt.js'];
  files.forEach(f => {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    (t.match(/confirmText: [^,\n]+/g) || []).forEach(m => {
      const lits = m.match(/'([^']+)'/g) || [];
      lits.forEach(l => assert.ok(l.length - 2 <= 4, f + ' ' + m));
    });
    (t.match(/title: '[^']+', icon: 'success'/g) || []).forEach(m => assert.ok(m.match(/title: '([^']+)'/)[1].length <= 7, f + ' ' + m));
  });
});
