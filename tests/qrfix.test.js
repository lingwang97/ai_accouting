// v3.58.1 小票二维码修复：缓存按版本、打印权限、认领人不能看整批、主通道缺权限时跳过、前端熔断、回执页主家判断
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { sdk, db, state, loadFunction } = require('./helpers/sdk-stub.js');

const PAY_DIR = path.join(__dirname, '../cloudfunctions/payment');
let deps = null;
try { deps = { PNG: require(require.resolve('pngjs', { paths: [PAY_DIR] })).PNG }; } catch (e) { deps = null; }
const t = (name, fn) => test(name, async () => (deps ? fn() : 'SKIP 未安装 pngjs'));

const OWNER = 'o-owner', SHOW = 'u-show', NOPRINT = 'u-noprint', G1 = 'g-1';
const TOKEN = 'AbCdEfGhIj12';
const origCallFn = sdk.callFunction;

/** 280×280 白底黑色圆环（像小程序码，黑点比例在有效范围内） */
function codePng() {
  const size = 280;
  const png = new deps.PNG({ width: size, height: size });
  png.data.fill(255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot(x - 140, y - 140);
    if ((r > 100 && r < 130) || r < 40) { const i = (y * size + x) * 4; png.data[i] = png.data[i + 1] = png.data[i + 2] = 0; }
  }
  return deps.PNG.sync.write(png);
}

function seed(extra = {}, more = []) {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '李府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }, { openid: SHOW, currentAid: 'acc1' }, { openid: NOPRINT, currentAid: 'acc1' }])
    .seed('members', [
      { _id: 'm1', aid: 'acc1', memberOpenid: SHOW, role: 'clerk', bookIds: ['b1'], perms: ['show'] },
      { _id: 'm2', aid: 'acc1', memberOpenid: NOPRINT, role: 'clerk', bookIds: ['b1'], perms: ['export'] }
    ])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, type: 'wedding' }])
    .seed('records', [{ _id: 'r1', aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', status: 'paid', payerName: '张三', amount: 100, payerOpenid: '', paidAt: new Date(), createdAt: new Date(), ...extra }].concat(more));
  db.applyUpdates = true;
  state.uploads.length = 0;
  state.download = async fileID => { const u = state.uploads.find(x => 'cloud://test/' + x.cloudPath === fileID); if (!u) throw new Error('not found'); return u.content; };
  sdk.callFunction = origCallFn;
}
const pay = (openid, event) => { state.openid = openid; return loadFunction('payment').main(event); };
const rec = () => db.data.records.find(r => r._id === 'r1');

t('缓存按版本：体验版生成的码不会被正式版补打复用；换版本重新生成并删掉旧文件；同版本仍命中缓存', async () => {
  seed({ rcptToken: TOKEN });
  const seen = [];
  sdk.openapi.wxacode = { getUnlimited: async o => { seen.push(o.envVersion); return { buffer: codePng() }; } };
  const deleted = [];
  const origDel = sdk.deleteFile;
  sdk.deleteFile = async o => { deleted.push(...o.fileList); return { fileList: [] }; };
  try {
    await pay(OWNER, { action: 'issueQr', rid: 'r1', envVersion: 'trial' });
    assert.strictEqual(rec().rcptQrKey, TOKEN + ':w280v1:trial');
    const trialFile = rec().rcptQrFileID;
    assert.ok(/-trial\.bin$/.test(trialFile));
    await pay(OWNER, { action: 'issueQr', rid: 'r1', envVersion: 'release' });
    assert.deepStrictEqual(seen, ['trial', 'release']); // 正式版重新生成
    assert.strictEqual(rec().rcptQrKey, TOKEN + ':w280v1:release');
    assert.deepStrictEqual(deleted, [trialFile]);
    await pay(OWNER, { action: 'issueQr', rid: 'r1' }); // 不传按正式版：命中缓存
    assert.strictEqual(seen.length, 2);
    // 旧版本缓存键（不带版本）一律视为未命中
    seed({ rcptToken: TOKEN, rcptQrKey: TOKEN + ':w280v1', rcptQrFileID: 'cloud://test/rcptqr/r1-old.bin' });
    seen.length = 0;
    await pay(OWNER, { action: 'issueQr', rid: 'r1' });
    assert.strictEqual(seen.length, 1);
  } finally { sdk.deleteFile = origDel; }
});

t('打印权限：只有「礼簿码与打印」的记账人也能取小程序码；没有打印相关权限的被拒且提示权限名', async () => {
  seed({ rcptToken: TOKEN });
  sdk.openapi.wxacode = { getUnlimited: async () => ({ buffer: codePng() }) };
  const r = await pay(SHOW, { action: 'issueQr', rid: 'r1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(r.data.raster);
  const r2 = await pay(NOPRINT, { action: 'issueQr', rid: 'r1' });
  assert.notStrictEqual(r2.code, 0);
  assert.ok(r2.msg.includes('礼簿码与打印') && !r2.msg.includes('undefined'));
});

t('主通道缺权限（-604101）：同一实例 10 分钟内直接走备用通道；设置页检测仍两路都试', async () => {
  seed({ rcptToken: TOKEN });
  let api = 0;
  const calls = [];
  sdk.openapi.wxacode = { getUnlimited: async () => { api++; const e = new Error('no permission'); e.errCode = -604101; throw e; } };
  sdk.callFunction = async o => { calls.push(o); return { result: { code: 0, data: { image: codePng().toString('base64') } } }; };
  state.openid = OWNER;
  const m = loadFunction('payment'); // 同一实例
  assert.ok((await m.main({ action: 'issueQr', rid: 'r1', envVersion: 'trial' })).data.raster);
  assert.ok((await m.main({ action: 'issueQr', rid: 'r1', envVersion: 'develop' })).data.raster);
  assert.strictEqual(api, 1); // 第二次跳过主通道
  assert.strictEqual(calls.length, 2);
  await m.main({ action: 'qrCheck' });
  assert.strictEqual(api, 2); // 检测始终试主通道
});

test('认领人：可看自己那一笔，但 batch:true 不能看到同批其他人；扫码宾客本人与主家可看整批', async () => {
  const batch = { batchId: 'B1', batchSize: 2 };
  seed({ rcptToken: TOKEN, claimedOpenid: G1, batchIdx: 0, ...batch },
    [{ _id: 'r2', aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', status: 'paid', payerName: '李四', amount: 300, payerOpenid: '', paidAt: new Date(), createdAt: new Date(), batchIdx: 1, ...batch }]);
  const mine = await pay(G1, { action: 'receipt', rid: 'r1', batch: true });
  assert.strictEqual(mine.code, 0);
  assert.strictEqual(mine.data.record.payerName, '张三');
  assert.strictEqual(mine.data.record.amount, 100);
  assert.ok(!mine.data.record.batchItems);
  assert.ok(!JSON.stringify(mine).includes('李四'));
  const host = await pay(OWNER, { action: 'receipt', rid: 'r1', batch: true });
  assert.strictEqual(host.data.record.batchItems.length, 2);
  // 扫码登记这一批的宾客本人
  db.data.records.forEach(r => { r.payerOpenid = 'g-payer'; r.claimedOpenid = ''; });
  const payer = await pay('g-payer', { action: 'receipt', rid: 'r1', batch: true });
  assert.strictEqual(payer.data.record.batchItems.length, 2);
});

// —— 前端熔断 ——
const request = require('../miniprogram/utils/request.js');
const printer = require('../miniprogram/utils/printer.js');

test('前端熔断：配置类失败后 30 分钟内不再请求；偶发失败连续 2 次才跳过 5 分钟；单笔被拒不计入；检测成功可清除', async () => {
  const orig = request.issueQr;
  let n = 0;
  let reply = async () => ({ raster: '', reason: 'openapi:-604101,system:secret-missing' });
  request.issueQr = (...a) => { n++; return reply(...a); };
  try {
    printer.resetQrBreaker();
    const T = 1e12;
    assert.strictEqual(await printer._qrBytes({ _id: 'r1' }, T), null);
    assert.strictEqual(await printer._qrBytes({ _id: 'r2' }, T + 1000), null);
    assert.strictEqual(n, 1); // 第二张直接跳过
    assert.strictEqual(await printer._qrBytes({ _id: 'r3' }, T + 31 * 60 * 1000), null);
    assert.strictEqual(n, 2); // 30 分钟后再试
    printer.resetQrBreaker();
    n = 0;
    reply = async () => { throw new Error('入簿后才有二维码'); }; // 单笔被拒（request.js 抛的业务错误）
    for (let i = 0; i < 3; i++) await printer._qrBytes({ _id: 'x' }, T);
    assert.strictEqual(n, 3);
    n = 0;
    reply = async () => { throw { errMsg: 'cloud.callFunction:fail timeout' }; }; // 偶发
    await printer._qrBytes({ _id: 'a' }, T);
    await printer._qrBytes({ _id: 'b' }, T);
    await printer._qrBytes({ _id: 'c' }, T + 1000);
    assert.strictEqual(n, 2); // 连续 2 次后跳过
    await printer._qrBytes({ _id: 'd' }, T + 6 * 60 * 1000);
    assert.strictEqual(n, 3);
    printer.resetQrBreaker();
    n = 0;
    reply = async () => ({ raster: Buffer.from([0x1d, 0x76, 0x30, 0]).toString('base64') });
    assert.ok(await printer._qrBytes({ _id: 'ok' }, T));
    assert.strictEqual(n, 1);
  } finally {
    request.issueQr = orig;
    printer.resetQrBreaker();
  }
});

test('回执页：扫码冷启动时以服务端 claim=staff 判断主家 / 记账人（不显示「我家也要办事」）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/receipt/receipt.js'), 'utf8');
  assert.ok(/isHost: this\.data\.isHost \|\| claim === 'staff'/.test(src));
});

// —— v3.59.1：缓存文件清理、一次性凭据清理、personRef 范围 ——
const SHARED = path.join(__dirname, '../tools/cloud-shared');

test('回收站彻底删除：一并删除这本礼金记录的小票二维码缓存文件（含 50 个一批）', async () => {
  const trash = require(path.join(SHARED, 'trash.js'));
  const rows = Array.from({ length: 60 }, (_, i) => ({ _id: 'r' + i, ownerOpenid: OWNER, bookId: 'b1', rcptQrFileID: i % 2 ? 'cloud://x/rcptqr/r' + i + '.bin' : '' }));
  db.reset().seed('trash_records', rows.concat([{ _id: 'o1', ownerOpenid: OWNER, bookId: 'b2', rcptQrFileID: 'cloud://x/other.bin' }]));
  const deleted = [];
  const cloud = { deleteFile: async o => { assert.ok(o.fileList.length <= 50); deleted.push(...o.fileList); return { fileList: [] }; } };
  await trash.purge(db, cloud, { _id: 'b1', ownerOpenid: OWNER, files: ['cloud://x/archive.pdf'] });
  assert.strictEqual(deleted.length, 31);
  assert.ok(deleted.includes('cloud://x/archive.pdf') && deleted.includes('cloud://x/rcptqr/r1.bin'));
  assert.ok(!deleted.includes('cloud://x/other.bin'));
});

test('清除账户数据：回收站里的礼金记录的二维码缓存也删除', async () => {
  const purge = require(path.join(SHARED, 'purge.js'));
  db.reset()
    .seed('records', [{ _id: 'r1', ownerOpenid: OWNER, rcptQrFileID: 'cloud://x/a.bin' }])
    .seed('trash_records', [{ _id: 't1', ownerOpenid: OWNER, rcptQrFileID: 'cloud://x/b.bin' }, { _id: 't2', ownerOpenid: 'other', rcptQrFileID: 'cloud://x/c.bin' }]);
  const deleted = [];
  await purge.run(db, { deleteFile: async o => { deleted.push(...o.fileList); return { fileList: [] }; } }, OWNER, {});
  assert.ok(deleted.includes('cloud://x/a.bin') && deleted.includes('cloud://x/b.bin'));
  assert.ok(!deleted.includes('cloud://x/c.bin'));
});

test('管理员按礼簿清除：删除这本礼簿记录的二维码缓存文件', async () => {
  const ADMIN = 'o-admin';
  db.reset()
    .seed('settings', [{ _id: 'admins', openids: [ADMIN] }])
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '婚宴' }])
    .seed('records', [{ _id: 'r1', ownerOpenid: OWNER, bookId: 'b1', rcptQrFileID: 'cloud://x/a.bin' }, { _id: 'r2', ownerOpenid: OWNER, bookId: 'b9', rcptQrFileID: 'cloud://x/z.bin' }]);
  const deleted = [];
  const origDel = sdk.deleteFile;
  sdk.deleteFile = async o => { deleted.push(...o.fileList); return { fileList: [] }; };
  try {
    state.openid = ADMIN;
    const r = await loadFunction('system').main({ action: 'adminPurgeBook', bookId: 'b1', confirmName: '婚宴' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(deleted.includes('cloud://x/a.bin') && !deleted.includes('cloud://x/z.bin'));
  } finally { sdk.deleteFile = origDel; }
});

test('warmer：清理 10 分钟前的小程序码一次性凭据（按 kind + createdAt，不碰其他设置）', async () => {
  db.reset();
  const seen = [];
  const origCol = db.collection.bind(db);
  db.collection = name => { const c = origCol(name); const w = c.where; c.where = cond => { seen.push({ name, cond }); return w(cond); }; return c; };
  try {
    state.openid = '';
    await loadFunction('warmer')._test.cleanNonces();
    const q = seen.find(s => s.name === 'settings');
    assert.strictEqual(q.cond.kind, 'urllink');
    assert.strictEqual(q.cond.createdAt.__op, 'lt');
    assert.ok(Date.now() - q.cond.createdAt.v >= 10 * 60 * 1000 - 1000);
  } finally { db.collection = origCol; }
});

test('礼台记账 personRef：只认负责礼簿内的记录；负责范围外的记录 id 不能借来归并往来人', async () => {
  const CLERK1 = 'u-desk';
  const base = (id, bookId) => ({ _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId, status: 'paid', payerName: '王五', amount: 100, payerOpenid: 'g-wang', personKey: 'h:wang', nameTag: '李村' });
  const run = async ref => {
    db.reset()
      .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '李府', activeBookId: 'b1', orgMode: true }])
      .seed('users', [{ openid: CLERK1, currentAid: 'acc1' }])
      .seed('members', [{ _id: 'm1', aid: 'acc1', memberOpenid: CLERK1, role: 'clerk', bookIds: ['b1'], perms: ['desk'] }])
      .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, type: 'wedding', name: '婚宴' }, { _id: 'b2', ownerOpenid: OWNER, type: 'birthday', name: '寿宴' }])
      .seed('records', [base('in1', 'b1'), base('out1', 'b2')]);
    const added = [];
    const origCol = db.collection.bind(db);
    db.collection = name => { const c = origCol(name); if (name === 'records') c.add = async o => { added.push(o.data); return { _id: 'new' + added.length }; }; return c; };
    try {
      state.openid = CLERK1;
      const r = await loadFunction('payment').main({ action: 'cashEntry', payerName: '王五', amount: 200, personRef: ref, bookId: 'b1' });
      assert.strictEqual(r.code, 0, r.msg);
      return added[0];
    } finally { db.collection = origCol; }
  };
  const inScope = await run('in1');
  assert.strictEqual(inScope.personKey, 'h:wang');
  const outScope = await run('out1');
  assert.strictEqual(outScope.personKey, undefined);
  assert.strictEqual(outScope.nameTag, undefined);
});
