// 小票二维码与认领（v3.57.0；小程序码生成见 wxacode.test.js）：token 生成 / 复用、不进列表接口、认领条件与先到先得、myReceipts 的 _.or、重置后旧 token 失效、二维码字节
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { sdk, db, state, loadFunction } = require('./helpers/sdk-stub.js');

const OWNER = 'o-owner', CLERK = 'u-clerk', G1 = 'g-1', G2 = 'g-2', G3 = 'g-3';
const TOKEN = 'AbCdEfGhIj12';

function seed(extra = {}) {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '李府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }, { openid: CLERK, currentAid: 'acc1' }])
    .seed('members', [{ _id: 'm1', aid: 'acc1', memberOpenid: CLERK, role: 'clerk', bookIds: ['b1'], perms: ['confirm', 'desk', 'members'] }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, type: 'wedding' }])
    .seed('records', [{
      _id: 'r1', aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', status: 'paid', payerName: '张三', amount: 100,
      payerOpenid: '', payMethod: 'cash', paidAt: new Date(), createdAt: new Date(), ...extra
    }]);
  db.applyUpdates = true;
  state.calls.length = 0;
}
const pay = (openid, event) => { state.openid = openid; return loadFunction('payment').main(event); };
const rec = () => db.data.records.find(r => r._id === 'r1');

test('token / 认领人不出现在 payment 与 records 的列表接口里，只给 claimed 标记', async () => {
  seed({ rcptToken: TOKEN, claimedOpenid: G1 });
  state.openid = OWNER;
  const list = await loadFunction('records').main({ action: 'list' });
  assert.strictEqual(list.code, 0, list.msg);
  const text = JSON.stringify(list);
  assert.ok(!text.includes(TOKEN) && !text.includes(G1) && !text.includes('rcptToken') && !text.includes('claimedOpenid'));
  assert.strictEqual(list.data.list[0].claimed, true);
  // 回执接口（receipt / receiptByToken）也不带 token 与 openid
  const rc = await pay(OWNER, { action: 'receipt', rid: 'r1' });
  assert.ok(!JSON.stringify(rc).includes(TOKEN) && !JSON.stringify(rc).includes(G1));
});

test('claimReceipt：先到先得，条件含 payerOpenid / claimedOpenid 为空，不改 payerOpenid', async () => {
  seed({ rcptToken: TOKEN });
  const a = await pay(G1, { action: 'claimReceipt', token: TOKEN });
  assert.strictEqual(a.code, 0, a.msg);
  assert.strictEqual(rec().claimedOpenid, G1);
  assert.strictEqual(rec().payerOpenid, '');
  const b = await pay(G2, { action: 'claimReceipt', token: TOKEN });
  assert.notStrictEqual(b.code, 0);
  assert.strictEqual(rec().claimedOpenid, G1); // 没被抢走
  // 本人重复认领幂等
  assert.strictEqual((await pay(G1, { action: 'claimReceipt', token: TOKEN })).code, 0);
  // 更新条件：_id + token + 状态，且 payerOpenid / claimedOpenid 两个 or（空串或不存在）
  const up = db.log.filter(l => l.op === 'update' && l.data && l.data.claimedOpenid === G1)[0];
  assert.strictEqual(up.cond.__op, 'and');
  const ors = up.cond.v.filter(c => c.__op === 'or');
  assert.strictEqual(ors.length, 2);
  assert.deepStrictEqual(ors.map(o => Object.keys(o.v[0])[0]), ['payerOpenid', 'claimedOpenid']);
  assert.strictEqual(up.cond.v[0].rcptToken, TOKEN);
});

test('claimReceipt：扫码宾客自己的记录（有 payerOpenid）不能被别人认领；主家 / 记账人不需要认领', async () => {
  seed({ rcptToken: TOKEN, payerOpenid: G1 });
  assert.notStrictEqual((await pay(G2, { action: 'claimReceipt', token: TOKEN })).code, 0);
  assert.strictEqual(rec().claimedOpenid, undefined);
  seed({ rcptToken: TOKEN });
  assert.notStrictEqual((await pay(OWNER, { action: 'claimReceipt', token: TOKEN })).code, 0);
  assert.notStrictEqual((await pay(CLERK, { action: 'claimReceipt', token: TOKEN })).code, 0);
  assert.strictEqual(rec().claimedOpenid, undefined);
});

test('receiptByToken：已登录即可查看这一笔，claim 状态正确，不外露 aid / bookId；无效 token 不查库', async () => {
  seed({ rcptToken: TOKEN });
  const open = await pay(G1, { action: 'receiptByToken', token: TOKEN });
  assert.strictEqual(open.code, 0, open.msg);
  assert.strictEqual(open.data.claim, 'open');
  assert.strictEqual(open.data.record.payerName, '张三');
  assert.strictEqual(open.data.record.aid, undefined);
  assert.strictEqual(open.data.record.bookId, undefined);
  assert.strictEqual(open.data.accountName, '李府');
  assert.strictEqual((await pay(OWNER, { action: 'receiptByToken', token: TOKEN })).data.claim, 'staff');
  await pay(G1, { action: 'claimReceipt', token: TOKEN });
  assert.strictEqual((await pay(G1, { action: 'receiptByToken', token: TOKEN })).data.claim, 'mine');
  assert.strictEqual((await pay(G2, { action: 'receiptByToken', token: TOKEN })).data.claim, 'taken');
  db.log.length = 0;
  const bad = await pay(G1, { action: 'receiptByToken', token: "x' || 1" });
  assert.notStrictEqual(bad.code, 0);
  assert.strictEqual(db.log.filter(l => l.col === 'records' && l.op === 'get').length, 0);
  seed({ rcptToken: TOKEN, status: 'transferred' });
  assert.notStrictEqual((await pay(G1, { action: 'receiptByToken', token: TOKEN })).code, 0);
});

test('认领后可用记录 id 查看回执；myReceipts 用同一个 where 里的 _.or 取 payerOpenid / claimedOpenid', async () => {
  seed({ rcptToken: TOKEN, claimedOpenid: G1 });
  assert.strictEqual((await pay(G1, { action: 'receipt', rid: 'r1' })).code, 0);
  assert.notStrictEqual((await pay(G2, { action: 'receipt', rid: 'r1' })).code, 0);
  db.log.length = 0;
  const my = await pay(G1, { action: 'myReceipts' });
  assert.strictEqual(my.code, 0);
  assert.strictEqual(my.data.list.length, 1);
  const q = db.log.filter(l => l.op === 'get' && l.col === 'records')[0];
  assert.strictEqual(q.cond.__op, 'and');
  const or = q.cond.v.find(c => c.__op === 'or');
  assert.deepStrictEqual(or.v.map(c => Object.keys(c)[0]).sort(), ['claimedOpenid', 'payerOpenid']);
  assert.strictEqual((await pay(G3, { action: 'myReceipts' })).data.list.length, 0);
});

test('resetToken：主家本人重置后旧 token 立即失效、新 token 有效，认领关系保留；记账人不能重置', async () => {
  seed({ rcptToken: TOKEN, claimedOpenid: G1 });
  assert.notStrictEqual((await pay(CLERK, { action: 'resetToken', rid: 'r1' })).code, 0);
  assert.strictEqual(rec().rcptToken, TOKEN);
  assert.strictEqual((await pay(OWNER, { action: 'resetToken', rid: 'r1' })).code, 0);
  const fresh = rec().rcptToken;
  assert.notStrictEqual(fresh, TOKEN);
  assert.ok(/^[0-9A-Za-z]{12}$/.test(fresh));
  assert.notStrictEqual((await pay(G2, { action: 'receiptByToken', token: TOKEN })).code, 0);
  assert.notStrictEqual((await pay(G2, { action: 'claimReceipt', token: TOKEN })).code, 0);
  assert.strictEqual((await pay(G2, { action: 'receiptByToken', token: fresh })).code, 0);
  assert.strictEqual(rec().claimedOpenid, G1);
});

test('unclaim：只有主家本人；解除后可被重新认领', async () => {
  seed({ rcptToken: TOKEN, claimedOpenid: G1 });
  assert.notStrictEqual((await pay(CLERK, { action: 'unclaim', rid: 'r1' })).code, 0);
  assert.notStrictEqual((await pay(G2, { action: 'unclaim', rid: 'r1' })).code, 0);
  assert.strictEqual((await pay(OWNER, { action: 'unclaim', rid: 'r1' })).code, 0);
  assert.strictEqual(rec().claimedOpenid, '');
  assert.strictEqual((await pay(G2, { action: 'claimReceipt', token: TOKEN })).code, 0);
  assert.strictEqual(rec().claimedOpenid, G2);
});

test('带 _openid 的伪造记录不能凭 token 读取或认领', async () => {
  seed({ rcptToken: TOKEN, _openid: 'attacker' });
  assert.notStrictEqual((await pay(G1, { action: 'receiptByToken', token: TOKEN })).code, 0);
  assert.notStrictEqual((await pay(G1, { action: 'claimReceipt', token: TOKEN })).code, 0);
});

// —— 二维码字节 ——
const qrprint = require('../miniprogram/utils/qrprint.js');
const escpos = require('../miniprogram/utils/escpos.js');
const URL = 'https://wxaurl.cn/AbCdEfGhIjK12';

test('qrprint：原生指令序列完整（模型 / 大小 / 纠错 / 存数据 / 打印），数据长度正确', () => {
  const b = qrprint.nativeBytes(URL, 6);
  const dataLen = URL.length + 3;
  const store = [0x1d, 0x28, 0x6b, dataLen & 0xff, dataLen >> 8, 0x31, 0x50, 0x30];
  const s = Buffer.from(b).toString('latin1');
  assert.ok(s.includes(Buffer.from(store).toString('latin1') + URL));
  assert.deepStrictEqual(b.slice(-8), [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);
  assert.strictEqual(qrprint.nativeBytes('中文', 6), null); // 只接受可打印 ASCII
});

test('qrprint：图片方式输出 GS v 0 光栅，尺寸放得进 58mm（384 点），超宽返回 null', () => {
  const b = qrprint.rasterBytes(URL, 5, 384);
  assert.deepStrictEqual(b.slice(0, 4), [0x1d, 0x76, 0x30, 0x00]);
  const wBytes = b[4] + b[5] * 256, h = b[6] + b[7] * 256;
  assert.ok(h * 1 <= 384);
  assert.strictEqual(b.length, 8 + wBytes * h);
  assert.strictEqual(qrprint.rasterBytes(URL, 20, 384), null);
  const a = qrprint.qrBytes(URL, 'image', 32), c = qrprint.qrBytes(URL, 'native', 32);
  assert.ok(a.length > 1000 && c.length < 200);
});

test('escpos：二维码默认关（v3.59.0，任何事由未设置都不打），模板明确打开才打；提示文字', () => {
  assert.strictEqual(escpos.qrOn({}, 'wedding'), false);
  assert.strictEqual(escpos.qrOn({}, 'funeral'), false);
  assert.strictEqual(escpos.qrOn(null), false);
  assert.strictEqual(escpos.qrOn({ qr: true }, 'funeral'), true);
  assert.strictEqual(escpos.qrOn({ qr: true }), true);
  assert.strictEqual(escpos.qrOn({ qr: false }, 'wedding'), false);
  const ps = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/printset/printset.js'), 'utf8');
  assert.ok(ps.includes('qr: tpl.qr === true')); // 设置页开关同样默认关
  const gbk = require('../miniprogram/utils/gbk.js');
  const has = (buf, str) => Buffer.from(buf).toString('latin1').includes(Buffer.from(gbk.encode(str)).toString('latin1'));
  const qr = qrprint.nativeBytes(URL, 6);
  const w = Array.from(new Uint8Array(escpos.buildReceipt({ _id: 'x', payerName: 'a', amount: 1, bookType: 'wedding' }, { fields: ['amount'], promo: false }, { qr })));
  const f = Array.from(new Uint8Array(escpos.buildReceipt({ _id: 'x', payerName: 'a', amount: 1, bookType: 'funeral' }, { fields: ['amount'], promo: false }, { qr })));
  assert.ok(has(w, '扫码查看电子回执') && !has(f, '扫码查看电子回执') && has(f, '扫码查看回执'));
  const none = Array.from(new Uint8Array(escpos.buildReceipt({ _id: 'x', payerName: 'a', amount: 1 }, { fields: ['amount'], promo: false })));
  assert.ok(!has(none, '扫码查看'));
});
