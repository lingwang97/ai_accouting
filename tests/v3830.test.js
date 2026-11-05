// v3.83.0：字体实时预览（预览小字体、取临时链接、懒加载、会员字体试看）与封面纹样「囍字」（矢量路径）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const themes = require('../cloudfunctions/export/themes.js');
const pt = require('../miniprogram/pages/booktheme/pdftheme.js');

const OWNER = 'o-owner';
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const quiet = async fn => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

// ---------- 囍字纹样 ----------
test('囍字纹样：清单前后端一致；喜事默认囍字；白事不提供；喜字保留', () => {
  assert.ok(themes.DECOS.includes('shuangxi') && themes.DECOS.includes('xi'));
  assert.ok(themes.DECOS.indexOf('shuangxi') === themes.DECOS.indexOf('xi') + 1);
  assert.ok(!themes.FUNERAL_DECOS.includes('shuangxi'));
  assert.deepStrictEqual(pt.DECOS.map(x => x.k), themes.DECOS);
  assert.strictEqual(pt.DECOS.find(x => x.k === 'shuangxi').n, '囍字');
  assert.strictEqual(pt.DECOS.find(x => x.k === 'xi').n, '喜字');
  assert.strictEqual(themes.DECO_DEFAULTS.wedding, 'shuangxi');
  assert.deepStrictEqual(pt.DECO_DEFAULTS, themes.DECO_DEFAULTS);
  assert.strictEqual(pt.DECO_TXT.shuangxi, '囍');
  // 其他事由默认不变
  assert.deepStrictEqual({ ...themes.DECO_DEFAULTS, wedding: '' }, { wedding: '', birthday: 'shou', baby: 'kids', house: 'fangsheng', funeral: 'none', other: 'band_huiwen' });
  assert.strictEqual(themes.decoOf('', 'wedding'), 'shuangxi');
  assert.strictEqual(themes.decoOf('xi', 'wedding'), 'xi', '已选喜字的保持喜字');
  assert.strictEqual(themes.decoOf('shuangxi', 'birthday'), 'shuangxi', '其他事由也可以选囍字');
  assert.strictEqual(themes.sanitizeDeco('shuangxi', false), 'shuangxi');
  assert.strictEqual(themes.sanitizeDeco('shuangxi', true), '', '白事拒绝');
  assert.strictEqual(themes.decoOf('shuangxi', 'funeral'), '', '白事传囍字 -> 默认（无）');
  assert.strictEqual(pt.decoOf('shuangxi', 'funeral'), themes.decoOf('shuangxi', 'funeral'));
  assert.strictEqual(pt.decoOf('', 'wedding'), 'shuangxi');
  assert.ok(read('miniprogram/pages/booktheme/booktheme.wxml').includes('喜事用囍字'));
});

test('囍字路径数据：矢量轮廓（非空、命令合法、范围合理）、注明来源与许可，生成脚本在仓库里', () => {
  const XI = require('../cloudfunctions/export/xipath.js');
  assert.strictEqual(XI.bbox.length, 4);
  assert.ok(XI.bbox.every(Number.isFinite) && XI.bbox[2] > XI.bbox[0] && XI.bbox[3] > XI.bbox[1]);
  assert.ok(typeof XI.d === 'string' && XI.d.length > 1000 && XI.d.startsWith('M'));
  assert.ok(/^[MmLlHhVvQqCcZz0-9\-\s.,]+$/.test(XI.d), '只含 SVG 路径命令与数字');
  const nums = XI.d.match(/-?\d+/g).map(Number);
  assert.ok(nums.every(n => n > -300 && n < 1300), '坐标在 1000 单位 em 附近');
  assert.ok((XI.d.match(/Z/g) || []).length >= 6, '多个封闭轮廓（囍有很多笔画区域）');
  const src = read('cloudfunctions/export/xipath.js');
  assert.ok(/Noto Serif SC/.test(src) && /SIL Open Font License/.test(src) && /gen_xi_path\.py/.test(src), '注明来源与许可');
  assert.ok(fs.existsSync(path.join(ROOT, 'tools/gen_xi_path.py')));
  assert.ok(/doc\.save\(\)\.scale\(k, -k\)[^\n]*\.path\(XI\.d\)\.fill\('nonzero'\)/.test(read('cloudfunctions/export/index.js')));
});

let haveDeps = true;
try { require.resolve('pdfkit'); } catch (e) { haveDeps = false; }
const t = (name, fn) => test(name, async () => (haveDeps ? fn() : 'SKIP 未安装 pdfkit'));
const F = require('../cloudfunctions/export/fonts.js');
const fontFiles = Object.fromEntries(Object.entries(F.FONT_FILES).map(([k, n]) => [k, haveDeps ? fs.readFileSync(path.join(ROOT, 'tools', 'fonts', n)) : null]));

t('囍字纹样：黑体 / 宋体 / 毛笔三种主题都出图，用 doc.path 画（不依赖字体字形），白事忽略', async () => {
  const fn = loadFunction('export');
  const T = fn._test;
  const XI = require('../cloudfunctions/export/xipath.js');
  const PDF = require('pdfkit');
  const origPath = PDF.prototype.path;
  const origText = PDF.prototype.text;
  const rows = [{ payerName: '张三', amount: 100, payMethod: 'wechat', payDay: '2026-10-01', relation: '朋友' }];
  try {
    for (const font of ['sans', 'serif', 'brush']) {
      let drewXi = false, texts = [];
      PDF.prototype.path = function (d) { if (d === XI.d) drewXi = true; return origPath.apply(this, arguments); };
      PDF.prototype.text = function (s) { texts.push(String(s)); return origText.apply(this, arguments); };
      const book = { _id: 'b1', name: '测试', type: 'wedding', date: '2026-10-01', location: '某地' };
      const custom = { main: '#B71C1C', accent: '#D4AF37', cover: '#F8E7B0', font, pattern: 'double', mark: '', footer: '', title: '' };
      const meta = T.buildMeta(rows, { account: { accountName: '主家' }, book, startDay: '', endDay: '', themeName: '', pdfThemeKey: 'custom', pdfCustom: custom, pdfDeco: 'shuangxi', premiumOk: true });
      assert.strictEqual(meta.deco, 'shuangxi');
      const plan = F.planFor('book', meta.bt);
      // 只提供黑体（宋体 / 毛笔不可用）也要能出图：囍字不依赖运行时字体
      const buffers = font === 'sans' ? { sans: fontFiles.sans } : { sans: fontFiles.sans, [font]: fontFiles[font] };
      const got = plan.resolve({ buffers, failed: {} });
      const buf = await quiet(() => T.buildBook(rows, meta, got.fonts));
      assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-', font);
      assert.ok(drewXi, `${font} 主题：用矢量路径画囍`);
      assert.ok(!texts.includes('囍'), `${font} 主题：封面纹样不用「囍」字形文字`);
    }
    // 没有宋体时（降级）也能画
    PDF.prototype.path = function (d) { if (d === XI.d) drewXi2 = true; return origPath.apply(this, arguments); };
    var drewXi2 = false;
    const meta2 = T.buildMeta(rows, { account: { accountName: '主家' }, book: { _id: 'b1', name: '测试', type: 'wedding' }, startDay: '', endDay: '', themeName: '', pdfThemeKey: 'wine_gold', pdfCustom: null, pdfDeco: '', premiumOk: true });
    assert.strictEqual(meta2.deco, 'shuangxi', '喜事默认纹样');
    const plan2 = F.planFor('book', meta2.bt);
    const got2 = plan2.resolve({ buffers: { sans: fontFiles.sans }, failed: { serif: new Error('x') } });
    assert.ok(got2.notes.length > 0 || got2.dropMark !== undefined);
    await quiet(() => T.buildBook(rows, meta2, got2.fonts));
    assert.ok(drewXi2, '宋体不可用时喜事默认囍字纹样照常绘制');
    // 白事：传囍字被忽略
    const fmeta = T.buildMeta(rows, { account: { accountName: '主家' }, book: { _id: 'b1', name: '测试', type: 'funeral' }, startDay: '', endDay: '', themeName: '', pdfThemeKey: 'custom', pdfCustom: themes.sanitizeFuneral({}), pdfDeco: 'shuangxi', premiumOk: true });
    assert.strictEqual(fmeta.deco, '', '白事没有囍字');
  } finally { PDF.prototype.path = origPath; PDF.prototype.text = origText; }
});

// ---------- 预览字体：fontPreview ----------
function seedAcc(opts = {}) {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '主家', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }, { openid: 'u-c1', currentAid: 'acc1' }, { openid: 'u-c2', currentAid: 'acc1' }, { openid: 'u-v', currentAid: 'acc1' }, { openid: 'u-none' }])
    .seed('members', [
      { _id: 'm1', aid: 'acc1', memberOpenid: 'u-c1', role: 'clerk', allBooks: true, perms: ['confirm'] }, // 没有导出权限
      { _id: 'm2', aid: 'acc1', memberOpenid: 'u-c2', role: 'clerk', allBooks: true, perms: ['export'] },
      { _id: 'm3', aid: 'acc1', memberOpenid: 'u-v', role: 'viewer', bookIds: ['b1'] }
    ])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '礼簿', type: 'wedding' }]);
  if (opts.meta !== false) {
    db.seed('settings', [opts.meta || { _id: 'preview_fonts', fonts: {
      sans: { fileID: 'cloud://env.b/preview-fonts/NotoSansSC-Preview.ttf', size: 100, sha256: 'aaaaaaaa11112222' },
      serif: { fileID: 'cloud://env.b/preview-fonts/NotoSerifSC-Preview.ttf', size: 200, sha256: 'bbbbbbbb11112222' },
      brush: { fileID: 'cloud://env.b/preview-fonts/MaShanZheng-Preview.ttf', size: 300, sha256: 'cccccccc11112222' }
    } }]);
  }
}
const callExport = async (openid, body) => { state.openid = openid; return quiet(() => loadFunction('export').main(body)); };

test('fontPreview：返回 https 临时链接 + fileID（v3.83.1，前端 downloadFile 用）；主家、有导出权限的记账人、家人共享可取；无导出权限与无账户拒绝', async () => {
  seedAcc();
  const origTmp = sdk.getTempFileURL;
  sdk.getTempFileURL = async o => ({ fileList: o.fileList.map(f => ({ fileID: f, status: 0, tempFileURL: 'https://bucket.tcb.qcloud.la/' + f.split('/').pop() + '?sign=x' })) });
  try {
    let r = await callExport(OWNER, { action: 'fontPreview' });
    assert.strictEqual(r.code, 0, r.msg);
    assert.strictEqual(r.data.ready, true);
    assert.deepStrictEqual(Object.keys(r.data.fonts).sort(), ['brush', 'sans', 'serif']);
    Object.values(r.data.fonts).forEach(f => { assert.ok(/^https:\/\//.test(f.url)); assert.deepStrictEqual(Object.keys(f).sort(), ['fileID', 'size', 'url', 'v']); assert.ok(/^cloud:\/\//.test(f.fileID)); });
    assert.strictEqual(r.data.fonts.sans.fileID, 'cloud://env.b/preview-fonts/NotoSansSC-Preview.ttf', 'fileID 与登记一致');
    assert.strictEqual(r.data.fonts.sans.v, 'aaaaaaaa');
    const json = JSON.stringify(r.data);
    assert.ok(!/openid/i.test(json) && !json.includes('sha256') && !json.includes('_id'), '不返回 openid / sha256 / 文档内部字段');
    assert.strictEqual((await callExport('u-c2', { action: 'fontPreview' })).code, 0, '有导出权限的记账人');
    assert.strictEqual((await callExport('u-v', { action: 'fontPreview' })).code, 0, '家人共享');
    r = await callExport('u-c1', { action: 'fontPreview' });
    assert.notStrictEqual(r.code, 0); assert.ok(/导出权限/.test(r.msg), r.msg);
    r = await callExport('u-none', { action: 'fontPreview' });
    assert.notStrictEqual(r.code, 0);
  } finally { sdk.getTempFileURL = origTmp; }
});

test('fontPreview：没上传 / 伪造登记（带 _openid）/ 取链接失败 -> ready=false，不报错', async () => {
  const origTmp = sdk.getTempFileURL;
  try {
    seedAcc({ meta: false });
    let r = await callExport(OWNER, { action: 'fontPreview' });
    assert.deepStrictEqual(r.data, { ready: false, fonts: {} });
    seedAcc({ meta: { _id: 'preview_fonts', _openid: 'forged', fonts: { sans: { fileID: 'cloud://x/y.ttf', sha256: 'z' } } } });
    r = await callExport(OWNER, { action: 'fontPreview' });
    assert.strictEqual(r.data.ready, false, '伪造的登记忽略');
    seedAcc();
    sdk.getTempFileURL = async () => { throw new Error('boom'); };
    r = await callExport(OWNER, { action: 'fontPreview' });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.data.ready, false);
    // 非 https 链接不返回
    sdk.getTempFileURL = async o => ({ fileList: o.fileList.map(f => ({ fileID: f, status: 0, tempFileURL: 'http://insecure/x' })) });
    r = await callExport(OWNER, { action: 'fontPreview' });
    assert.deepStrictEqual(r.data, { ready: false, fonts: {} });
  } finally { sdk.getTempFileURL = origTmp; }
});

// ---------- 预览小字体文件 / fontsetup / 系统检查 ----------
/** 最小的 TTF cmap 读取（格式 4 / 12），检查字库里有没有某个字 */
function ttfHas(buf, ch) {
  const cp = ch.codePointAt(0);
  const n = buf.readUInt16BE(4);
  let off = 0;
  for (let i = 0; i < n; i++) { const o = 12 + i * 16; if (buf.toString('ascii', o, o + 4) === 'cmap') off = buf.readUInt32BE(o + 8); }
  const sub = buf.readUInt16BE(off + 2);
  for (let i = 0; i < sub; i++) {
    const so = off + buf.readUInt32BE(off + 4 + i * 8 + 4);
    const fmt = buf.readUInt16BE(so);
    if (fmt === 12) {
      const g = buf.readUInt32BE(so + 12);
      for (let j = 0; j < g; j++) { const p = so + 16 + j * 12; if (cp >= buf.readUInt32BE(p) && cp <= buf.readUInt32BE(p + 4)) return true; }
    } else if (fmt === 4 && cp < 0x10000) {
      const segX2 = buf.readUInt16BE(so + 6), end = so + 14, start = end + segX2 + 2;
      for (let s = 0; s < segX2; s += 2) { if (cp >= buf.readUInt16BE(start + s) && cp <= buf.readUInt16BE(end + s) && buf.readUInt16BE(end + s) !== 0xffff) return true; }
    }
  }
  return false;
}

test('预览小字体：约 800 常用字、体积适中；宋体含「囍」，三份都含「喜」「礼」「簿」和数字；生成脚本与打包脚本在仓库里', () => {
  const dir = path.join(ROOT, 'tools/fonts/preview');
  const files = { sans: 'NotoSansSC-Preview.ttf', serif: 'NotoSerifSC-Preview.ttf', brush: 'MaShanZheng-Preview.ttf' };
  Object.entries(files).forEach(([k, n]) => {
    const buf = fs.readFileSync(path.join(dir, n));
    assert.ok(buf.length > 50 * 1024 && buf.length < 800 * 1024, `${k} 体积 ${buf.length}`);
    ['喜', '礼', '簿', '李', '张', '0', '9', '元'].forEach(ch => assert.ok(ttfHas(buf, ch), `${k} 缺 ${ch}`));
    assert.ok(!ttfHas(buf, '龘'), `${k} 不含生僻字（子集生效）`);
    // 主要常用字（子集目标 ~800 字）
    const names = [...'王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜'];
    const hit = names.filter(ch => ttfHas(buf, ch)).length;
    assert.strictEqual(hit, names.length, `${k} 常见姓氏全部覆盖（${hit}/${names.length}）`);
  });
  assert.ok(ttfHas(fs.readFileSync(path.join(dir, files.serif)), '囍'), '宋体预览子集必须有囍');
  assert.ok(!ttfHas(fs.readFileSync(path.join(dir, files.sans)), '囍'), '黑体字库本来就没有囍');
  assert.ok(fs.existsSync(path.join(ROOT, 'tools/gen_preview_fonts.py')));
  const gen = read('tools/gen_font_js.py');
  assert.ok(gen.includes('--preview') && gen.includes('pvfont-serif.js'));
  assert.ok(/pvfont-\*\.js/.test(read('.gitignore')), '打包出来的 base64 模块不入库');
});

test('fontsetup.uploadPreview：仅管理员；上传到 preview-fonts/ 并校验后登记 settings.preview_fonts（不覆盖 export_fonts）', async () => {
  const pv = ['sans', 'serif', 'brush'].map(k => path.join(ROOT, `cloudfunctions/fontsetup/pvfont-${k}.js`));
  if (!pv.every(f => fs.existsSync(f))) return 'SKIP 没有生成 pvfont-*.js（python tools/gen_font_js.py --preview）';
  db.reset().seed('settings', [{ _id: 'admins', openids: ['o-admin'] }, { _id: 'export_fonts', fonts: { sans: { fileID: 'cloud://e/a' } } }]);
  db.persist = true;
  const stored = {};
  const origUp = sdk.uploadFile, origDown = state.download;
  sdk.uploadFile = async o => { const id = 'cloud://test/' + o.cloudPath; stored[id] = o.fileContent; state.uploads.push({ cloudPath: o.cloudPath }); return { fileID: id }; };
  state.download = async id => stored[id];
  state.uploads.length = 0;
  try {
    const fn = loadFunction('fontsetup');
    state.openid = 'o-nobody';
    let r = await fn.main({ action: 'uploadPreview' });
    assert.notStrictEqual(r.code, 0); assert.ok(/管理员/.test(r.msg));
    state.openid = 'o-admin';
    r = await quiet(() => fn.main({ action: 'uploadPreview' }));
    assert.strictEqual(r.code, 0, r.msg);
    assert.deepStrictEqual(state.uploads.map(u => u.cloudPath).sort(), ['preview-fonts/MaShanZheng-Preview.ttf', 'preview-fonts/NotoSansSC-Preview.ttf', 'preview-fonts/NotoSerifSC-Preview.ttf']);
    const doc = db.data.settings.find(x => x._id === 'preview_fonts');
    assert.ok(doc && doc.fonts.sans.fileID && doc.fonts.serif.sha256 && doc.fonts.brush.size > 0);
    assert.deepStrictEqual(db.data.settings.find(x => x._id === 'export_fonts').fonts, { sans: { fileID: 'cloud://e/a' } }, '导出字体登记不受影响');
    r = await fn.main({ action: 'status' });
    assert.strictEqual(r.data.previewReady, true);
  } finally { sdk.uploadFile = origUp; state.download = origDown; db.persist = false; }
});

test('系统检查与管理员页：预览字体检查项（未上传为提醒，不影响导出）、上传按钮与说明', () => {
  const s = read('cloudfunctions/system/index.js');
  assert.ok(/doc\('preview_fonts'\)/.test(s) && s.includes('previewReady'));
  assert.ok(s.includes("add('配置', '预览字体（云存储）', fonts.previewReady ? 'ok' : 'warn'"), '未上传只是 warn');
  assert.ok(s.includes('!(fonts.ready && fonts.previewReady)'), 'fontsetup 在预览字体没传完前不提示删除');
  const w = read('miniprogram/pages/admin/admin.wxml');
  assert.ok(w.includes('bindtap="onPvFontsUpload"') && w.includes('python tools/gen_font_js.py --preview'));
  assert.ok(read('miniprogram/pages/admin/admin.js').includes('pvFontsOk') && read('miniprogram/pages/admin/admin.js').includes('adminPvFontsUpload'));
  const rq = read('miniprogram/utils/request.js');
  assert.ok(rq.includes("fontPreview: () => call('export', { action: 'fontPreview' }") && /'coverPhotoUrl', 'fontPreview'/.test(rq), 'fontPreview 是只读 action');
});

// ---------- 前端：pvfont 与示意图 ----------
function freshPvfont(metaImpl, loadImpl) {
  const req = require('../miniprogram/utils/request.js');
  const file = path.join(ROOT, 'miniprogram/pages/booktheme/pvfont.js');
  delete require.cache[file];
  req.fontPreview = metaImpl;
  global.wx.loadFontFace = loadImpl;
  return require(file);
}

test('pvfont：按 PDF 分工选字体；同一页面同一字体只加载一次；失败 / 没上传 / 基础库不支持回退系统字体；链接缓存', async () => {
  const saved = global.wx;
  global.wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }) };
  try {
    let metaCalls = 0; const loads = [];
    const META = { sans: { url: 'https://h/sans.ttf', v: 'aaaa' }, serif: { url: 'https://h/serif.ttf', v: 'bbbb' }, brush: { url: 'https://h/brush.ttf', v: 'cccc' } };
    const pv = freshPvfont(async () => { metaCalls++; return { ready: true, fonts: META }; }, o => { loads.push(o.family); o.success(); });
    assert.deepStrictEqual(pv.keysFor('sans', ''), ['sans']);
    assert.deepStrictEqual(pv.keysFor('serif', '囍'), ['serif']);
    assert.deepStrictEqual(pv.keysFor('sans', '囍'), ['sans', 'serif'], '囍 水印用宋体');
    assert.deepStrictEqual(pv.keysFor('brush', ''), ['brush', 'sans', 'serif'], '毛笔：小字黑体、水印宋体');
    assert.strictEqual(pv.css('hljpv-sans-aaaa'), "font-family:'hljpv-sans-aaaa',sans-serif;");
    assert.strictEqual(pv.css(''), '');
    const loaded = {};
    const [a, b, c] = await Promise.all([pv.load('serif', loaded), pv.load('serif', loaded), pv.load('sans', loaded)]);
    assert.strictEqual(a, 'hljpv-serif-bbbb'); assert.strictEqual(b, a); assert.strictEqual(c, 'hljpv-sans-aaaa');
    await pv.load('serif', loaded);
    assert.deepStrictEqual(loads.sort(), ['hljpv-sans-aaaa', 'hljpv-serif-bbbb'], '同一字体只加载一次');
    assert.strictEqual(metaCalls, 1, '链接只取一次（缓存）');
    // 新页面（新的 loaded）重新加载字体，但链接仍用缓存
    const loaded2 = {};
    await pv.load('serif', loaded2);
    assert.strictEqual(loads.length, 3); assert.strictEqual(metaCalls, 1);
    // 加载失败 -> ''
    const pvFail = freshPvfont(async () => ({ ready: true, fonts: META }), o => o.fail({ errMsg: 'x' }));
    assert.strictEqual(await pvFail.load('serif', {}), '');
    // 没上传
    const pvNone = freshPvfont(async () => ({ ready: false, fonts: {} }), () => { throw new Error('不该调用'); });
    assert.strictEqual(await pvNone.load('sans', {}), '');
    // 取链接失败
    const pvErr = freshPvfont(async () => { throw new Error('net'); }, () => { throw new Error('不该调用'); });
    assert.strictEqual(await pvErr.load('sans', {}), '');
    // 基础库没有 loadFontFace
    const pvOld = freshPvfont(async () => ({ ready: true, fonts: META }), undefined);
    assert.strictEqual(await pvOld.load('sans', {}), '');
  } finally { global.wx = saved; delete require.cache[path.join(ROOT, 'miniprogram/pages/booktheme/pvfont.js')]; }
});

function loadPage(wxExtra) {
  const saved = { Page: global.Page, wx: global.wx, getApp: global.getApp };
  let page = null;
  global.Page = o => { page = o; };
  global.wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }), getStorageSync: () => '', cloud: {}, showToast() {}, showModal(o) { global.__modal = o; }, ...wxExtra };
  global.getApp = () => ({ globalData: {} });
  ['miniprogram/pages/booktheme/booktheme.js', 'miniprogram/pages/booktheme/pvfont.js', 'miniprogram/pages/booktheme/vip.js'].forEach(f => { delete require.cache[path.join(ROOT, f)]; });
  require(path.join(ROOT, 'miniprogram/pages/booktheme/booktheme.js'));
  const inst = Object.assign({}, page, { data: JSON.parse(JSON.stringify(page.data)) });
  inst.setData = o => Object.keys(o).forEach(k => { if (k.includes('.')) { const [a, b] = k.split('.'); inst.data[a][b] = o[k]; } else inst.data[k] = o[k]; });
  inst._pvLoaded = {};
  return { inst, restore: () => { global.Page = saved.Page; global.wx = saved.wx; global.getApp = saved.getApp; delete global.__modal; } };
}

test('会员字体试看：免费用户点会员字体只改示意图（不选中、不改草稿、导出参数不变），切标签 / 选免费字体恢复；字体按分工套用', async () => {
  const loads = [];
  const { inst, restore } = loadPage({ loadFontFace: o => { loads.push(o.family); o.success(); } });
  const req = require('../miniprogram/utils/request.js');
  req.fontPreview = async () => ({ ready: true, fonts: { sans: { url: 'https://h/s', v: 'a' }, serif: { url: 'https://h/z', v: 'b' }, brush: { url: 'https://h/b', v: 'c' } } });
  try {
    inst.refresh = function () { return this.syncPvFonts(); };
    Object.assign(inst.data, { premiumOk: false, themeKey: 'red_gold', canSave: true, cur: 1 });
    inst._base = inst.snap();
    const before = inst.snap();
    await inst.refresh();
    assert.strictEqual(inst.data.pvf.main, "font-family:'hljpv-sans-a',sans-serif;", '默认黑体');
    // 试看宋体：示意图用宋体，但不选中
    inst.onFontPick({ currentTarget: { dataset: { v: 'serif' } } });
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(inst.data.tryFont, 'serif');
    assert.strictEqual(inst.snap(), before, '草稿（主题 / 字体）没有任何变化');
    assert.strictEqual(inst.effective().font, 'sans', '已选字体仍是黑体');
    assert.strictEqual(inst.data.themeKey, 'red_gold');
    assert.ok(global.__modal && /会员/.test(global.__modal.content), '同时提示开通（vip.explain）');
    assert.ok(inst.data.pvf.main.includes('hljpv-serif-b'), '示意图按试看的宋体显示');
    assert.ok(loads.includes('hljpv-serif-b'));
    // 导出 / 预览 / 保存参数不含试看的字体
    inst.data.book = { _id: 'b1', type: 'wedding', name: 'x' };
    const params = inst.buildParams();
    assert.strictEqual(params.pdfTheme, 'red_gold'); assert.ok(!('tryFont' in params));
    // 试毛笔：小字用黑体、水印用宋体（缺的都加载）
    inst.onFontPick({ currentTarget: { dataset: { v: 'brush' } } });
    await new Promise(r => setTimeout(r, 10));
    assert.ok(inst.data.pvf.main.includes('hljpv-brush-c') && inst.data.pvf.sub.includes('hljpv-sans-a'));
    assert.strictEqual(loads.filter(x => x === 'hljpv-serif-b').length, 1, '宋体只加载一次');
    // 切标签：试看结束，示意图回到已选字体
    inst.onTab({ currentTarget: { dataset: { i: 0 } } });
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(inst.data.tryFont, '');
    assert.ok(inst.data.pvf.main.includes('hljpv-sans-a'));
    // 再试看，然后选免费的黑体：结束试看
    inst.onFontPick({ currentTarget: { dataset: { v: 'serif' } } });
    await new Promise(r => setTimeout(r, 10));
    inst.onFontPick({ currentTarget: { dataset: { v: 'sans' } } });
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(inst.data.tryFont, '');
    assert.ok(inst.data.pvf.main.includes('hljpv-sans-a'));
    // 左右滑示意图同样结束试看
    inst.onFontPick({ currentTarget: { dataset: { v: 'serif' } } });
    inst.onSwipe({ detail: { current: 2 } });
    assert.strictEqual(inst.data.tryFont, '');
  } finally { restore(); }
});

test('会员用户选字体：正常选中（不是试看）；字体加载失败回退系统字体并提示、加载中轻提示', async () => {
  const { inst, restore } = loadPage({ loadFontFace: o => o.fail({ errMsg: 'x' }) });
  const req = require('../miniprogram/utils/request.js');
  req.fontPreview = async () => ({ ready: true, fonts: { sans: { url: 'https://h/s', v: 'a' }, serif: { url: 'https://h/z', v: 'b' } } });
  try {
    inst.refresh = function () { return this.syncPvFonts(); };
    Object.assign(inst.data, { premiumOk: true, themeKey: 'red_gold', canSave: true });
    inst._base = inst.snap();
    inst.onFontPick({ currentTarget: { dataset: { v: 'serif' } } });
    assert.strictEqual(inst.data.tryFont, '');
    assert.strictEqual(inst.data.themeKey, 'custom', '会员：预设转自定义并选中');
    assert.strictEqual(inst.data.cust.font, 'serif');
    assert.strictEqual(inst.data.pvLoading, true, '加载中');
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(inst.data.pvLoading, false);
    assert.strictEqual(inst.data.pvFail, true, '加载失败');
    assert.strictEqual(inst.data.pvNone, false, '加载失败不是没上传');
    assert.deepStrictEqual(inst.data.pvf, { main: '', sub: '', mark: '' }, '回退系统字体');
  } finally { restore(); }
});

test('示意图字体套用：标题 / 落款 / 姓名用主字体，小字与金额用 sub，水印单独；wxml 接入', () => {
  const w = read('miniprogram/pages/booktheme/booktheme.wxml');
  const has = s => assert.ok(w.includes(s), s);
  has('class="pc-title" style="color:{{pv.border}};{{pvf.main}}"');
  has('class="pc-sm" wx:for="{{pv.info}}" wx:key="*this" style="{{pvf.sub}}"');
  has(';{{pvf.main}}" wx:if="{{pv.footer}}"');
  has('class="pg-head" style="color:{{pg.line}};{{pvf.main}}"');
  has('<text class="pg-c" style="{{pvf.main}}"');
  has('<text class="pg-ca" style="{{pvf.sub}}"');
  has('letter-spacing:6rpx;{{pvf.main}}');
  has('class="pc-sign" wx:if="{{back.sign}}" style="{{pvf.sub}}"');
  assert.strictEqual((w.match(/\{\{pvf\.mark\}\}/g) || []).length, 3, '封面 / 内页 / 封底三处水印');
  has('{{pvLoading ? \' · 字体加载中…\' : (pvNone ? \' · 预览字体未上传，示意图暂用系统字体\' : (pvFail ? \' · 字体加载失败，示意图暂用系统字体\' : \'\'))}}');
  has("{{tryFont === item.k ? 'try' : ''}}");
  has('试看中：示意图暂按该字体显示，并未选中（会员功能）');
  const js = read('miniprogram/pages/booktheme/booktheme.js');
  assert.ok(js.includes('this.syncPvFonts();\n  },\n') && js.includes("this.setData({ cur: Number(e.currentTarget.dataset.i), tryFont: '' })"));
  assert.ok(!js.includes('tryFont') || !/buildParams\(\) \{[\s\S]*?tryFont[\s\S]*?return params;/.test(js), 'buildParams 不含试看字体');
  assert.ok(/VERSION: '3\.\d+\.\d+'/.test(read('miniprogram/config.js')));
});

// ---------- v3.83.1：下载到本地再加载（真机直接加载云存储临时链接跨域失败） ----------
function mkWx(opt = {}) {
  const files = new Map(opt.files || []);
  const log = { download: [], copy: [], read: [], unlink: [], faces: [] };
  const wxm = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }),
    env: { USER_DATA_PATH: 'wxfile://usr' },
    cloud: { downloadFile: o => { log.download.push(o.fileID); if (opt.dlFail) return o.fail({ errMsg: 'downloadFile:fail' }); o.success({ tempFilePath: 'wxfile://tmp/' + o.fileID.split('/').pop() }); } },
    getFileSystemManager: () => ({
      access: o => (files.has(o.path) ? o.success({}) : o.fail({ errMsg: 'access:fail no such file' })),
      copyFile: o => { log.copy.push(o.destPath); if (opt.copyFail) return o.fail({ errMsg: 'copyFile:fail exceed' }); files.set(o.destPath, 1); o.success({}); },
      readFile: o => { log.read.push(o.filePath); if (opt.badCache && o.filePath.startsWith('wxfile://usr/') && !opt.badCache.done) { opt.badCache.done = true; return o.fail({ errMsg: 'readFile:fail corrupt' }); } o.success({ data: 'B64(' + o.filePath.split('/').pop() + ')' }); },
      readdir: o => o.success({ files: [...files.keys()].filter(k => k.startsWith('wxfile://usr/')).map(k => k.slice('wxfile://usr/'.length)) }),
      unlink: o => { log.unlink.push(o.filePath); files.delete(o.filePath); if (o.success) o.success({}); }
    }),
    loadFontFace: o => { log.faces.push(o.source); if (opt.dataFail && o.source.includes('data:font')) return o.fail({ errMsg: 'loadFontFace:fail data' }); if (opt.allFail) return o.fail({ errMsg: 'loadFontFace:fail' }); o.success({}); }
  };
  return { wxm, files, log };
}
const FM = v => ({ sans: { url: 'https://h/sans.ttf', fileID: 'cloud://e.b/preview-fonts/sans.ttf', v }, serif: { url: 'https://h/serif.ttf', fileID: 'cloud://e.b/preview-fonts/serif.ttf', v: 'z' + v } });
const quietWarn = async fn => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };
// 用 mkWx 的假环境重新加载 pvfont（freshPvfont 会替换 wx.loadFontFace，这里再把整套假环境放回去）
function pvWith(m, meta) {
  global.wx = m.wxm;
  const pv = freshPvfont(async () => meta, m.wxm.loadFontFace);
  return pv;
}

test('pvfont v3.83.1：fileID 下载到 USER_DATA_PATH 再读 base64 用 data URI 加载；本地命中不再下载；版本变化清理旧文件', async () => {
  const saved = global.wx;
  try {
    const m = mkWx(); global.wx = m.wxm;
    let pv = pvWith(m, { ready: true, fonts: FM('aaaa') });
    assert.strictEqual(await pv.load('sans', {}), 'hljpv-sans-aaaa');
    assert.deepStrictEqual(m.log.download, ['cloud://e.b/preview-fonts/sans.ttf']);
    assert.deepStrictEqual(m.log.copy, ['wxfile://usr/pvfont-sans-aaaa.ttf'], '文件名带版本');
    assert.deepStrictEqual(m.log.read, ['wxfile://usr/pvfont-sans-aaaa.ttf']);
    assert.strictEqual(m.log.faces[0], 'url("data:font/ttf;base64,B64(pvfont-sans-aaaa.ttf)")', 'data URI');
    // 新页面：本地命中，不再下载
    assert.strictEqual(await pv.load('sans', {}), 'hljpv-sans-aaaa');
    assert.strictEqual(m.log.download.length, 1, '本地缓存命中');
    assert.strictEqual(m.log.faces.length, 2);
    // 版本变化：下载新版本，旧文件被清理
    m.files.set('wxfile://usr/pvfont-serif-zold.ttf', 1); m.files.set('wxfile://usr/other.txt', 1);
    pv = pvWith(m, { ready: true, fonts: FM('bbbb') });
    assert.strictEqual(await pv.load('sans', {}), 'hljpv-sans-bbbb');
    assert.strictEqual(m.log.download.length, 2);
    assert.ok(m.log.unlink.includes('wxfile://usr/pvfont-sans-aaaa.ttf'), '旧版本被删');
    assert.ok(!m.log.unlink.includes('wxfile://usr/other.txt') && !m.log.unlink.includes('wxfile://usr/pvfont-serif-zold.ttf'), '只清理同一个字体的旧版本');
    assert.ok(m.files.has('wxfile://usr/pvfont-sans-bbbb.ttf') && !m.files.has('wxfile://usr/pvfont-sans-aaaa.ttf'));
    assert.strictEqual(pv.state(), 'ok');
  } finally { global.wx = saved; }
});

test('pvfont v3.83.1：写入缓存失败用临时文件；缓存文件损坏重新下载；data URI 失败退回 https 链接；全部失败返回空并打 errMsg', async () => {
  const saved = global.wx;
  try {
    await quietWarn(async () => {
      // 写入失败（空间不足）：直接读下载下来的临时文件
      let m = mkWx({ copyFail: true });
      let pv = pvWith(m, { ready: true, fonts: FM('aaaa') });
      assert.strictEqual(await pv.load('sans', {}), 'hljpv-sans-aaaa');
      assert.deepStrictEqual(m.log.read, ['wxfile://tmp/sans.ttf']);
      // 缓存文件损坏：读失败 -> 删除并重新下载一次
      m = mkWx({ files: [['wxfile://usr/pvfont-sans-aaaa.ttf', 1]], badCache: {} });
      pv = pvWith(m, { ready: true, fonts: FM('aaaa') });
      assert.strictEqual(await pv.load('sans', {}), 'hljpv-sans-aaaa');
      assert.strictEqual(m.log.download.length, 1, '损坏后重新下载');
      assert.strictEqual(m.log.read.length, 2);
      // data URI 方式失败：退回原来的 https 链接
      m = mkWx({ dataFail: true });
      pv = pvWith(m, { ready: true, fonts: FM('aaaa') });
      assert.strictEqual(await pv.load('sans', {}), 'hljpv-sans-aaaa');
      assert.strictEqual(m.log.faces[m.log.faces.length - 1], 'url("https://h/sans.ttf")');
      // 下载失败：直接试 https 链接
      m = mkWx({ dlFail: true });
      pv = pvWith(m, { ready: true, fonts: FM('aaaa') });
      assert.strictEqual(await pv.load('sans', {}), 'hljpv-sans-aaaa');
      assert.deepStrictEqual(m.log.faces, ['url("https://h/sans.ttf")']);
    });
    // 全部失败 -> ''，errMsg 打到 console
    const m = mkWx({ allFail: true });
    const warns = []; const ow = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    try {
      const pv = pvWith(m, { ready: true, fonts: FM('aaaa') });
      assert.strictEqual(await pv.load('sans', {}), '');
    } finally { console.warn = ow; }
    assert.ok(warns.some(w => w.includes('loadFontFace:fail')), '失败的 errMsg 打到 console：' + warns.join('|'));
  } finally { global.wx = saved; }
});

test('pvfont v3.83.1：state 区分没上传（none）与取元信息失败（error）；示意图提示分开（pvNone / pvFail）', async () => {
  const saved = global.wx;
  try {
    await quietWarn(async () => {
      let m = mkWx();
      let pv = pvWith(m, { ready: false, fonts: {} });
      await pv.load('sans', {}); assert.strictEqual(pv.state(), 'none');
      m = mkWx();
      global.wx = m.wxm; pv = freshPvfont(async () => { throw new Error('net'); }, m.wxm.loadFontFace);
      await pv.load('sans', {}); assert.strictEqual(pv.state(), 'error');
    });
    const req = require('../miniprogram/utils/request.js');
    // 页面：没上传 -> pvNone；已上传但加载失败 -> pvFail
    let ctx = loadPage({ loadFontFace: o => o.fail({ errMsg: 'x' }) });
    req.fontPreview = async () => ({ ready: false, fonts: {} });
    try {
      ctx.inst.refresh = function () { return this.syncPvFonts(); };
      await ctx.inst.refresh();
      assert.strictEqual(ctx.inst.data.pvNone, true); assert.strictEqual(ctx.inst.data.pvFail, false);
    } finally { ctx.restore(); }
    ctx = loadPage({ loadFontFace: o => o.fail({ errMsg: 'x' }) });
    req.fontPreview = async () => ({ ready: true, fonts: { sans: { url: 'https://h/s', v: 'a' } } });
    try {
      await quietWarn(async () => { ctx.inst.refresh = function () { return this.syncPvFonts(); }; await ctx.inst.refresh(); });
      assert.strictEqual(ctx.inst.data.pvNone, false); assert.strictEqual(ctx.inst.data.pvFail, true);
    } finally { ctx.restore(); }
  } finally { global.wx = saved; }
});
