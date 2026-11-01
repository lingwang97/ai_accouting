// v3.82.0：水印字移到内页；封面照片连续裁剪 crop {x,y,z}（前后端共用 cropGeom、旧九宫格映射、拖动 / 缩放计算）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const themes = require('../cloudfunctions/export/themes.js');
const pt = require('../miniprogram/pages/booktheme/pdftheme.js');

const OWNER = 'o-owner';
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const FID = n => `cloud://env.b/covers/book-${OWNER}-${n}.jpg`;
const quiet = async fn => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m || ''} ${a} vs ${b}`);

// ---------- 数据与计算 ----------
test('sanitizeCrop：范围限制与取整、非法值回默认；前后端一致', () => {
  assert.deepStrictEqual(themes.sanitizeCrop(null), { x: 0.5, y: 0.5, z: 1 });
  assert.deepStrictEqual(themes.sanitizeCrop({}), { x: 0.5, y: 0.5, z: 1 });
  assert.deepStrictEqual(themes.sanitizeCrop({ x: -1, y: 9, z: 99 }), { x: 0, y: 1, z: 3 });
  assert.deepStrictEqual(themes.sanitizeCrop({ x: 0.12345, y: '0.5', z: 0.2 }), { x: 0.123, y: 0.5, z: 1 });
  assert.deepStrictEqual(themes.sanitizeCrop({ x: 'abc', y: NaN, z: null }), { x: 0.5, y: 0.5, z: 1 });
  assert.deepStrictEqual(themes.sanitizeCrop('x'), { x: 0.5, y: 0.5, z: 1 });
  const samples = [null, {}, { x: -1, y: 9, z: 99 }, { x: 0.3333333, y: 0.7, z: 1.5 }, { x: 'a' }, { x: '', y: null, z: undefined }, { z: 2.9999 }];
  samples.forEach(s => assert.deepStrictEqual(pt.sanitizeCrop(s), themes.sanitizeCrop(s), JSON.stringify(s)));
});

test('旧九宫格 focus 映射成 crop：x/2、y/2、z=1；coverView 读取旧数据与新数据；默认值不落库', () => {
  assert.deepStrictEqual(themes.focusToCrop({ x: 0, y: 2 }), { x: 0, y: 1, z: 1 });
  assert.deepStrictEqual(themes.focusToCrop({ x: 1, y: 1 }), { x: 0.5, y: 0.5, z: 1 });
  assert.deepStrictEqual(themes.focusToCrop({ x: 9, y: 'a' }), { x: 0.5, y: 0.5, z: 1 });
  assert.deepStrictEqual(themes.coverView({ fileID: 'x', focus: { x: 2, y: 0 } }).crop, { x: 1, y: 0, z: 1 });
  assert.deepStrictEqual(themes.coverView({ fileID: 'x', crop: { x: 0.2, y: 0.9, z: 2 }, focus: { x: 2, y: 0 } }).crop, { x: 0.2, y: 0.9, z: 2 }, '同时存在以 crop 为准');
  assert.deepStrictEqual(themes.coverView({ fileID: 'x' }).crop, { x: 0.5, y: 0.5, z: 1 });
  assert.deepStrictEqual(themes.coverDoc('f', themes.coverView({ fileID: 'f' })), { fileID: 'f', shape: 'rect' });
  assert.deepStrictEqual(themes.coverDoc('f', themes.coverView({ fileID: 'f', focus: { x: 0, y: 1 } })), { fileID: 'f', shape: 'rect', crop: { x: 0, y: 0.5, z: 1 } }, '旧 focus 保存后改写为 crop，不再带 focus');
  assert.deepStrictEqual(themes.coverOverride({ coverCrop: { x: 0.1, y: 0.2, z: 2 }, coverFocus: { x: 2, y: 2 } }), { crop: { x: 0.1, y: 0.2, z: 2 } }, 'coverCrop 优先');
  assert.deepStrictEqual(themes.coverOverride({ coverFocus: { x: 0, y: 2 } }), { crop: { x: 0, y: 1, z: 1 } }, '旧参数 coverFocus 仍可读');
});

test('cropGeom：随机尺寸下前后端结果一致；z=1 刚好铺满；偏移范围在 [0, 多出的像素]', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 2000; i++) {
    const w = 100 + Math.floor(rnd() * 5000), h = 100 + Math.floor(rnd() * 5000);
    const bw = 50 + rnd() * 800, bh = 50 + rnd() * 600;
    const crop = { x: rnd(), y: rnd(), z: 1 + rnd() * 2 };
    const a = themes.cropGeom(w, h, bw, bh, crop), b = pt.cropGeom(w, h, bw, bh, crop);
    ['iw', 'ih', 'ox', 'oy'].forEach(k => near(a[k], b[k], k));
    assert.ok(a.iw >= bw - 1e-6 && a.ih >= bh - 1e-6, '至少铺满裁剪框');
    assert.ok(a.ox >= -1e-9 && a.ox <= a.iw - bw + 1e-9 && a.oy >= -1e-9 && a.oy <= a.ih - bh + 1e-9, '不露出空白');
  }
  // z=1：刚好铺满较小的那一边
  const g = themes.cropGeom(1200, 1600, 280, 403.28, { x: 0.5, y: 0.5, z: 1 });
  near(g.ih, 403.28); near(g.oy, 0);
  assert.ok(g.iw > 280 && g.ox > 0 && g.ox < g.iw - 280);
  // 框比例（与 PDF 一致）
  near(pt.COVER_BOX.left.w / pt.COVER_BOX.left.h, 280 / (595.28 - 192));
  near(pt.COVER_BOX.full.w / pt.COVER_BOX.full.h, 841.89 / 595.28);
});

test('裁剪编辑器计算：panBy 夹在范围内、无多余像素的方向不动；zoomAt 保持框中心不变且 z 夹在 1~3', () => {
  const box = { w: 280, h: 403.28 };
  // 竖图在左图框里：横向只有一点点余量，纵向 0
  let c = pt.panBy({ x: 0.5, y: 0.5, z: 1 }, 100, 100, 1200, 1600, box.w, box.h);
  assert.strictEqual(c.y, 0.5, 'z=1 竖图纵向没有余量，不动');
  assert.ok(c.x >= 0 && c.x < 0.5, '图片向右拖：x 变小');
  c = pt.panBy({ x: 0.5, y: 0.5, z: 1 }, -9999, 0, 1600, 1200, box.w, box.h);
  assert.strictEqual(c.x, 1, '拖过头夹到边');
  // 放大后纵向有余量
  c = pt.panBy({ x: 0.5, y: 0.5, z: 2 }, 0, -50, 1200, 1600, box.w, box.h);
  assert.ok(c.y > 0.5 && c.y <= 1);
  // zoomAt：框中心对应的图片位置不变
  const imgW = 3000, imgH = 2000;
  for (const crop of [{ x: 0.5, y: 0.5, z: 1 }, { x: 0.2, y: 0.8, z: 1.5 }, { x: 1, y: 0, z: 2.5 }]) {
    for (const nz of [1, 1.7, 3, 9, 0.2]) {
      const before = pt.cropGeom(imgW, imgH, 560, 396, crop);
      const out = pt.zoomAt(crop, nz, imgW, imgH, 560, 396);
      assert.ok(out.z >= 1 && out.z <= 3 && out.x >= 0 && out.x <= 1 && out.y >= 0 && out.y <= 1);
      const after = pt.cropGeom(imgW, imgH, 560, 396, out);
      const fx0 = (before.ox + 280) / before.iw, fx1 = (after.ox + 280) / after.iw;
      const fy0 = (before.oy + 198) / before.ih, fy1 = (after.oy + 198) / after.ih;
      // 夹到边界时允许偏差；未触边时应一致
      const touch = after.ox <= 1e-6 || after.ox >= after.iw - 560 - 1e-6 || after.oy <= 1e-6 || after.oy >= after.ih - 396 - 1e-6;
      if (!touch) { assert.ok(Math.abs(fx0 - fx1) < 2e-3 && Math.abs(fy0 - fy1) < 2e-3, `${fx0} ${fx1} ${fy0} ${fy1}`); } // crop 保存精度 3 位小数
    }
  }
});

// ---------- books ----------
function seedBooks() {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '主家', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '婚礼', type: 'wedding', statReady: true, statCount: 0, statFen: 0, createdAt: new Date() }]);
}
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
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

test('books：crop 保存与校验、旧 focus 读取映射并在保存后改写、换新照片裁剪回默认', async () => {
  seedBooks();
  const L = loadBooks();
  try {
    let r = await call(L, { action: 'setCoverPhoto', bookId: 'b1', fileID: FID(1), shape: 'rect', crop: { x: 0.2, y: 0.9, z: 2.5 } });
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(stored(L), { fileID: FID(1), shape: 'rect', crop: { x: 0.2, y: 0.9, z: 2.5 } });
    assert.deepStrictEqual(r.data.coverPhoto.crop, { x: 0.2, y: 0.9, z: 2.5 });
    // 只改 crop（越界值夹住）
    db.data.books[0].coverPhoto = stored(L);
    r = await call(L, { action: 'setCoverPhoto', bookId: 'b1', crop: { x: -5, y: 'abc', z: 99 } });
    assert.deepStrictEqual(stored(L), { fileID: FID(1), shape: 'rect', crop: { x: 0, y: 0.5, z: 3 } });
    // 默认值不落库
    r = await call(L, { action: 'setCoverPhoto', bookId: 'b1', crop: { x: 0.5, y: 0.5, z: 1 } });
    assert.deepStrictEqual(stored(L), { fileID: FID(1), shape: 'rect' });
    // 旧数据（九宫格 focus）：list 返回映射后的 crop；只改版式保存后 focus 被 crop 取代
    db.data.books[0].coverPhoto = { fileID: FID(1), shape: 'oval', layout: 'full', focus: { x: 2, y: 0 } };
    r = await call(L, { action: 'list' });
    assert.deepStrictEqual(r.data.list[0].coverPhoto, { shape: 'oval', layout: 'full', scrim: 'gradient', crop: { x: 1, y: 0, z: 1 } });
    r = await call(L, { action: 'setCoverPhoto', bookId: 'b1', scrim: 'block' });
    assert.deepStrictEqual(stored(L), { fileID: FID(1), shape: 'oval', layout: 'full', scrim: 'block', crop: { x: 1, y: 0, z: 1 } });
    assert.ok(!('focus' in stored(L)));
    // 换新照片：没传 crop 时回到默认；传了就用传的
    db.data.books[0].coverPhoto = { fileID: FID(1), shape: 'rect', crop: { x: 0.1, y: 0.9, z: 2 } };
    r = await call(L, { action: 'setCoverPhoto', bookId: 'b1', fileID: FID(2) });
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(stored(L), { fileID: FID(2), shape: 'rect' });
    db.data.books[0].coverPhoto = { fileID: FID(1), shape: 'rect', crop: { x: 0.1, y: 0.9, z: 2 } };
    r = await call(L, { action: 'setCoverPhoto', bookId: 'b1', fileID: FID(3), crop: { x: 0.3, y: 0.3, z: 1.2 } });
    assert.deepStrictEqual(stored(L), { fileID: FID(3), shape: 'rect', crop: { x: 0.3, y: 0.3, z: 1.2 } });
  } finally { L.log.restore(); }
});

// ---------- export ----------
let haveDeps = true;
try { require.resolve('pdfkit'); } catch (e) { haveDeps = false; }
const t = (name, fn) => test(name, async () => (haveDeps ? fn() : 'SKIP 未安装 pdfkit'));
const F = require('../cloudfunctions/export/fonts.js');
const fontFiles = Object.fromEntries(Object.entries(F.FONT_FILES).map(([k, n]) => [k, haveDeps ? fs.readFileSync(path.join(ROOT, 'tools', 'fonts', n)) : null]));
const fontMeta = () => ({ _id: 'export_fonts', fonts: Object.fromEntries(Object.keys(fontFiles).map(k => [k, { fileID: 'cloud://env.b/export-fonts/' + F.FONT_FILES[k], name: F.FONT_FILES[k], size: fontFiles[k].length }])) });
// 2:1 的小 PNG（8x4）：便于验证裁剪几何（宽图）
const zlib = require('zlib');
function png(w, h) {
  const crc = b => { let c, t2 = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t2[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t2[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (ty, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 200)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const WIDE = png(80, 40), TALL = png(40, 80);

function seedExport(book = {}) {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '测试主家', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '测试礼簿', type: 'wedding', date: '2026-10-01', location: '某酒店', ...book }])
    .seed('records', [{ _id: 'r0', ownerOpenid: OWNER, bookId: 'b1', status: 'paid', payDay: '2026-10-01', payerName: '张三', amount: 100, relation: '朋友', payMethod: 'wechat', createdAt: new Date(), paidAt: new Date() }])
    .seed('settings', [fontMeta()]);
  state.openid = OWNER;
  state.uploads.length = 0;
}
function loadExport(photo) {
  process.env.HLJ_FONT_TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hlj-v3820-'));
  state.download = async fileID => (fileID.includes('/covers/') ? photo : fontFiles[Object.keys(F.FONT_FILES).find(k => fileID.endsWith(F.FONT_FILES[k]))]);
  return loadFunction('export');
}
/** 记录封面上 doc.image 的位置与大小 */
async function imageCalls(fn, body) {
  const PDF = require('pdfkit');
  const orig = PDF.prototype.image;
  const calls = [];
  PDF.prototype.image = function (im, x, y, o) { calls.push({ x, y, w: o && o.width, h: o && o.height }); return orig.apply(this, arguments); };
  try {
    const r = await quiet(() => fn.main(body));
    assert.strictEqual(r.code, 0, r.msg);
  } finally { PDF.prototype.image = orig; }
  return calls[0];
}

t('export：封面按 crop 摆放（左图右文矩形 / 椭圆 / 整页），与前端 cropGeom 同一结果；z 放大、x/y 位移生效', async () => {
  const box = pt.COVER_BOX;
  const cases = [
    { name: '宽图 左图右文 居中', photo: WIDE, dim: [80, 40], cp: { shape: 'rect' }, box: box.left, bx: 96, by: 96, crop: { x: 0.5, y: 0.5, z: 1 } },
    { name: '宽图 左图右文 靠左', photo: WIDE, dim: [80, 40], cp: { shape: 'rect', crop: { x: 0, y: 0.5, z: 1 } }, box: box.left, bx: 96, by: 96, crop: { x: 0, y: 0.5, z: 1 } },
    { name: '竖图 左图右文 放大 2 倍 靠下', photo: TALL, dim: [40, 80], cp: { shape: 'rect', crop: { x: 0.3, y: 1, z: 2 } }, box: box.left, bx: 96, by: 96, crop: { x: 0.3, y: 1, z: 2 } },
    { name: '椭圆 与矩形同框', photo: WIDE, dim: [80, 40], cp: { shape: 'oval', crop: { x: 0.9, y: 0.1, z: 1.5 } }, box: box.left, bx: 96, by: 96, crop: { x: 0.9, y: 0.1, z: 1.5 } },
    { name: '竖图 整页 靠上', photo: TALL, dim: [40, 80], cp: { shape: 'rect', layout: 'full', crop: { x: 0.5, y: 0, z: 1 } }, box: box.full, bx: 0, by: 0, crop: { x: 0.5, y: 0, z: 1 } },
    { name: '宽图 整页 放大 3 倍', photo: WIDE, dim: [80, 40], cp: { shape: 'rect', layout: 'full', crop: { x: 1, y: 1, z: 3 } }, box: box.full, bx: 0, by: 0, crop: { x: 1, y: 1, z: 3 } }
  ];
  for (const c of cases) {
    seedExport({ coverPhoto: { fileID: FID(1), ...c.cp } });
    const fn = loadExport(c.photo);
    const got = await imageCalls(fn, { format: 'book', bookId: 'b1', pdfTheme: 'red_gold' });
    const g = pt.cropGeom(c.dim[0], c.dim[1], c.box.w, c.box.h, c.crop);
    near(got.w, g.iw, c.name + ' w'); near(got.h, g.ih, c.name + ' h');
    near(got.x, c.bx - g.ox, c.name + ' x'); near(got.y, c.by - g.oy, c.name + ' y');
  }
});

t('export：旧礼簿（九宫格 focus）出图位置与 v3.81.0 的 pdfkit cover + align/valign 一致；草稿 coverCrop 覆盖并校验', async () => {
  // v3.81.0 的做法：cover 缩放 + 对齐（left/center/right、top/center/bottom）；新旧映射在 z=1 时应落在同一位置
  const legacy = [
    { focus: { x: 0, y: 0 }, photo: WIDE, dim: [80, 40] }, { focus: { x: 2, y: 1 }, photo: WIDE, dim: [80, 40] },
    { focus: { x: 1, y: 2 }, photo: TALL, dim: [40, 80] }, { focus: { x: 1, y: 1 }, photo: TALL, dim: [40, 80] }
  ];
  const al = [0, 0.5, 1];
  for (const c of legacy) {
    seedExport({ coverPhoto: { fileID: FID(1), shape: 'rect', focus: c.focus } });
    const fn = loadExport(c.photo);
    const got = await imageCalls(fn, { format: 'book', bookId: 'b1', pdfTheme: 'red_gold' });
    const b = pt.COVER_BOX.left;
    const s = Math.max(b.w / c.dim[0], b.h / c.dim[1]);
    const iw = c.dim[0] * s, ih = c.dim[1] * s;
    near(got.x, 96 - al[c.focus.x] * (iw - b.w), 'legacy x');
    near(got.y, 96 - al[c.focus.y] * (ih - b.h), 'legacy y');
    near(got.w, iw, 'legacy w');
  }
  // 草稿 coverCrop 覆盖（预览，不写库）；非法值夹住
  seedExport({ coverPhoto: { fileID: FID(1), shape: 'rect' } });
  const fn = loadExport(WIDE);
  const got = await imageCalls(fn, { action: 'bookPreview', bookId: 'b1', coverCrop: { x: -4, y: 0.5, z: 50 } });
  const g = pt.cropGeom(80, 40, pt.COVER_BOX.left.w, pt.COVER_BOX.left.h, { x: 0, y: 0.5, z: 3 });
  near(got.w, g.iw, 'override w'); near(got.x, 96 - g.ox, 'override x');
});

t('export：coverCrop 草稿有权限且变化才写库（crop 形态），saveOnly 同样保存；默认值不落库', async () => {
  seedExport({ coverPhoto: { fileID: FID(1), shape: 'rect' } });
  const log = [];
  const origCol = db.collection.bind(db);
  db.collection = name => { const c = origCol(name); const od = c.doc; c.doc = id => { const d = od(id); d.update = async o => { log.push({ name, data: o.data }); return { stats: { updated: 1 } }; }; return d; }; return c; };
  try {
    const fn = loadExport(WIDE);
    let r = await quiet(() => fn.main({ format: 'book', bookId: 'b1', pdfTheme: 'red_gold', coverCrop: { x: 0.25, y: 0.75, z: 1.4 } }));
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(log.find(x => x.data.coverPhoto).data.coverPhoto.v, { fileID: FID(1), shape: 'rect', crop: { x: 0.25, y: 0.75, z: 1.4 } });
    log.length = 0;
    r = await quiet(() => fn.main({ format: 'book', bookId: 'b1', saveOnly: true, pdfTheme: 'red_gold', coverCrop: { x: 0.5, y: 0.5, z: 1 } }));
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(!log.some(x => x.data.coverPhoto), '与已存（默认）一致不写库');
    // 旧 focus 的礼簿：传同样的位置会改写为 crop（迁移）
    seedExport({ coverPhoto: { fileID: FID(1), shape: 'rect', focus: { x: 0, y: 2 } } });
    log.length = 0;
    r = await quiet(() => loadExport(WIDE).main({ format: 'book', bookId: 'b1', saveOnly: true, pdfTheme: 'red_gold', coverCrop: { x: 0, y: 1, z: 1 } }));
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(log.find(x => x.data.coverPhoto).data.coverPhoto.v, { fileID: FID(1), shape: 'rect', crop: { x: 0, y: 1, z: 1 } });
  } finally { db.collection = origCol; }
});

// ---------- 页面 ----------
test('页面：水印字在内页标签（封面只留合并提示）、预设下改水印转自定义、白事直接改；裁剪编辑器结构与手势', () => {
  const w = read('miniprogram/pages/booktheme/booktheme.wxml');
  const js = read('miniprogram/pages/booktheme/booktheme.js');
  const wss = read('miniprogram/pages/booktheme/booktheme.wxss');
  const tabs = w.split('<block wx:if="{{cur === 1}}">');
  const cover = tabs[0], inner = tabs[1].split('<block wx:if="{{cur === 2}}">')[0];
  assert.ok(!/class="cust-lb">水印字</.test(w), '自定义卡 / 白事卡里的水印字都已移走');
  assert.ok(inner.includes('<view class="section-title">水印字</view>') && inner.includes('bindtap="onMarkPick"'));
  assert.ok(inner.includes('isFuneral ? fMarks : marks') && inner.includes('整页照片封面除外'));
  assert.ok(cover.includes('水印：{{markName}} · 在「内页」标签修改'));
  assert.ok(/onMarkPick\(e\) \{[\s\S]*?if \(d\.isFuneral\) \{ this\.setData\(\{ 'fun\.mark': v \}\)[\s\S]*?pt\.expand\(d\.themeKey\)[\s\S]*?'cust\.mark': v/.test(js), '白事直接改；预设先 expand');
  assert.ok(/if \(!d\.premiumOk\) return vip\.explain\('PDF 主题', VIP_TIP\)/.test(js.split('onMarkPick(e)')[1].split('photoStyle(')[0]), '会员限制与字体一致');
  assert.ok(js.includes("'onCropDone', 'onFontPick', 'onMarkPick'"), '水印 / 裁剪计入未保存检测');
  // 整页照片封面不画水印（云端保持）
  assert.ok(read('cloudfunctions/export/index.js').includes("drawFrame(doc, wantFull ? { ...bt, mark: '' } : bt, c,"));
  // 裁剪编辑器：自写 touch 手势、catchtouchmove 防滚动穿透、滑块 / ± / 九宫格 / 复位、椭圆遮罩与整页文字区
  const sheet = w.slice(w.indexOf('<view class="mask" wx:if="{{cropOpen}}"'));
  ['catchtouchstart="onCropStart"', 'catchtouchmove="onCropMove"', 'catchtouchend="onCropEnd"', 'catchtouchcancel="onCropEnd"', 'catchtouchmove="noop"',
    'bindtap="onCropPlus"', 'bindtap="onCropMinus"', 'bindchange="onCropZ"', 'bindtap="onCropCell"', 'bindtap="onCropReset"', 'bindtap="onCropDone"', 'bindtap="onCropCancel"',
    'class="crop-oval"', 'class="crop-band"'].forEach(k => assert.ok(sheet.includes(k), k));
  assert.ok(!js.includes('movable') && !w.includes('movable-view'), '不使用 movable-view');
  assert.ok(js.includes('pt.panBy(') && js.includes('pt.zoomAt(') && js.includes("mode: 'pinch'") && js.includes("mode: 'pan'"));
  // 手势在 touches 数量变化时重新取基准（单指 / 双指切换）
  assert.ok(/const want = ts\.length >= 2 \? 'pinch' : 'pan';\s*if \(!g \|\| g\.mode !== want\) return this\.cropBase\(ts\);/.test(js));
  // 示意图与裁剪编辑器都用共用的 cropGeom；示意封面与 PDF 同比例（700 x 495 ≈ 1.414）
  assert.ok(js.includes('pt.cropGeom(d.photoDim.w, d.photoDim.h, box.w, box.h, d.coverCrop)') && js.includes('pt.cropGeom(d.photoDim.w, d.photoDim.h, fw, fh, d.cropEdit)'));
  const m = wss.match(/\.pc \{[^}]*width: (\d+)rpx; height: (\d+)rpx/);
  assert.ok(m && Math.abs(Number(m[1]) / Number(m[2]) - 841.89 / 595.28) < 0.01, '示意封面比例');
  // 小屏：编辑器框最大 560 x 620rpx、面板用全局 .sheet（带安全区）；弹窗按钮 ≤4 字
  assert.ok(js.includes('let fw = 560') && js.includes('fh > 620'));
  [...js.matchAll(/(?:confirmText|cancelText): '([^']+)'/g)].forEach(x => assert.ok(x[1].length <= 4, x[1]));
  assert.ok(/VERSION: '3\.\d+\.\d+'/.test(read('miniprogram/config.js')));
});

test('页面手势（假环境）：单指拖动、双指缩放、抬起一指回到单指、滑块 / ± / 九宫格', () => {
  const saved = { Page: global.Page, wx: global.wx, getApp: global.getApp };
  let page = null;
  global.Page = o => { page = o; };
  global.wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }), getWindowInfo: () => ({ windowWidth: 375 }), getStorageSync: () => '', cloud: {}, showToast() {} };
  global.getApp = () => ({ globalData: {} });
  try {
    const file = path.join(ROOT, 'miniprogram/pages/booktheme/booktheme.js');
    delete require.cache[file];
    require(file);
    const inst = Object.assign({}, page, { data: JSON.parse(JSON.stringify(page.data)) });
    inst.setData = o => Object.keys(o).forEach(k => { inst.data[k] = o[k]; });
    inst.refresh = () => {};
    Object.assign(inst.data, { coverSet: true, coverUrl: 'u', photoDim: { w: 3000, h: 2000 }, coverLayout: 'full', coverCrop: { x: 0.5, y: 0.5, z: 1 }, canSave: true });
    inst.onOpenCrop();
    assert.strictEqual(inst.data.cropOpen, true);
    assert.ok(Math.abs(inst._k - 2) < 1e-9, 'px 换算 rpx');
    const T = (x, y) => ({ clientX: x, clientY: y });
    // 单指拖动（整页版式：3000x2000 比 1.414 更宽，横向有余量）
    inst.onCropStart({ touches: [T(100, 100)] });
    inst.onCropMove({ touches: [T(140, 100)] });
    assert.ok(inst.data.cropEdit.x < 0.5, '向右拖，x 变小');
    assert.strictEqual(inst.data.cropEdit.y, 0.5, 'z=1 纵向无余量不动');
    // 双指放大
    inst.onCropEnd({ touches: [] });
    inst.onCropStart({ touches: [T(100, 100), T(200, 100)] });
    inst.onCropMove({ touches: [T(50, 100), T(250, 100)] });
    assert.ok(Math.abs(inst.data.cropEdit.z - 2) < 0.01, '间距翻倍 z≈2');
    inst.onCropMove({ touches: [T(0, 100), T(500, 100)] });
    assert.strictEqual(inst.data.cropEdit.z, 3, '最多 3 倍');
    // 抬起一指：回到单指拖动，不跳变
    const before = { ...inst.data.cropEdit };
    inst.onCropEnd({ touches: [T(0, 100)] });
    inst.onCropMove({ touches: [T(0, 100)] });
    assert.deepStrictEqual(inst.data.cropEdit, before, '换手指后第一次 move 只重取基准');
    inst.onCropMove({ touches: [T(20, 100)] });
    assert.notDeepStrictEqual(inst.data.cropEdit, before);
    // 滑块 / ± / 九宫格 / 复位
    inst.onCropZ({ detail: { value: 150 } });
    assert.strictEqual(inst.data.cropEdit.z, 1.5);
    inst.onCropPlus(); near(inst.data.cropEdit.z, 1.7);
    inst.onCropMinus(); inst.onCropMinus(); near(inst.data.cropEdit.z, 1.3);
    inst.onCropCell({ currentTarget: { dataset: { x: 2, y: 0 } } });
    assert.strictEqual(inst.data.cropEdit.x, 1); assert.strictEqual(inst.data.cropEdit.y, 0);
    near(inst.data.cropEdit.z, 1.3);
    inst.onCropReset();
    assert.deepStrictEqual(inst.data.cropEdit, { x: 0.5, y: 0.5, z: 1 });
    // 完成写回草稿；取消不改
    inst.onCropCell({ currentTarget: { dataset: { x: 0, y: 1 } } });
    inst.onCropCancel();
    assert.deepStrictEqual(inst.data.coverCrop, { x: 0.5, y: 0.5, z: 1 });
    inst.onCropDone();
    assert.deepStrictEqual(inst.data.coverCrop, { x: 0, y: 0.5, z: 1 });
    assert.strictEqual(inst.data.cropOpen, false);
  } finally { global.Page = saved.Page; global.wx = saved.wx; global.getApp = saved.getApp; }
});
