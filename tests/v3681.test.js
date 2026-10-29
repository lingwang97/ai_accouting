// v3.68.1：宾客入簿通知补发（等待 1.5 秒、可重试失败撤销占位、warmer 补发、不重复）、额度补漏（家人升级记账人 / 回收站恢复）、
// 头像只接受 avatars/ 文件（随机文件名、换头像删旧文件）、清除数据删头像文件与频率计数
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const GN = require('../tools/cloud-shared/guestnotify.js');
const Purge = require('../tools/cloud-shared/purge.js');

const OWNER = 'o-owner';
const DAY = 24 * 3600 * 1000;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sent = [];

function seedGuest(records) {
  db.reset().applyUpdates = true;
  sent.length = 0;
  sdk.openapi.subscribeMessage = { send: async o => { sent.push(o); } };
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜', type: 'wedding' }])
    .seed('records', records);
}
const rec = (id, extra) => ({ _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', themeName: '新婚之喜', payerOpenid: 'g1', payerName: '王五', amount: 600, payMethod: 'wechat', status: 'transferred', guestNotify: true, createdAt: new Date(), ...extra });
const owner = ev => { state.openid = OWNER; return loadFunction('payment').main(ev); };
const failWith = code => { sdk.openapi.subscribeMessage = { send: async () => { const e = new Error('x'); e.errCode = code; throw e; } }; };
const okSend = () => { sdk.openapi.subscribeMessage = { send: async o => { sent.push(o); } }; };

test('入簿通知：确认最多等 1.5 秒（原 3 秒）；模板 ID 前后端一致；payment 与 warmer 共用模块', () => {
  const pay = read('cloudfunctions/payment/index.js');
  assert.ok(/GUEST_WAIT_MS = 1500/.test(pay));
  assert.ok(!/setTimeout\(r, 3000\)/.test(pay));
  assert.ok(read('miniprogram/config.js').includes(GN.GUEST_TMPL_ID));
  assert.ok(/guestnotify\.js'\)\.create\(db, cloud\)\.retryPending/.test(read('cloudfunctions/warmer/index.js')));
  const t = '2026年10月28日 10:00';
  assert.deepStrictEqual(require('../cloudfunctions/payment/notify.js').buildGuest({ count: 2, amount: 1, method: 'cash' }, t), GN.buildGuest({ count: 2, amount: 1, method: 'cash' }, t));
});

test('入簿通知：可重试的失败撤销占位，warmer 补发成功后记 done；补发不重复', async () => {
  seedGuest([rec('r1')]);
  failWith(-1);
  const r = await owner({ action: 'confirm', rid: 'r1' });
  assert.strictEqual(r.code, 0, r.msg);
  let d = db.data.records[0];
  assert.strictEqual(d.guestNotifiedAt, undefined, '占位已撤销');
  assert.strictEqual(d.guestNotifyTry, 1);
  assert.ok(!d.guestNotifyDone);
  okSend();
  const n = await GN.create(db, sdk).retryPending(10);
  assert.strictEqual(n, 1);
  assert.strictEqual(sent.length, 1);
  d = db.data.records[0];
  assert.ok(d.guestNotifyDone && d.guestNotifiedAt);
  assert.strictEqual(d.guestNotifyTry, 2);
  assert.strictEqual(await GN.create(db, sdk).retryPending(10), 0);
  assert.strictEqual(sent.length, 1, '已 done 不再发');
});

test('入簿通知：43101 等确定性失败直接 done；试满 3 次不再补发', async () => {
  seedGuest([rec('r1')]);
  failWith(43101);
  await owner({ action: 'confirm', rid: 'r1' });
  assert.ok(db.data.records[0].guestNotifyDone);
  assert.strictEqual(db.data.records[0].guestNotifyErr, 43101);
  seedGuest([rec('r2', { status: 'paid', paidAt: new Date(), guestNotifyTry: 2, payerOpenid: 'g2' })]);
  failWith(-1);
  await GN.create(db, sdk).retryPending(10);
  assert.ok(db.data.records[0].guestNotifyDone, '第 3 次失败后记 done');
  assert.strictEqual(db.data.records[0].guestNotifyTry, 3);
});

test('入簿通知：占位超过 10 分钟没 done（实例中断）由 warmer 重占再发；10 分钟内的不动；旧记录（无 guestNotifyTry）不补发', async () => {
  const old = new Date(Date.now() - 11 * 60 * 1000);
  seedGuest([
    rec('s1', { status: 'paid', paidAt: new Date(), guestNotifyTry: 1, guestNotifiedAt: old }),
    rec('s2', { status: 'paid', paidAt: new Date(), guestNotifyTry: 1, guestNotifiedAt: new Date(), payerOpenid: 'g2' }),
    rec('s3', { status: 'paid', paidAt: new Date(), guestNotifiedAt: old, payerOpenid: 'g3' }),
    rec('s4', { status: 'paid', paidAt: new Date(Date.now() - 2 * DAY), guestNotifyTry: 1, payerOpenid: 'g4' })
  ]);
  const n = await GN.create(db, sdk).retryPending(10);
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(sent.map(m => m.touser), ['g1']);
  assert.ok(db.data.records.find(x => x._id === 's1').guestNotifyDone);
});

test('入簿通知：批次补发合成一条、打开宾客自己那条，整批记 done', async () => {
  const b = (id, i, amt) => rec(id, { batchId: 'B1', batchIdx: i, batchSize: 2, payerName: '甲' + i, amount: amt, status: 'paid', paidAt: new Date(), guestNotifyTry: 1 });
  seedGuest([b('a1', 1, 200), b('a0', 0, 100)]);
  await GN.create(db, sdk).retryPending(10);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].page, 'pages/receipt/receipt?rid=a0&batch=1');
  assert.strictEqual(sent[0].data.amount3.value, '300.00元');
  assert.ok(db.data.records.every(r => r.guestNotifyDone));
});

// ---- 额度补漏
const planDoc = f => [{ _id: 'plans', free: { name: '免费版', features: f }, pro: { name: '专业版', features: {} } }];
function seedAcc(maxClerks, clerks) {
  db.reset().applyUpdates = true;
  db.persist = true;
  db.seed('users', [{ openid: OWNER }, { openid: 'v1' }])
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b0', accountName: '张府', orgMode: false }])
    .seed('books', [{ _id: 'b0', ownerOpenid: OWNER, name: '礼簿', type: 'wedding' }])
    .seed('members', Array.from({ length: clerks }, (_, i) => ({ _id: 'm' + i, aid: 'acc1', ownerOpenid: OWNER, memberOpenid: 'c' + i, role: 'clerk', soloBookId: 'b0', perms: ['desk'], status: 'active' }))
      .concat([{ _id: 'mv', aid: 'acc1', ownerOpenid: OWNER, memberOpenid: 'v1', role: 'viewer', bookIds: ['b0'] }]))
    .seed('settings', planDoc({ maxClerks }))
    .seed('invites', [{ _id: 'tk1', type: 'clerk', aid: 'acc1', ownerOpenid: OWNER, fromOpenid: OWNER, used: false, uses: 0, maxUses: 1, perms: ['desk'], allBooks: false, bookIds: ['b0'], solo: true, expiresAt: new Date(Date.now() + DAY) }]);
  state.openid = 'v1';
}

test('家人共享接受主家的记账人卡升级为记账人：满额时拒绝（不升级、不占卡），未满照常升级', async () => {
  seedAcc(1, 1);
  const r = await loadFunction('account').main({ action: 'acceptInvite', token: 'tk1', displayName: '王大锤' });
  assert.notStrictEqual(r.code, 0);
  assert.ok(/最多 1 位记账人/.test(r.msg) && /联系主家/.test(r.msg), r.msg);
  assert.strictEqual(db.data.members.find(m => m._id === 'mv').role, 'viewer');
  assert.strictEqual(db.data.invites[0].uses, 0, '没占用邀请卡');
  seedAcc(2, 1);
  const ok2 = await loadFunction('account').main({ action: 'acceptInvite', token: 'tk1', displayName: '王大锤' });
  assert.strictEqual(ok2.code, 0, ok2.msg);
  assert.strictEqual(db.data.invites[0].uses, 1, '未满：占用邀请卡并升级');
});

function seedTrash(maxBooks, books, status) {
  db.reset().applyUpdates = true;
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b0', accountName: '张府' }])
    .seed('books', Array.from({ length: books }, (_, i) => ({ _id: 'b' + i, ownerOpenid: OWNER, name: '礼簿' + i, type: 'wedding' })))
    .seed('trash_books', [{ _id: 't1', ownerOpenid: OWNER, name: '旧礼簿', type: 'wedding', trashStatus: status || 'done' }])
    .seed('settings', maxBooks === null ? [] : planDoc({ maxBooks }));
  state.openid = OWNER;
}
const restore = () => loadFunction('books').main({ action: 'trashRestore', bookId: 't1' });

test('回收站恢复受礼簿数额度限制（提示带开通会员，前端弹联系我们）；未满 / 会员 / 恢复中续跑照常', async () => {
  seedTrash(null, 3); // 默认免费版 3 本
  const r = await restore();
  assert.notStrictEqual(r.code, 0);
  assert.ok(/^不能恢复：免费版最多 3 本礼簿，开通会员可添加更多/.test(r.msg), r.msg);
  assert.ok(/开通会员可添加更多/.test(r.msg), '前端 request.isQuotaMsg 据此弹「联系我们」');
  seedTrash(null, 2);
  assert.strictEqual((await restore()).code, 0);
  seedTrash(0, 5);
  assert.strictEqual((await restore()).code, 0, '会员不限');
  seedTrash(null, 3, 'restoring');
  assert.strictEqual((await restore()).code, 0, '已开始恢复的续跑不再检查');
});

// ---- 头像
const AV = n => `cloud://env.1234/avatars/${n}.jpg`;
function seedUsers(users) {
  db.reset().applyUpdates = true;
  db.seed('users', users);
}
const login = (openid, userInfo) => { state.openid = openid; return loadFunction('login').main({ userInfo }); };

test('login：头像只接受 avatars/ 下的文件；任意网址、临时路径、别人在用的文件都不存', async () => {
  seedUsers([{ _id: 'u1', openid: 'u1', nickname: 'A', avatar: '' }, { _id: 'u2', openid: 'u2', nickname: 'B', avatar: AV('bbb') }]);
  for (const bad of ['https://evil.example.com/a.png', 'http://tmp/abc.jpg', 'cloud://env.1234/paycodes/u1-1.png', AV('bbb')]) {
    const r = await login('u1', { nickname: 'A', avatar: bad });
    assert.strictEqual(r.code, 0, r.msg);
    assert.strictEqual(r.data.user.avatar, '', bad);
  }
  const ok = await login('u1', { nickname: 'A', avatar: AV('aaa') });
  assert.strictEqual(ok.code, 0);
  assert.strictEqual(ok.data.user.avatar, AV('aaa'));
});

test('login：换头像后删旧头像文件（别人也在用的不删）；没传头像保持原头像', async () => {
  const deleted = [];
  const orig = sdk.deleteFile;
  sdk.deleteFile = async o => { deleted.push(...o.fileList); return { fileList: [] }; };
  try {
    seedUsers([{ _id: 'u1', openid: 'u1', nickname: 'A', avatar: AV('old') }]);
    await login('u1', { nickname: 'A', avatar: AV('new') });
    assert.deepStrictEqual(deleted, [AV('old')]);
    const r2 = await login('u1', { nickname: 'A2' });
    assert.strictEqual(r2.data.user.avatar, AV('old'), '没传头像：不改（假库 doc.update 不落数据，返回的是原值）');
    assert.strictEqual(deleted.length, 1);
  } finally { sdk.deleteFile = orig; }
});

test('头像文件名不含 openid 片段（随机串）', () => {
  const s = read('miniprogram/utils/avatar.js');
  assert.ok(!/globalData\.openid/.test(s));
  assert.ok(/avatars\/\$\{name\}\.jpg/.test(s));
});

test('清除数据：删除本人头像文件（avatars/、无人共用），清掉同名检查频率计数', async () => {
  db.reset();
  db.seed('users', [{ openid: 'me', avatar: AV('me') }, { openid: 'x', avatar: AV('shared') }]);
  assert.deepStrictEqual(await Purge.avatarFiles(db, 'me'), [AV('me')]);
  db.reset().seed('users', [{ openid: 'me', avatar: AV('shared') }, { openid: 'x', avatar: AV('shared') }]);
  assert.deepStrictEqual(await Purge.avatarFiles(db, 'me'), [], '别人也在用：不删');
  db.reset().seed('users', [{ openid: 'me', avatar: 'https://thirdwx.qlogo.cn/a.png' }]);
  assert.deepStrictEqual(await Purge.avatarFiles(db, 'me'), []);
  const t = Purge.targets('me', {}).find(x => x[1] === 'rate_limits');
  assert.deepStrictEqual(t[2], { _id: 'nc_me' });
});
