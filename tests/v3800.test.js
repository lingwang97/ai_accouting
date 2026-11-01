// v3.80.0：整页封面照片（layout full / 文字托底 / 九宫格焦点 / 单次打印方式 / 分辨率三档 / 1.5MB）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const themes = require('../cloudfunctions/export/themes.js');
const pt = require('../miniprogram/pages/booktheme/pdftheme.js');
const imgc = require('../miniprogram/utils/imgcompress.js');

const OWNER = 'o-owner';
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
const FID = n => `cloud://env.b/covers/book-${OWNER}-${n}.jpg`;
const quiet = async fn => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

test('themes：版式 / 托底 / 打印 / 焦点的白名单，非法值回默认', () => {
  assert.strictEqual(themes.sanitizeLayout('full'), 'full');
  assert.strictEqual(themes.sanitizeLayout('x'), 'left');
  assert.strictEqual(themes.sanitizeScrim('block'), 'block');
  assert.strictEqual(themes.sanitizeScrim(undefined), 'gradient');
  assert.strictEqual(themes.sanitizePrint('fade'), 'fade');
  assert.strictEqual(themes.sanitizePrint('none'), 'none');
  assert.strictEqual(themes.sanitizePrint('whatever'), 'keep');
  assert.deepStrictEqual(themes.sanitizeFocus({ x: 2, y: 0 }), { x: 2, y: 0 });
  assert.deepStrictEqual(themes.sanitizeFocus({ x: 9, y: -1 }), { x: 1, y: 1 });
  assert.deepStrictEqual(themes.sanitizeFocus('abc'), { x: 1, y: 1 });
  assert.deepStrictEqual(themes.sanitizeFocus(null), { x: 1, y: 1 });
});

test('前后端清单一致：版式 / 托底 / 打印 / 焦点格；分辨率三档', () => {
  assert.deepStrictEqual(pt.COVER_LAYOUTS.map(x => x.k), themes.PHOTO_LAYOUTS);
  assert.deepStrictEqual(pt.COVER_SCRIMS.map(x => x.k), themes.PHOTO_SCRIMS);
  assert.deepStrictEqual(pt.COVER_PRINTS.map(x => x.k), themes.PRINT_MODES);
  assert.strictEqual(pt.FOCUS_CELLS.length, 9);
  assert.deepStrictEqual(pt.FOCUS_CELLS[0], { n: '左上', x: 0, y: 0 });
  assert.deepStrictEqual(pt.FOCUS_CELLS[4], { n: '中', x: 1, y: 1 });
  assert.deepStrictEqual(pt.FOCUS_CELLS[8], { n: '右下', x: 2, y: 2 });
  // 整页：短边 <1100 偏糊、<1600 一般、否则清晰；左图右文：600 / 900
  assert.strictEqual(pt.photoTier(3000, 1000, 'full').k, 'low');
  assert.strictEqual(pt.photoTier(1400, 2000, 'full').k, 'mid');
  assert.strictEqual(pt.photoTier(3024, 4032, 'full').k, 'high');
  assert.strictEqual(pt.photoTier(500, 900, 'left').k, 'low');
  assert.strictEqual(pt.photoTier(800, 900, 'left').k, 'mid');
  assert.strictEqual(pt.photoTier(1200, 1600, 'left').k, 'high');
  assert.strictEqual(pt.photoTier(1000, 1000, 'full').n, '偏糊');
  assert.strictEqual(pt.photoTier(0, 0, 'left').k, 'low');
});

test('imgcompress.cover：上限 1.5MB（1.2MB 压一次就够；超过 1.5MB 继续压）', async () => {
  assert.strictEqual(imgc.COVER_LIMIT, 1.5 * 1024 * 1024);
  const mk = map => {
    global.wx = {
      compressImage: ({ src, quality, success }) => success({ tempFilePath: src + '.q' + quality }),
      getFileSystemManager: () => ({ getFileInfo: ({ filePath, success, fail }) => (map[filePath] !== undefined ? success({ size: map[filePath] }) : fail({})) })
    };
  };
  try {
    mk({ 'a.jpg.q80': 1.2 * 1024 * 1024 });
    assert.strictEqual(await imgc.cover('a.jpg', 6 * 1024 * 1024), 'a.jpg.q80', '1.2MB 在新上限内，不再继续压');
    mk({ 'a.jpg.q80': 1.8 * 1024 * 1024, 'a.jpg.q80.q60': 1.3 * 1024 * 1024 });
    assert.strictEqual(await imgc.cover('a.jpg', 6 * 1024 * 1024), 'a.jpg.q80.q60');
  } finally { delete global.wx; }
  // 服务端上限与审核不变
  assert.ok(/COVER_MAX = 4 \* 1024 \* 1024/.test(read('cloudfunctions/books/index.js')));
  assert.ok(/IMG_MAX = 1024 \* 1024/.test(read('tools/cloud-shared/secure.js')));
});

// ---------- books ----------
function seedBooks() {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '主家', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }])
    .seed('books', [
      { _id: 'b1', ownerOpenid: OWNER, name: '婚礼', type: 'wedding', statReady: true, statCount: 0, statFen: 0, createdAt: new Date() },
      { _id: 'bf', ownerOpenid: OWNER, name: '白事', type: 'funeral', statReady: true, statCount: 0, statFen: 0, createdAt: new Date() }
    ]);
}
function loadBooks() {
  const log = { updates: [], deleted: [] };
  const origCol = db.collection.bind(db);
  db.collection = name => {
    const c = origCol(name);
    const od = c.doc;
    c.doc = id => { const d = od(id); d.update = async o => { log.updates.push({ name, id, data: o.data }); return { stats: { updated: 1 } }; }; return d; };
    return c;
  };
  const origDel = sdk.deleteFile;
  sdk.deleteFile = async o => { log.deleted.push(...o.fileList); return { fileList: o.fileList.map(() => ({ status: 0 })) }; };
  sdk.openapi = { security: { imgSecCheck: async () => ({}) } };
  state.download = async () => JPG;
  const fn = loadFunction('books');
  log.restore = () => { db.collection = origCol; sdk.deleteFile = origDel; sdk.openapi = {}; };
  return { fn, log };
}
const call = async (L, body) => { state.openid = OWNER; return quiet(() => L.fn.main(body)); };
const stored = L => L.log.updates.filter(x => x.name === 'books').pop().data.coverPhoto.v;

test('setCoverPhoto：版式 / 托底 / 焦点落库，默认值不落库；只改展示设置不动文件；旧数据缺项按默认', async () => {
  seedBooks();
  const L = loadBooks();
  try {
    // 新设：整页 + 色块 + 右下焦点
    let r = await call(L, { action: 'setCoverPhoto', bookId: 'b1', fileID: FID(1), shape: 'rect', layout: 'full', scrim: 'block', focus: { x: 2, y: 2 } });
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(stored(L), { fileID: FID(1), shape: 'rect', layout: 'full', scrim: 'block', focus: { x: 2, y: 2 } });
    assert.deepStrictEqual(r.data.coverPhoto, { shape: 'rect', layout: 'full', scrim: 'block', focus: { x: 2, y: 2 } });
    // 只改焦点（其余沿用旧值）
    db.data.books[0].coverPhoto = stored(L);
    L.log.updates.length = 0;
    r = await call(L, { action: 'setCoverPhoto', bookId: 'b1', focus: { x: 0, y: 1 } });
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(stored(L), { fileID: FID(1), shape: 'rect', layout: 'full', scrim: 'block', focus: { x: 0, y: 1 } });
    assert.deepStrictEqual(L.log.deleted, [], '只改展示设置不删文件');
    // 改回默认：layout left / scrim gradient / 中心焦点 -> 不落库的字段全部消失
    db.data.books[0].coverPhoto = stored(L);
    r = await call(L, { action: 'setCoverPhoto', bookId: 'b1', layout: 'left', scrim: 'gradient', focus: { x: 1, y: 1 } });
    assert.deepStrictEqual(stored(L), { fileID: FID(1), shape: 'rect' });
    // 非法值回默认
    db.data.books[0].coverPhoto = { fileID: FID(1), shape: 'oval' };
    r = await call(L, { action: 'setCoverPhoto', bookId: 'b1', layout: 'evil', scrim: 'x', focus: { x: 99, y: 'a' } });
    assert.deepStrictEqual(stored(L), { fileID: FID(1), shape: 'oval' });
    // 旧数据（只有 fileID / shape）list 返回默认的版式 / 托底 / 焦点
    r = await call(L, { action: 'list' });
    const b = r.data.list.find(x => x._id === 'b1');
    assert.deepStrictEqual(b.coverPhoto, { shape: 'oval', layout: 'left', scrim: 'gradient', focus: { x: 1, y: 1 } });
    // 白事仍不能设置（含设置展示项），没有照片时只改展示设置报错
    r = await call(L, { action: 'setCoverPhoto', bookId: 'bf', fileID: FID(2), layout: 'full' });
    assert.ok(/白事/.test(r.msg), r.msg);
    r = await call(L, { action: 'setCoverPhoto', bookId: 'bf', layout: 'full' });
    assert.notStrictEqual(r.code, 0);
  } finally { L.log.restore(); }
});

test('coverPhotoUrl 返回版式 / 托底 / 焦点（不含云存储路径）', async () => {
  seedBooks();
  db.data.books[0].coverPhoto = { fileID: FID(5), shape: 'oval', layout: 'full', focus: { x: 0, y: 2 } };
  const L = loadBooks();
  sdk.getTempFileURL = async o => ({ fileList: o.fileList.map(f => ({ fileID: f, status: 0, tempFileURL: 'https://tmp.example/x' })) });
  try {
    const r = await call(L, { action: 'coverPhotoUrl', bookId: 'b1' });
    assert.deepStrictEqual({ ...r.data }, { url: 'https://tmp.example/x', shape: 'oval', layout: 'full', scrim: 'gradient', focus: { x: 0, y: 2 } });
  } finally { L.log.restore(); sdk.getTempFileURL = async () => ({ fileList: [] }); }
});

// ---------- export ----------
let haveDeps = true;
try { require.resolve('pdfkit'); } catch (e) { haveDeps = false; }
const t = (name, fn) => test(name, async () => (haveDeps ? fn() : 'SKIP 未安装 pdfkit'));
const F = require('../cloudfunctions/export/fonts.js');
const fontFiles = Object.fromEntries(Object.entries(F.FONT_FILES).map(([k, n]) => [k, haveDeps ? fs.readFileSync(path.join(ROOT, 'tools', 'fonts', n)) : null]));
const fontMeta = () => ({ _id: 'export_fonts', fonts: Object.fromEntries(Object.keys(fontFiles).map(k => [k, { fileID: 'cloud://env.b/export-fonts/' + F.FONT_FILES[k], name: F.FONT_FILES[k], size: fontFiles[k].length }])) });
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
function loadExport() {
  process.env.HLJ_FONT_TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hlj-cover800-'));
  const calls = [];
  state.download = async fileID => {
    calls.push(fileID);
    if (fileID.includes('/covers/')) return REAL_JPG;
    return fontFiles[Object.keys(F.FONT_FILES).find(k => fileID.endsWith(F.FONT_FILES[k]))];
  };
  return { fn: loadFunction('export'), calls };
}
const hasImg = u => /\/Subtype \/Image/.test(u.content.toString('latin1'));

t('export：整页版式生成成功且带图；coverPrint=none 不下载不放图；fade 仍带图；非法值按保留；预览同样生效', async () => {
  const cp = { fileID: FID(1), shape: 'rect', layout: 'full', scrim: 'block', focus: { x: 0, y: 2 } };
  seedExport({ coverPhoto: cp });
  let { fn, calls } = loadExport();
  let r = await fn.main({ format: 'book', bookId: 'b1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(hasImg(state.uploads[0]));
  assert.ok(calls.some(c => c.includes('/covers/')));
  // none：只作用于本次，不下载、没有图，库里的 coverPhoto 不动
  seedExport({ coverPhoto: cp });
  ({ fn, calls } = loadExport());
  r = await fn.main({ format: 'book', bookId: 'b1', coverPrint: 'none' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(!hasImg(state.uploads[0]) && !calls.some(c => c.includes('/covers/')));
  assert.deepStrictEqual(db.data.books[0].coverPhoto, cp, '打印方式不改库');
  // none + 存档：不当作读取失败
  seedExport({ coverPhoto: cp });
  ({ fn, calls } = loadExport());
  r = await fn.main({ format: 'book', bookId: 'b1', coverPrint: 'none', keep: true });
  assert.strictEqual(r.code, 0, r.msg);
  // fade
  seedExport({ coverPhoto: cp });
  ({ fn } = loadExport());
  r = await fn.main({ format: 'book', bookId: 'b1', coverPrint: 'fade' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(hasImg(state.uploads[0]));
  // 非法值 -> keep
  seedExport({ coverPhoto: cp });
  ({ fn } = loadExport());
  r = await fn.main({ format: 'book', bookId: 'b1', coverPrint: 'hack' });
  assert.ok(r.code === 0 && hasImg(state.uploads[0]));
  // 预览：none 无图，keep 有图
  seedExport({ coverPhoto: cp });
  ({ fn } = loadExport());
  r = await fn.main({ action: 'bookPreview', bookId: 'b1', coverPrint: 'none' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(!hasImg(state.uploads[0]));
  seedExport({ coverPhoto: cp });
  ({ fn } = loadExport());
  r = await fn.main({ action: 'bookPreview', bookId: 'b1' });
  assert.ok(r.code === 0 && hasImg(state.uploads[0]));
});

t('export：白事即使库里有整页照片也不放；旧数据（缺 layout）按左图右文', async () => {
  seedExport({ type: 'funeral', coverPhoto: { fileID: FID(1), shape: 'rect', layout: 'full' } });
  let { fn, calls } = loadExport();
  let r = await fn.main({ format: 'book', bookId: 'b1', coverPrint: 'keep' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(!hasImg(state.uploads[0]) && !calls.some(c => c.includes('/covers/')));
  seedExport({ coverPhoto: { fileID: FID(1), shape: 'oval' } });
  ({ fn } = loadExport());
  r = await fn.main({ format: 'book', bookId: 'b1' });
  assert.ok(r.code === 0 && hasImg(state.uploads[0]));
});

t('buildBook 封面：各事由 x 版式 x 托底 x 焦点 x 淡化，全部能生成；整页损坏图片回到无照片排版', async () => {
  const { fn } = loadExport();
  const T = fn._test;
  const rows = [{ payerName: '张三', amount: 100, payMethod: 'wechat', payDay: '2026-10-01', relation: '朋友' }];
  const gen = async (type, photo) => {
    const book = { _id: 'b1', name: '测试', type, date: '2026-10-01', location: '某地' };
    const meta = T.buildMeta(rows, { account: { accountName: '主家' }, book, startDay: '', endDay: '', themeName: '', pdfThemeKey: type === 'funeral' ? 'custom' : '', pdfCustom: type === 'funeral' ? themes.sanitizeFuneral({}) : null, pdfDeco: '', premiumOk: true });
    if (photo) meta.photo = photo;
    const plan = F.planFor('book', meta.bt);
    const got = plan.resolve({ buffers: fontFiles, failed: {} });
    const buf = await quiet(() => T.buildBook(rows, meta, got.fonts));
    assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
    return buf;
  };
  for (const ty of ['wedding', 'birthday', 'baby', 'house', 'other']) {
    for (const layout of ['left', 'full']) {
      for (const scrim of ['gradient', 'block']) {
        for (const fade of [false, true]) {
          const buf = await gen(ty, { buf: REAL_JPG, shape: 'rect', layout, scrim, focus: { x: 2, y: 0 }, fade });
          assert.ok(/\/Subtype \/Image/.test(buf.toString('latin1')), `${ty}/${layout}/${scrim}/${fade}`);
        }
      }
    }
  }
  for (const x of [0, 1, 2]) for (const y of [0, 1, 2]) await gen('wedding', { buf: REAL_JPG, shape: 'rect', layout: 'full', scrim: 'gradient', focus: { x, y }, fade: false });
  const f = await gen('funeral', { buf: REAL_JPG, shape: 'rect', layout: 'full', scrim: 'gradient', focus: { x: 1, y: 1 }, fade: false });
  assert.ok(!/\/Subtype \/Image/.test(f.toString('latin1')), '白事忽略整页照片');
  const bad = await gen('wedding', { buf: JPG, shape: 'rect', layout: 'full', scrim: 'gradient', focus: { x: 1, y: 1 }, fade: false });
  assert.ok(bad.length > 1000, '损坏图片不抛错');
  // 回归：不带照片 / 老式 photo 对象（无 layout、focus）
  await gen('wedding', null);
  await gen('wedding', { buf: REAL_JPG, shape: 'oval' });
});

test('主题页接入：版式 / 托底 / 焦点 / 打印 / 分辨率提示、coverPrint 随导出预览参数且不保存', () => {
  const js = read('miniprogram/pages/booktheme/booktheme.js');
  assert.ok(/coverPrint: d\.coverSet \? d\.coverPrint : 'keep'/.test(js), '导出 / 预览带 coverPrint');
  assert.ok(js.includes('saveCoverOpts') && js.includes('layout: d.coverLayout, scrim: d.coverScrim, focus: d.coverFocus'));
  assert.ok(js.includes('pt.photoTier('), '分辨率三档提示');
  assert.ok(!/bookSetCover\([^)]*coverPrint/.test(js), '打印方式不保存到礼簿');
  const wxml = read('miniprogram/pages/booktheme/booktheme.wxml');
  ['onLayout', 'onScrim', 'onFocus', 'onPrint'].forEach(h => assert.ok(wxml.includes('bind' + 'tap="' + h + '"'), h));
  assert.ok(/wx:if="\{\{!isFuneral && canSave\}\}">\s*<view class="section-title">封面照片/.test(wxml), '白事仍无照片区');
  [...js.matchAll(/(?:confirmText|cancelText): '([^']+)'/g)].forEach(m => assert.ok(m[1].length <= 4, m[1]));
  const ex = read('cloudfunctions/export/index.js');
  assert.ok(ex.includes('themes.sanitizePrint(event.coverPrint)'));
  assert.ok(!/pdfTheme[^\n]*coverPrint|coverPrint[^\n]*save\./.test(ex), 'coverPrint 不写入礼簿');
  assert.ok(/VERSION: '3\.80\.0'/.test(read('miniprogram/config.js')));
});
