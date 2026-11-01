// v3.81.0：传统礼簿导出页重组（封面 / 内页 / 封底三标签、草稿统一保存、导出确认面板、只保存样式）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const themes = require('../cloudfunctions/export/themes.js');

const OWNER = 'o-owner';
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const FID = n => `cloud://env.b/covers/book-${OWNER}-${n}.jpg`;
const quiet = async fn => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

test('themes：封面草稿覆盖项只取传了的、校验后叠在已存设置上；落库形态默认值不落库', () => {
  assert.deepStrictEqual(themes.coverOverride({}), {});
  assert.deepStrictEqual(themes.coverOverride({ coverLayout: 'full', coverFocus: { x: 2, y: 0 } }), { layout: 'full', crop: { x: 1, y: 0, z: 1 } }); // 旧参数 coverFocus 映射成 crop
  assert.deepStrictEqual(themes.coverOverride({ coverLayout: 'evil', coverScrim: 'x', coverShape: 5, coverFocus: { x: 9, y: -3 } }), { layout: 'left', scrim: 'gradient', shape: 'rect', crop: { x: 0.5, y: 0.5, z: 1 } });
  const old = { fileID: FID(1), shape: 'oval', layout: 'full', focus: { x: 0, y: 2 } };
  assert.deepStrictEqual(themes.mergeCover(old, { scrim: 'block' }), { shape: 'oval', layout: 'full', scrim: 'block', crop: { x: 0, y: 1, z: 1 } });
  assert.deepStrictEqual(themes.mergeCover(null, {}), { shape: 'rect', layout: 'left', scrim: 'gradient', crop: { x: 0.5, y: 0.5, z: 1 } });
  assert.deepStrictEqual(themes.coverDoc(FID(1), themes.mergeCover(null, {})), { fileID: FID(1), shape: 'rect' });
  assert.deepStrictEqual(themes.coverDoc(FID(1), themes.mergeCover(old, {})), { fileID: FID(1), shape: 'oval', layout: 'full', crop: { x: 0, y: 1, z: 1 } });
  // 与 books 云函数落库形态一致（同一份规则）
  const b = read('cloudfunctions/books/index.js');
  assert.ok(b.includes("if (v.layout === 'full') d.layout = 'full';") && b.includes("if (v.scrim === 'block') d.scrim = 'block';"));
});

// ---------- export ----------
let haveDeps = true;
try { require.resolve('pdfkit'); } catch (e) { haveDeps = false; }
const t = (name, fn) => test(name, async () => (haveDeps ? fn() : 'SKIP 未安装 pdfkit'));
const F = require('../cloudfunctions/export/fonts.js');
const fontFiles = Object.fromEntries(Object.entries(F.FONT_FILES).map(([k, n]) => [k, haveDeps ? fs.readFileSync(path.join(ROOT, 'tools', 'fonts', n)) : null]));
const fontMeta = () => ({ _id: 'export_fonts', fonts: Object.fromEntries(Object.keys(fontFiles).map(k => [k, { fileID: 'cloud://env.b/export-fonts/' + F.FONT_FILES[k], name: F.FONT_FILES[k], size: fontFiles[k].length }])) });
const REAL_JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const hasImg = u => /\/Subtype \/Image/.test(u.content.toString('latin1'));

function seed(book = {}, withRecords = true) {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '测试主家', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }, { openid: 'u-c1', currentAid: 'acc1' }, { openid: 'u-c2', currentAid: 'acc1' }])
    .seed('members', [
      { _id: 'm1', aid: 'acc1', memberOpenid: 'u-c1', role: 'clerk', allBooks: true, perms: ['export'] }, // 只有导出，没有管理礼簿
      { _id: 'm2', aid: 'acc1', memberOpenid: 'u-c2', role: 'clerk', allBooks: true, perms: ['export', 'books'] }
    ])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '测试礼簿', type: 'wedding', date: '2026-10-01', location: '某酒店', ...book }])
    .seed('records', withRecords ? Array.from({ length: 3 }, (_, i) => ({
      _id: 'r' + i, ownerOpenid: OWNER, bookId: 'b1', status: 'paid', payDay: '2026-10-01', payerName: '张三' + i, amount: 100 + i,
      relation: '朋友', payMethod: 'wechat', createdAt: new Date(2026, 9, 1, 10, i), paidAt: new Date(2026, 9, 1, 10, i)
    })) : [])
    .seed('settings', [fontMeta()]);
  state.openid = OWNER;
  state.uploads.length = 0;
}
function load() {
  process.env.HLJ_FONT_TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hlj-v3810-'));
  const calls = [];
  state.download = async fileID => {
    calls.push(fileID);
    if (fileID.includes('/covers/')) return REAL_JPG;
    return fontFiles[Object.keys(F.FONT_FILES).find(k => fileID.endsWith(F.FONT_FILES[k]))];
  };
  const log = [];
  const origCol = db.collection.bind(db);
  db.collection = name => {
    const c = origCol(name);
    const od = c.doc;
    c.doc = id => { const d = od(id); d.update = async o => { log.push({ name, id, data: o.data }); return { stats: { updated: 1 } }; }; return d; };
    return c;
  };
  return { fn: loadFunction('export'), calls, log, restore: () => { db.collection = origCol; } };
}
const as = async (L, openid, body) => { state.openid = openid; return quiet(() => L.fn.main(body)); };
const bookUpdates = L => L.log.filter(x => x.name === 'books');
const CP = { fileID: FID(1), shape: 'rect' };

t('只保存样式：需要「管理礼簿」权限；有权限时保存主题 / 纹样 / 尾页 / 装订 / 封面设置，不生成文件、不要求有礼金', async () => {
  seed({ coverPhoto: CP }, false);
  const L = load();
  try {
    const body = { format: 'book', bookId: 'b1', saveOnly: true, pdfTheme: 'peach', pdfDeco: 'lotus', pdfBind: 'single', pdfBack: { on: true, footer: '谢谢', sign: true, brand: false },
      coverLayout: 'full', coverScrim: 'block', coverCrop: { x: 1, y: 0, z: 1.5 }, coverShape: 'oval' };
    // 只有导出权限的记账人：拒绝，什么都不写
    let r = await as(L, 'u-c1', body);
    assert.notStrictEqual(r.code, 0);
    assert.ok(/权限/.test(r.msg), r.msg);
    assert.strictEqual(bookUpdates(L).length, 0);
    // 有「管理礼簿」的记账人：保存成功
    r = await as(L, 'u-c2', body);
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(r.data, { saved: true });
    assert.strictEqual(state.uploads.length, 0, '不生成文件');
    const ups = bookUpdates(L);
    const th = ups.find(x => x.data.pdfTheme).data.pdfTheme.v;
    assert.strictEqual(th.key, 'peach'); assert.strictEqual(th.deco, 'lotus'); assert.strictEqual(th.bind, 'single'); assert.strictEqual(th.back.footer, '谢谢');
    const cp = ups.find(x => x.data.coverPhoto).data.coverPhoto.v;
    assert.deepStrictEqual(cp, { fileID: FID(1), shape: 'oval', layout: 'full', scrim: 'block', crop: { x: 1, y: 0, z: 1.5 } });
    // 主家本人同样可以
    L.log.length = 0;
    r = await as(L, OWNER, body);
    assert.strictEqual(r.code, 0, r.msg);
    // 非法的版式 / 焦点被校验，不写入非法值
    L.log.length = 0;
    r = await as(L, OWNER, { ...body, coverLayout: 'evil', coverCrop: 'bad', coverFocus: { x: 99, y: 'z' }, coverScrim: 'x', coverShape: 'x' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(!bookUpdates(L).some(x => x.data.coverPhoto), '非法值被校验成默认，与已存一致，不写库');
  } finally { L.restore(); }
});

t('只保存样式：白事不写封面照片设置；会员项被限制时仍按套餐校验；传统礼簿 saveOnly 之外的导出不受影响', async () => {
  seed({ type: 'funeral', coverPhoto: CP }, false);
  let L = load();
  try {
    const r = await as(L, OWNER, { format: 'book', bookId: 'b1', saveOnly: true, pdfTheme: 'custom', pdfCustom: {}, pdfDeco: 'pine', coverLayout: 'full' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(!bookUpdates(L).some(x => x.data.coverPhoto), '白事不动 coverPhoto');
    assert.strictEqual(bookUpdates(L).find(x => x.data.pdfTheme).data.pdfTheme.v.deco, 'pine');
  } finally { L.restore(); }
  // 套餐关闭会员主题：不能新选会员预设（与导出一致）
  seed({}, false);
  db.seed('settings', [{ _id: 'plans', free: { name: '免费版', features: { pdfThemePremium: false } } }]);
  L = load();
  try {
    const r = await as(L, OWNER, { format: 'book', bookId: 'b1', saveOnly: true, pdfTheme: 'wine_gold' });
    assert.notStrictEqual(r.code, 0);
    assert.ok(/会员/.test(r.msg), r.msg);
  } finally { L.restore(); }
});

t('导出带草稿覆盖项：有权限且有变化才写 coverPhoto；无权限只用于本次；预览不写库但按草稿出图', async () => {
  seed({ coverPhoto: CP });
  let L = load();
  try {
    // 主家：覆盖项生效并写库
    let r = await as(L, OWNER, { format: 'book', bookId: 'b1', pdfTheme: 'red_gold', coverLayout: 'full', coverFocus: { x: 0, y: 2 } });
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(hasImg(state.uploads[0]));
    assert.deepStrictEqual(bookUpdates(L).find(x => x.data.coverPhoto).data.coverPhoto.v, { fileID: FID(1), shape: 'rect', layout: 'full', crop: { x: 0, y: 1, z: 1 } });
    // 与已存一致：不写
    L.log.length = 0;
    seed({ coverPhoto: { fileID: FID(1), shape: 'rect', layout: 'full', crop: { x: 0, y: 1, z: 1 } } });
    L.restore(); L = load();
    r = await as(L, OWNER, { format: 'book', bookId: 'b1', pdfTheme: 'red_gold', coverLayout: 'full', coverFocus: { x: 0, y: 2 } });
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(!bookUpdates(L).some(x => x.data.coverPhoto), '没有变化不写库');
    // 没有「管理礼簿」权限：导出成功、用草稿出图，但不写 coverPhoto
    seed({ coverPhoto: CP });
    L.restore(); L = load();
    r = await as(L, 'u-c1', { format: 'book', bookId: 'b1', pdfTheme: 'red_gold', coverLayout: 'full' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(hasImg(state.uploads[0]));
    assert.ok(!bookUpdates(L).some(x => x.data.coverPhoto || x.data.pdfTheme), '无权限不写库');
    // 预览：不写库，仍出图
    seed({ coverPhoto: CP });
    L.restore(); L = load();
    r = await as(L, OWNER, { action: 'bookPreview', bookId: 'b1', coverLayout: 'full', coverScrim: 'block' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(hasImg(state.uploads[0]));
    assert.strictEqual(bookUpdates(L).length, 0);
    // 去照片 + 草稿：本次无图，库里不动（打印方式不保存）
    seed({ coverPhoto: CP });
    L.restore(); L = load();
    r = await as(L, OWNER, { format: 'book', bookId: 'b1', pdfTheme: 'red_gold', coverPrint: 'none', coverLayout: 'full' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.ok(!hasImg(state.uploads[0]));
  } finally { L.restore(); }
});

// ---------- 页面 ----------
test('页面重组：标题、三标签、吸顶示意图、确认面板、只保存样式、字体在内页、机构称谓', () => {
  assert.ok(/"navigationBarTitleText": "传统礼簿导出"/.test(read('miniprogram/pages/booktheme/booktheme.json')));
  const w = read('miniprogram/pages/booktheme/booktheme.wxml');
  const js = read('miniprogram/pages/booktheme/booktheme.js');
  const wss = read('miniprogram/pages/booktheme/booktheme.wxss');
  // 三个标签各自的内容区
  ['cur === 0', 'cur === 1', 'cur === 2'].forEach(c => assert.ok(w.includes(`<block wx:if="{{${c}}}">`), c));
  assert.ok(/position: sticky/.test(wss) && w.includes('class="sticky-pv"'), '示意图吸顶');
  const tabs = w.split('<block wx:if="{{cur === 1}}">');
  const cover = tabs[0].split('<block wx:if="{{cur === 0}}">')[1];
  const inner = tabs[1].split('<block wx:if="{{cur === 2}}">')[0];
  const back = tabs[1].split('<block wx:if="{{cur === 2}}">')[1];
  // 封面：样式 -> 纹样 -> 照片，顺序固定；字体不在封面，只有提示行
  const iTheme = cover.indexOf('>主题</view>'), iDeco = cover.indexOf('>封面纹样</view>'), iPhoto = cover.indexOf('>封面照片');
  assert.ok(iTheme >= 0 && iTheme < iDeco && iDeco < iPhoto, '样式 → 纹样 → 照片');
  assert.ok(cover.includes('字体：{{fontName}}　水印：{{markName}} · 在「内页」标签修改'));
  assert.ok(!/class="cust-lb">水印字</.test(cover) && !cover.includes('onMarkPick'), '水印字不在封面标签');
  assert.ok(!/class="cust-lb">字体</.test(cover), '封面里没有字体选项');
  assert.ok(!cover.includes('onPrint'), '打印方式不在封面标签');
  assert.ok(inner.includes('onFontPick') && inner.includes('onMarkPick') && inner.includes('整页照片封面除外') && inner.includes('onBind') && !inner.includes('onBackSwitch'));
  assert.ok(back.includes('onBackSwitch') && !back.includes('onBind'));
  // 导出确认面板：打印方式只在面板里，写明只用于本次；保存说明；只有设了照片才显示
  const sheet = w.slice(w.indexOf('class="mask"'));
  assert.ok(sheet.includes('onPrint') && sheet.includes('只用于本次，不保存') && sheet.includes('wx:if="{{coverSet && !isFuneral}}"'));
  assert.ok(sheet.includes('样式将保存到本礼簿') && sheet.includes('仅本次'));
  // 底栏：预览 / 保存样式（仅有权限）/ 导出
  assert.ok(/class="btn-outline sv-btn" wx:if="\{\{canSave\}\}"/.test(w) && w.includes('bindtap="onSaveStyle"') && w.includes('bindtap="onExport"') && w.includes('bindtap="onPreview"'));
  assert.ok(!w.includes('onConfirm'));
  // 机构称谓与一次性文案
  assert.ok(w.includes('<wxs module="o" src="/utils/orgtext.wxs"></wxs>') && w.includes("o.t('样式将保存到本礼簿', org)"));
  assert.ok(js.includes("orgtext.t('礼簿不存在', org)") && js.includes('org,'));
  // 保存逻辑：形状 / 版式 / 托底 / 焦点不再立即保存（草稿），随参数提交
  assert.ok(!js.includes('saveCoverOpts'));
  assert.ok(/Object\.assign\(params, \{ coverShape: d\.coverShape, coverLayout: d\.coverLayout, coverScrim: d\.coverScrim, coverCrop: d\.coverCrop \}\)/.test(js));
  assert.ok(js.includes('params.saveOnly = true') && js.includes("params.format = 'book'"));
  // 照片上传 / 移除仍立即生效
  assert.ok(js.includes('req.bookSetCover(d.id, fileID,') && js.includes("req.bookSetCover(d.id, '')"));
  // 打印方式不保存、不随「保存样式」；预览只有设了照片才弹面板
  assert.ok(/onPreview\(\) \{[\s\S]*?coverSet && !d\.isFuneral\) return this\.setData\(\{ sheet: 'preview' \}\)/.test(js));
  // 弹窗按钮 ≤4 字、success toast ≤7 字
  [...js.matchAll(/(?:confirmText|cancelText): '([^']+)'/g)].forEach(m => assert.ok(m[1].length <= 4, m[1]));
  [...js.matchAll(/title: '([^']+)', icon: 'success'/g)].forEach(m => assert.ok(m[1].length <= 7, m[1]));
  // 底栏避开安全区（全局 .bottom-bar 已带 safe-area）；面板用全局 .sheet（同样带安全区）
  assert.ok(/\.bottom-bar \{[^}]*safe-area-inset-bottom/.test(read('miniprogram/app.wxss')));
  assert.ok(/VERSION: '3\.\d+\.\d+'/.test(read('miniprogram/config.js')));
});

test('页面草稿检测：只有真正改动才算未保存，改回原样即清除；导出 / 保存样式后清除', () => {
  // 在最小的假环境里加载页面对象，直接调用 snap / touch / clean
  const saved = { Page: global.Page, wx: global.wx, getApp: global.getApp };
  let page = null;
  global.Page = o => { page = o; };
  global.wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }), enableAlertBeforeUnload: o => { global.__alert = o; }, disableAlertBeforeUnload: () => { global.__alert = null; }, getStorageSync: () => '', cloud: {} };
  global.getApp = () => ({ globalData: {} });
  try {
    const file = path.join(ROOT, 'miniprogram/pages/booktheme/booktheme.js');
    delete require.cache[file];
    require(file);
    const inst = Object.assign({}, page, { data: JSON.parse(JSON.stringify(page.data)) });
    inst.setData = o => Object.keys(o).forEach(k => { if (k.includes('.')) { const [a, b] = k.split('.'); inst.data[a][b] = o[k]; } else inst.data[k] = o[k]; });
    inst.refresh = () => {};
    inst.data.canSave = true;
    inst._base = inst.snap();
    assert.strictEqual(inst.data.dirty, false);
    inst.data.deco = 'lotus';
    inst.touch();
    assert.strictEqual(inst.data.dirty, true);
    assert.ok(global.__alert && /没保存/.test(global.__alert.message), '有改动时离开提示');
    inst.data.deco = '';
    inst.touch();
    assert.strictEqual(inst.data.dirty, false, '改回原样不算改动');
    inst.data.coverLayout = 'full';
    inst.touch();
    assert.strictEqual(inst.data.dirty, true);
    inst.clean();
    assert.strictEqual(inst.data.dirty, false);
    assert.strictEqual(global.__alert, null);
    inst.touch();
    assert.strictEqual(inst.data.dirty, false, '保存后以当前为基准');
    // 打印方式、照片文件状态不属于草稿
    inst.data.coverPrint = 'fade'; inst.data.coverSet = true;
    inst.touch();
    assert.strictEqual(inst.data.dirty, false);
  } finally {
    global.Page = saved.Page; global.wx = saved.wx; global.getApp = saved.getApp; delete global.__alert;
  }
});
