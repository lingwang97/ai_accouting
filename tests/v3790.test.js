// v3.79.0：传统礼簿封面照片（books.coverPhoto）与封面纹样（pdfTheme.deco）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const { ownCover } = require('../tools/cloud-shared/paycode.js');
const trash = require('../tools/cloud-shared/trash.js');
const themes = require('../cloudfunctions/export/themes.js');
const pt = require('../miniprogram/pages/booktheme/pdftheme.js');
const imgc = require('../miniprogram/utils/imgcompress.js');

const OWNER = 'o-owner';
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
const FID = n => `cloud://env.b/covers/book-${OWNER}-${n}.jpg`;
const quiet = async fn => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

// ---------- themes：纹样 ----------
test('纹样：sanitizeDeco 白名单（喜事 / 白事各自一套），非法值回落按事由默认', () => {
  assert.strictEqual(themes.sanitizeDeco('lotus', false), 'lotus');
  assert.strictEqual(themes.sanitizeDeco('pine', false), '', '喜事不能用白事纹样');
  assert.strictEqual(themes.sanitizeDeco('xi', true), '', '白事不能用喜事纹样');
  assert.strictEqual(themes.sanitizeDeco('chrys', true), 'chrys');
  assert.strictEqual(themes.sanitizeDeco('none', true), 'none');
  assert.strictEqual(themes.sanitizeDeco(undefined, false), '');
  assert.strictEqual(themes.sanitizeDeco('<script>', false), '');
});

test('纹样：decoOf 按事由默认，none 不画，白事默认无', () => {
  assert.strictEqual(themes.decoOf('', 'wedding'), 'shuangxi'); // v3.83.0 喜事默认改为囍字
  assert.strictEqual(themes.decoOf('', 'birthday'), 'shou');
  assert.strictEqual(themes.decoOf('', 'baby'), 'kids');
  assert.strictEqual(themes.decoOf('', 'house'), 'fangsheng');
  assert.strictEqual(themes.decoOf('', 'other'), 'band_huiwen');
  assert.strictEqual(themes.decoOf('', 'unknown'), 'band_huiwen');
  assert.strictEqual(themes.decoOf('', 'funeral'), '');
  assert.strictEqual(themes.decoOf('none', 'wedding'), '');
  assert.strictEqual(themes.decoOf('pine', 'funeral'), 'pine');
  assert.strictEqual(themes.decoOf('xi', 'funeral'), '', '白事传喜事纹样 -> 默认（无）');
  assert.strictEqual(themes.decoOf('pine', 'wedding'), 'shuangxi', '喜事传白事纹样 -> 按事由默认');
});

test('纹样：前端清单与云函数一致（DECOS / FUNERAL_DECOS / DECO_DEFAULTS / decoOf / 形状）', () => {
  assert.deepStrictEqual(pt.DECOS.map(x => x.k), themes.DECOS);
  assert.deepStrictEqual(pt.FUNERAL_DECOS.map(x => x.k), themes.FUNERAL_DECOS);
  assert.deepStrictEqual(pt.DECO_DEFAULTS, themes.DECO_DEFAULTS);
  assert.deepStrictEqual(pt.COVER_SHAPES.map(x => x.k), themes.PHOTO_SHAPES);
  ['wedding', 'birthday', 'baby', 'house', 'funeral', 'other', 'x'].forEach(ty => {
    [...themes.DECOS, ...themes.FUNERAL_DECOS, 'bad'].forEach(k => assert.strictEqual(pt.decoOf(k, ty), themes.decoOf(k, ty), ty + '/' + k));
  });
  // 每个非空非 none 的纹样，示意图都有字符或带状
  themes.DECOS.concat(themes.FUNERAL_DECOS).filter(k => k && k !== 'none').forEach(k => assert.ok(pt.DECO_TXT[k] || pt.DECO_BAND[k], k));
  assert.strictEqual(themes.sanitizeShape('oval'), 'oval');
  assert.strictEqual(themes.sanitizeShape('x'), 'rect');
});

// ---------- 归属 / 清理 ----------
test('ownCover：只认本人 covers/ 下 book-{openid}-{时间}.jpg/png；别人的、别的目录的、带路径穿越的都拒绝', () => {
  assert.ok(ownCover(FID(123), OWNER));
  assert.ok(ownCover(`cloud://env.b/covers/book-${OWNER}-9.PNG`, OWNER));
  assert.ok(!ownCover(FID(123), 'o-other'));
  assert.ok(!ownCover(`cloud://env.b/paycodes/book-${OWNER}-1.png`, OWNER));
  assert.ok(!ownCover(`cloud://env.b/covers/../paycodes/book-${OWNER}-1.png`, OWNER));
  assert.ok(!ownCover(`cloud://env.b/covers/book-${OWNER}-1.gif`, OWNER));
  assert.ok(!ownCover('', OWNER) && !ownCover(FID(1), ''));
});

test('回收站 filesOf / 清除测试数据 fileIds：封面照片一并登记', async () => {
  const ownPay = () => false;
  const f = trash.filesOf({ _id: 'b1', ownerOpenid: OWNER, coverPhoto: { fileID: FID(5), shape: 'rect' } }, null, ownPay);
  assert.ok(f.includes(FID(5)));
  const g = trash.filesOf({ _id: 'b1', ownerOpenid: OWNER, coverPhoto: { fileID: 'cloud://env.b/paycodes/x.png' } }, null, ownPay);
  assert.ok(!g.includes('cloud://env.b/paycodes/x.png'), '只删 covers/ 下的文件');
  assert.deepStrictEqual(trash.filesOf({ _id: 'b1', ownerOpenid: OWNER }, null, ownPay), []);
  db.reset().seed('accounts', [{ _id: 'a1', ownerOpenid: OWNER }]).seed('books', [
    { _id: 'b1', ownerOpenid: OWNER, coverPhoto: { fileID: FID(7), shape: 'oval' } },
    { _id: 'b2', ownerOpenid: OWNER, coverPhoto: { fileID: FID(8) }, _openid: 'forged' }
  ]);
  const ids = await purgeFileIds();
  assert.ok(ids.includes(FID(7)));
  assert.ok(!ids.includes(FID(8)), '带 _openid 的伪造文档忽略');
});
async function purgeFileIds() {
  // purge.fileIds 未导出：用 preview 之外的 run 路径不便，直接调用 account 云函数里的同源模块
  const m = require('../cloudfunctions/account/purge.js');
  const rows = [];
  const cloud = { deleteFile: async o => { o.fileList.forEach(x => rows.push(x)); return { fileList: o.fileList.map(() => ({ status: 0 })) }; } };
  await m.run(db, cloud, OWNER, {}).catch(() => {});
  return rows;
}

// ---------- books：setCoverPhoto / coverPhotoUrl / list ----------
function seedBooks(opts = {}) {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '主家', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }, { openid: 'u-clerk', currentAid: 'acc1' }, { openid: 'u-clerk2', currentAid: 'acc1' }])
    .seed('members', [
      { _id: 'm1', aid: 'acc1', memberOpenid: 'u-clerk', role: 'clerk', allBooks: true, perms: ['confirm'] },
      { _id: 'm2', aid: 'acc1', memberOpenid: 'u-clerk2', role: 'clerk', allBooks: true, perms: ['books'] }
    ])
    .seed('books', [
      { _id: 'b1', ownerOpenid: OWNER, name: '婚礼', type: 'wedding', statReady: true, statCount: 0, statFen: 0, createdAt: new Date(), ...(opts.b1 || {}) },
      { _id: 'bf', ownerOpenid: OWNER, name: '白事', type: 'funeral', statReady: true, statCount: 0, statFen: 0, createdAt: new Date() }
    ]);
  if (opts.plan) db.seed('settings', [{ _id: 'plans', free: { name: '免费版', features: opts.plan } }]);
}

/** 加载 books：记录 doc().update 与 deleteFile（假库的 doc().update 默认不记录） */
function loadBooks(downloadBuf) {
  const log = { updates: [], deleted: [] };
  const origCol = db.collection.bind(db);
  db.collection = name => {
    const c = origCol(name);
    const od = c.doc;
    c.doc = id => { const d = od(id); d.update = async o => { log.updates.push({ name, id, data: o.data }); return { stats: { updated: 1 } }; }; return d; };
    return c;
  };
  const origDel = sdk.deleteFile, origTmp = sdk.getTempFileURL;
  sdk.deleteFile = async o => { log.deleted.push(...o.fileList); return { fileList: o.fileList.map(() => ({ status: 0 })) }; };
  sdk.getTempFileURL = async o => ({ fileList: o.fileList.map(f => ({ fileID: f, status: 0, tempFileURL: 'https://tmp.example/' + f.split('/').pop() })) });
  sdk.openapi = { security: { imgSecCheck: async () => ({}) } };
  state.download = async () => downloadBuf === undefined ? JPG : downloadBuf;
  const fn = loadFunction('books');
  log.restore = () => { db.collection = origCol; sdk.deleteFile = origDel; sdk.getTempFileURL = origTmp; sdk.openapi = {}; };
  return { fn, log };
}
const call = async (loaded, openid, body) => { state.openid = openid; return quiet(() => loaded.fn.main(body)); };

test('setCoverPhoto：主家设置照片成功，保存 coverPhoto={fileID,shape}，更换时删旧文件，移除时删文件', async () => {
  seedBooks();
  const L = loadBooks();
  try {
    let r = await call(L, OWNER, { action: 'setCoverPhoto', bookId: 'b1', fileID: FID(1), shape: 'oval' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(r.data.coverPhoto, { shape: 'oval', layout: 'left', scrim: 'gradient', crop: { x: 0.5, y: 0.5, z: 1 } }, '返回不带 fileID，带展示设置');
    let u = L.log.updates.find(x => x.name === 'books' && x.id === 'b1');
    assert.deepStrictEqual(u.data.coverPhoto.v, { fileID: FID(1), shape: 'oval' });
    assert.strictEqual(u.data.coverPhoto.__op, 'set');
    assert.deepStrictEqual(L.log.deleted, [], '首次设置不删文件');
    // 更换：旧文件删除
    db.data.books[0].coverPhoto = { fileID: FID(1), shape: 'oval' };
    L.log.updates.length = 0;
    r = await call(L, OWNER, { action: 'setCoverPhoto', bookId: 'b1', fileID: FID(2), shape: 'rect' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(L.log.deleted, [FID(1)]);
    // 只改形状（不传 fileID）：不删文件
    L.log.deleted.length = 0; L.log.updates.length = 0;
    db.data.books[0].coverPhoto = { fileID: FID(2), shape: 'rect' };
    r = await call(L, OWNER, { action: 'setCoverPhoto', bookId: 'b1', shape: 'oval' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(L.log.updates[0].data.coverPhoto.v, { fileID: FID(2), shape: 'oval' });
    assert.deepStrictEqual(L.log.deleted, []);
    // 移除
    L.log.updates.length = 0;
    r = await call(L, OWNER, { action: 'setCoverPhoto', bookId: 'b1', fileID: '' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.strictEqual(L.log.updates[0].data.coverPhoto.__op, 'remove');
    assert.deepStrictEqual(L.log.deleted, [FID(2)]);
  } finally { L.log.restore(); }
});

test('setCoverPhoto：权限（没有「管理礼簿」的记账人不行、有的可以）、白事、别人的文件、格式、会员开关', async () => {
  seedBooks();
  const L = loadBooks();
  try {
    let r = await call(L, 'u-clerk', { action: 'setCoverPhoto', bookId: 'b1', fileID: FID(1) });
    assert.notStrictEqual(r.code, 0);
    assert.ok(/权限/.test(r.msg), r.msg);
    r = await call(L, 'u-clerk', { action: 'coverPhotoUrl', bookId: 'b1' });
    assert.ok(/权限/.test(r.msg));
    // 有 books 权限的记账人：文件归属按调用者（记账人上传的文件带记账人的 openid）
    r = await call(L, 'u-clerk2', { action: 'setCoverPhoto', bookId: 'b1', fileID: `cloud://env.b/covers/book-u-clerk2-5.jpg` });
    assert.strictEqual(r.code, 0, r.msg);
    // 白事
    r = await call(L, OWNER, { action: 'setCoverPhoto', bookId: 'bf', fileID: FID(3) });
    assert.ok(/白事/.test(r.msg), r.msg);
    // 别人的文件 / 别的目录
    r = await call(L, OWNER, { action: 'setCoverPhoto', bookId: 'b1', fileID: 'cloud://env.b/covers/book-o-other-3.jpg' });
    assert.ok(/无效/.test(r.msg), r.msg);
    r = await call(L, OWNER, { action: 'setCoverPhoto', bookId: 'b1', fileID: `cloud://env.b/paycodes/book-${OWNER}-3.png` });
    assert.ok(/无效/.test(r.msg), r.msg);
    // 不存在的礼簿
    r = await call(L, OWNER, { action: 'setCoverPhoto', bookId: 'nope', fileID: FID(3) });
    assert.ok(/不存在/.test(r.msg), r.msg);
  } finally { L.log.restore(); }
  // 格式不对（文本 / GIF）：拒绝并删掉刚上传的文件
  const L2 = loadBooks(Buffer.from('GIF89a....................'));
  try {
    seedBooks();
    const r = await call(L2, OWNER, { action: 'setCoverPhoto', bookId: 'b1', fileID: FID(4) });
    assert.ok(/格式/.test(r.msg), r.msg);
    assert.deepStrictEqual(L2.log.deleted, [FID(4)]);
    assert.ok(!L2.log.updates.some(x => x.name === 'books'));
  } finally { L2.log.restore(); }
  // 套餐关闭 features.coverPhoto：不能新设，文件删除；移除不受限
  seedBooks({ plan: { coverPhoto: false } });
  const L3 = loadBooks();
  try {
    let r = await call(L3, OWNER, { action: 'setCoverPhoto', bookId: 'b1', fileID: FID(6) });
    assert.ok(/会员/.test(r.msg), r.msg);
    assert.ok(L3.log.deleted.includes(FID(6)), '套餐不允许时刚上传的文件删除');
    r = await call(L3, OWNER, { action: 'setCoverPhoto', bookId: 'b1', fileID: '' });
    assert.strictEqual(r.code, 0, '移除不受套餐限制');
  } finally { L3.log.restore(); }
});

test('setCoverPhoto：审核违规（imgSecCheck 87014）拒绝且不保存', async () => {
  seedBooks();
  const L = loadBooks();
  sdk.openapi = { security: { imgSecCheck: async () => { const e = new Error('risky'); e.errCode = 87014; throw e; } } };
  try {
    const r = await call(L, OWNER, { action: 'setCoverPhoto', bookId: 'b1', fileID: FID(9) });
    assert.notStrictEqual(r.code, 0);
    assert.ok(/不适宜/.test(r.msg), r.msg);
    assert.ok(!L.log.updates.some(x => x.name === 'books'));
    assert.ok(L.log.deleted.includes(FID(9)), '违规文件删除');
  } finally { L.log.restore(); }
});

test('list 返回 coverPhoto 只有形状、不含 fileID；pdfDeco 随 pdfTheme；coverPhotoUrl 返回临时链接', async () => {
  seedBooks({ b1: { coverPhoto: { fileID: FID(11), shape: 'oval' }, pdfTheme: { key: 'peach', deco: 'lotus' } } });
  const L = loadBooks();
  try {
    let r = await call(L, OWNER, { action: 'list' });
    assert.strictEqual(r.code, 0, r.msg);
    const b = r.data.list.find(x => x._id === 'b1');
    assert.deepStrictEqual(b.coverPhoto, { shape: 'oval', layout: 'left', scrim: 'gradient', crop: { x: 0.5, y: 0.5, z: 1 } });
    assert.strictEqual(b.pdfDeco, 'lotus');
    assert.ok(!JSON.stringify(r.data).includes('covers/'), '不返回云存储路径');
    const bf = r.data.list.find(x => x._id === 'bf');
    assert.strictEqual(bf.coverPhoto, null);
    assert.strictEqual(bf.pdfDeco, '');
    r = await call(L, OWNER, { action: 'coverPhotoUrl', bookId: 'b1' });
    assert.strictEqual(r.code, 0);
    assert.ok(/^https:\/\/tmp\.example\//.test(r.data.url));
    assert.strictEqual(r.data.shape, 'oval');
    r = await call(L, OWNER, { action: 'coverPhotoUrl', bookId: 'bf' });
    assert.deepStrictEqual(r.data, { url: '', shape: 'rect', layout: 'left', scrim: 'gradient', crop: { x: 0.5, y: 0.5, z: 1 } });
  } finally { L.log.restore(); }
});

// ---------- export：封面照片 ----------
let haveDeps = true;
try { require.resolve('pdfkit'); } catch (e) { haveDeps = false; }
const t = (name, fn) => test(name, async () => (haveDeps ? fn() : 'SKIP 未安装 pdfkit'));
const F = require('../cloudfunctions/export/fonts.js');
const FONT_DIR = path.join(ROOT, 'tools', 'fonts');
const fontFiles = Object.fromEntries(Object.entries(F.FONT_FILES).map(([k, n]) => [k, haveDeps ? fs.readFileSync(path.join(FONT_DIR, n)) : null]));
const fontMeta = () => ({ _id: 'export_fonts', fonts: Object.fromEntries(Object.keys(fontFiles).map(k => [k, { fileID: 'cloud://env.b/export-fonts/' + F.FONT_FILES[k], name: F.FONT_FILES[k], size: fontFiles[k].length }])) });

/** 真实的小 JPEG（最小合法图片，pdfkit 能解码）：用 pdfkit 自带无法生成，这里手写 1x1 JPEG */
const REAL_JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

function seedExport(book = {}) {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '测试主家', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '测试礼簿', type: 'wedding', date: '2026-10-01', location: '某酒店', ...book }])
    .seed('records', Array.from({ length: 3 }, (_, i) => ({
      _id: 'r' + i, ownerOpenid: OWNER, bookId: 'b1', status: 'paid', payDay: '2026-10-01', payerName: '张三' + i, amount: 100 + i,
      relation: '朋友', payMethod: 'wechat', createdAt: new Date(2026, 9, 1, 10, i), paidAt: new Date(2026, 9, 1, 10, i)
    })))
    .seed('settings', [fontMeta()]);
  state.openid = OWNER;
  state.uploads.length = 0;
}
function loadExport(photoImpl) {
  process.env.HLJ_FONT_TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hlj-cover-test-'));
  const calls = [];
  state.download = async fileID => {
    calls.push(fileID);
    if (fileID.includes('/covers/')) return photoImpl ? photoImpl(fileID) : REAL_JPG;
    return fontFiles[Object.keys(F.FONT_FILES).find(k => fileID.endsWith(F.FONT_FILES[k]))];
  };
  return { fn: loadFunction('export'), calls };
}
const pdfText = u => u.content.toString('latin1');

t('export 传统礼簿：有封面照片 -> 下载并嵌入图片；没有照片不下载', async () => {
  seedExport({ coverPhoto: { fileID: FID(1), shape: 'rect' } });
  let { fn, calls } = loadExport();
  let r = await fn.main({ format: 'book', bookId: 'b1', pdfTheme: 'red_gold' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(calls.some(c => c.includes('/covers/')), '下载了封面照片');
  assert.ok(/\/Subtype \/Image/.test(pdfText(state.uploads[0])), 'PDF 里有图片');
  seedExport();
  ({ fn, calls } = loadExport());
  r = await fn.main({ format: 'book', bookId: 'b1', pdfTheme: 'red_gold' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(!calls.some(c => c.includes('/covers/')));
  assert.ok(!/\/Subtype \/Image/.test(pdfText(state.uploads[0])));
});

t('export 传统礼簿：白事忽略封面照片；套餐关闭 coverPhoto 不放；椭圆形状可用', async () => {
  seedExport({ type: 'funeral', coverPhoto: { fileID: FID(1), shape: 'rect' } });
  let { fn, calls } = loadExport();
  let r = await fn.main({ format: 'book', bookId: 'b1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(!calls.some(c => c.includes('/covers/')), '白事不下载照片');
  assert.ok(!/\/Subtype \/Image/.test(pdfText(state.uploads[0])));
  seedExport({ coverPhoto: { fileID: FID(1), shape: 'oval' } });
  ({ fn, calls } = loadExport());
  r = await fn.main({ format: 'book', bookId: 'b1', pdfTheme: 'peach', pdfDeco: 'lotus' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(/\/Subtype \/Image/.test(pdfText(state.uploads[0])));
});

t('export 传统礼簿：照片下载失败 / 损坏 -> 普通导出照常成功（无照片）；存档报错让用户重试', async () => {
  seedExport({ coverPhoto: { fileID: FID(1), shape: 'rect' } });
  let { fn } = loadExport(() => { throw new Error('download fail'); });
  let r = await quiet(() => fn.main({ format: 'book', bookId: 'b1' }));
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(!/\/Subtype \/Image/.test(pdfText(state.uploads[0])));
  seedExport({ coverPhoto: { fileID: FID(1), shape: 'rect' } });
  ({ fn } = loadExport(() => Buffer.from('not an image at all')));
  r = await quiet(() => fn.main({ format: 'book', bookId: 'b1' }));
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(!/\/Subtype \/Image/.test(pdfText(state.uploads[0])));
  // 损坏但文件头像 JPEG：pdfkit 解码失败也不能让导出失败
  seedExport({ coverPhoto: { fileID: FID(1), shape: 'rect' } });
  ({ fn } = loadExport(() => JPG));
  r = await quiet(() => fn.main({ format: 'book', bookId: 'b1' }));
  assert.strictEqual(r.code, 0, r.msg);
  // 存档：读不到照片要报错
  seedExport({ coverPhoto: { fileID: FID(1), shape: 'rect' } });
  ({ fn } = loadExport(() => { throw new Error('download fail'); }));
  r = await quiet(() => fn.main({ format: 'book', bookId: 'b1', keep: true }));
  assert.notStrictEqual(r.code, 0);
  assert.ok(/封面照片/.test(r.msg), r.msg);
});

t('export 传统礼簿：纹样保存到 pdfTheme.deco，非法值回落；白事只认松枝 / 白菊；预览也带纹样', async () => {
  seedExport();
  const log = [];
  const origCol = db.collection.bind(db);
  db.collection = name => { const c = origCol(name); const od = c.doc; c.doc = id => { const d = od(id); const ou = d.update; d.update = async o => { log.push({ name, id, data: o.data }); return ou.call(d, o); }; return d; }; return c; };
  try {
    const { fn } = loadExport();
    let r = await fn.main({ format: 'book', bookId: 'b1', pdfTheme: 'red_gold', pdfDeco: 'shou' });
    assert.strictEqual(r.code, 0, r.msg);
    let u = log.find(x => x.name === 'books');
    assert.strictEqual(u.data.pdfTheme.v.deco, 'shou');
    log.length = 0;
    r = await fn.main({ format: 'book', bookId: 'b1', pdfTheme: 'red_gold', pdfDeco: 'pine' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.strictEqual(log.find(x => x.name === 'books').data.pdfTheme.v.deco, '', '喜事不能选白事纹样');
    // 白事
    seedExport({ type: 'funeral' });
    log.length = 0;
    const L2 = loadExport();
    r = await L2.fn.main({ format: 'book', bookId: 'b1', pdfTheme: 'custom', pdfCustom: {}, pdfDeco: 'chrys' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.strictEqual(log.find(x => x.name === 'books').data.pdfTheme.v.deco, 'chrys');
    log.length = 0;
    r = await L2.fn.main({ format: 'book', bookId: 'b1', pdfTheme: 'custom', pdfCustom: {}, pdfDeco: 'xi' });
    assert.strictEqual(log.find(x => x.name === 'books').data.pdfTheme.v.deco, '');
    // 预览
    r = await L2.fn.main({ action: 'bookPreview', bookId: 'b1', pdfTheme: 'custom', pdfCustom: {}, pdfDeco: 'pine' });
    assert.strictEqual(r.code, 0, r.msg);
  } finally { db.collection = origCol; }
});

t('buildBook 封面：有 / 无照片、各事由、全部纹样都能生成 PDF；白事忽略照片', async () => {
  const { fn } = loadExport();
  const T = fn._test;
  const rows = [{ payerName: '张三', amount: 100, payMethod: 'wechat', payDay: '2026-10-01', relation: '朋友' }];
  const gen = async (type, deco, photo) => {
    const book = { _id: 'b1', name: '测试', type, date: '2026-10-01', location: '某地' };
    const meta = T.buildMeta(rows, { account: { accountName: '主家' }, book, startDay: '', endDay: '', themeName: '', pdfThemeKey: type === 'funeral' ? 'custom' : 'red_gold', pdfCustom: type === 'funeral' ? themes.sanitizeFuneral({}) : null, pdfDeco: deco, premiumOk: true });
    if (photo) meta.photo = photo;
    const plan = F.planFor('book', meta.bt);
    const got = plan.resolve({ buffers: fontFiles, failed: {} });
    const buf = await quiet(() => T.buildBook(rows, meta, got.fonts));
    assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
    return buf;
  };
  for (const ty of ['wedding', 'birthday', 'baby', 'house', 'other']) {
    for (const d of themes.DECOS) await gen(ty, d, null);
    const withPhoto = await gen(ty, '', { buf: REAL_JPG, shape: 'rect' });
    const oval = await gen(ty, '', { buf: REAL_JPG, shape: 'oval' });
    assert.ok(/\/Subtype \/Image/.test(withPhoto.toString('latin1')) && /\/Subtype \/Image/.test(oval.toString('latin1')));
  }
  for (const d of themes.FUNERAL_DECOS) await gen('funeral', d, null);
  const f = await gen('funeral', 'pine', { buf: REAL_JPG, shape: 'rect' });
  assert.ok(!/\/Subtype \/Image/.test(f.toString('latin1')), '白事忽略照片');
  const bad = await gen('wedding', '', { buf: JPG, shape: 'rect' }); // 损坏图片：画不出来时回到无照片排版，不抛错
  assert.ok(bad.length > 1000);
});

// ---------- 前端：压缩 / 页面 / 版本 ----------
test('imgcompress.cover：逐级压到 1.5MB 内；压缩不可用用原图；超过 3MB 返回空串', async () => {
  const sizes = {};
  const mk = (map, noCompress) => {
    global.wx = {
      compressImage: noCompress ? undefined : ({ src, quality, success }) => success({ tempFilePath: src + '.q' + quality }),
      getFileSystemManager: () => ({ getFileInfo: ({ filePath, success, fail }) => (map[filePath] !== undefined ? success({ size: map[filePath] }) : fail({})) })
    };
  };
  try {
    mk({ 'a.jpg.q80': 500 * 1024 }); // 一次就够
    assert.strictEqual(await imgc.cover('a.jpg', 4 * 1024 * 1024), 'a.jpg.q80');
    mk({ 'a.jpg.q80': 2 * 1024 * 1024, 'a.jpg.q80.q60': 1.6 * 1024 * 1024, 'a.jpg.q80.q60.q40': 400 * 1024 }); // 要压到 40
    assert.strictEqual(await imgc.cover('a.jpg', 5 * 1024 * 1024), 'a.jpg.q80.q60.q40');
    mk({ 'a.jpg.q80': 4 * 1024 * 1024, 'a.jpg.q80.q60': 4 * 1024 * 1024, 'a.jpg.q80.q60.q40': 3.5 * 1024 * 1024 });
    assert.strictEqual(await imgc.cover('a.jpg', 9 * 1024 * 1024), '', '压不到 3MB 内：提示换图');
    mk({ 'a.jpg': 200 * 1024 }, true); // 没有 compressImage：用原图
    assert.strictEqual(await imgc.cover('a.jpg', 200 * 1024), 'a.jpg');
    mk({}, true);
    assert.strictEqual(await imgc.cover('big.jpg', 8 * 1024 * 1024), '', '原图太大又压不了');
  } finally { delete global.wx; }
});

test('主题页接入：request 封装、白事不显示照片区、上传路径 covers/、首次隐私提示、版本号', () => {
  const rq = read('miniprogram/utils/request.js');
  assert.ok(rq.includes("bookSetCover: (bookId, fileID, shape, extra) => call('books', Object.assign({ action: 'setCoverPhoto'"));
  assert.ok(/'coverPhotoUrl'/.test(rq.split('READ_ACTIONS')[1].split(']')[0]), '取链接是只读 action');
  const js = read('miniprogram/pages/booktheme/booktheme.js');
  assert.ok(js.includes('covers/book-${getApp().globalData.openid}-${Date.now()}.jpg'));
  assert.ok(js.includes("wx.getStorageSync('coverPhotoTip')") && js.includes('照片会印在导出'));
  assert.ok(/pdfDeco: d\.deco/.test(js));
  const wxml = read('miniprogram/pages/booktheme/booktheme.wxml');
  assert.ok(/wx:if="\{\{!isFuneral && canSave\}\}">\s*<view class="section-title">封面照片/.test(wxml), '白事与无权限者不显示照片区');
  assert.ok(wxml.includes('白事礼簿封面不使用照片'));
  // showModal 按钮文字不超过 4 个字
  [...js.matchAll(/(?:confirmText|cancelText): '([^']+)'/g)].forEach(m => assert.ok(m[1].length <= 4, m[1]));
  // 云函数端：books 白名单入口与权限
  const b = read('cloudfunctions/books/index.js');
  assert.ok(/\['setCoverPhoto', 'coverPhotoUrl'\]\.includes\(event\.action\) && !can\(ctx, 'books'\)/.test(b));
  assert.ok(/case 'setCoverPhoto'/.test(b) && /case 'coverPhotoUrl'/.test(b));
  assert.ok(/VERSION: '3\.\d+\.\d+'/.test(read('miniprogram/config.js')));
});

test('套餐：features.coverPhoto 缺项开放，默认套餐为 true（plans 各份一致）', () => {
  const P = require('../tools/cloud-shared/plans.js');
  assert.strictEqual(P.DEFAULT_PLANS.free.features.coverPhoto, true);
  assert.strictEqual(P.DEFAULT_PLANS.pro.features.coverPhoto, true);
  assert.ok(P.featureOpen({}, 'coverPhoto'));
  assert.ok(!P.featureOpen({ coverPhoto: false }, 'coverPhoto'));
});
