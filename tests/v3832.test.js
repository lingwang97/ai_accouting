// v3.83.2：传统礼簿导出页界面兼容性修复（裁剪面板按窗口高度、合并 setData、试看提示只弹一次、预览字体失败可重试、
// 机构模式用词与云端封底 / 表格一致、点击区、芯片边框、照片加载失败提示、JPG 不再二次压缩）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const imgc = require('../miniprogram/utils/imgcompress.js');

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const JS = read('miniprogram/pages/booktheme/booktheme.js');
const WXML = read('miniprogram/pages/booktheme/booktheme.wxml');
const WXSS = read('miniprogram/pages/booktheme/booktheme.wxss');

// ---------- imgcompress：JPG 且 ≤1.5MB 不再压缩 ----------
function mkWx(opt) {
  const log = { compress: 0 };
  global.wx = {
    compressImage: ({ src, quality, success }) => { log.compress++; success({ tempFilePath: src + '.q' + quality }); },
    getFileSystemManager: () => ({
      getFileInfo: ({ filePath, success, fail }) => (opt.sizes[filePath] !== undefined ? success({ size: opt.sizes[filePath] }) : fail({})),
      readFile: ({ filePath, success, fail }) => (opt.head === undefined ? fail({ errMsg: 'readFile:fail' }) : success({ data: new Uint8Array(opt.head[filePath] || []).buffer }))
    })
  };
  return log;
}
test('imgcompress.cover：JPG 且不超过 1.5MB 原样使用；PNG、超限、读文件头失败按扩展名判断', async () => {
  const MB = 1024 * 1024;
  try {
    let log = mkWx({ sizes: { 'a.jpg.q80': 400 * 1024, 'a.png.q80': 400 * 1024 }, head: { 'a.jpg': [0xff, 0xd8], 'a.png': [0x89, 0x50] } });
    assert.strictEqual(await imgc.cover('a.jpg', 1.2 * MB), 'a.jpg', 'JPG 1.2MB 直接用');
    assert.strictEqual(log.compress, 0, '没有压缩');
    assert.strictEqual(await imgc.cover('a.jpg', 1.5 * MB), 'a.jpg', '恰好 1.5MB 也直接用');
    assert.strictEqual(await imgc.cover('a.png', 1.2 * MB), 'a.png.q80', 'PNG 照旧压缩转 JPG');
    assert.ok(log.compress >= 1);
    assert.strictEqual(await imgc.cover('a.jpg', 1.6 * MB), 'a.jpg.q80', '超过 1.5MB 照旧压缩');
    // 文件头里是 PNG 而扩展名是 .jpg：以文件头为准
    log = mkWx({ sizes: { 'x.jpg.q80': 300 * 1024 }, head: { 'x.jpg': [0x89, 0x50] } });
    assert.strictEqual(await imgc.cover('x.jpg', 1 * MB), 'x.jpg.q80');
    // 读不了文件头：按扩展名
    log = mkWx({ sizes: { 'b.jpeg.q80': 300 * 1024, 'b.png.q80': 300 * 1024 } });
    assert.strictEqual(await imgc.cover('b.jpeg', 1 * MB), 'b.jpeg');
    assert.strictEqual(await imgc.cover('b.png', 1 * MB), 'b.png.q80');
    assert.strictEqual(log.compress, 1);
  } finally { delete global.wx; }
});

// ---------- pvfont：失败不缓存，可重试 ----------
test('pvfont：加载失败的结果不缓存（下次可重试）；成功的仍只加载一次', async () => {
  const req = require('../miniprogram/utils/request.js');
  const file = path.join(ROOT, 'miniprogram/utils/pvfont.js');
  const saved = global.wx;
  global.wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }) };
  const warn = console.warn; console.warn = () => {};
  try {
    delete require.cache[file];
    req.fontPreview = async () => ({ ready: true, fonts: { sans: { url: 'https://h/sans.ttf', v: 'aaaa' } } });
    let ok = false, calls = 0;
    global.wx.loadFontFace = o => { calls++; return ok ? o.success({}) : o.fail({ errMsg: 'x' }); };
    const pv = require(file);
    const loaded = {};
    assert.strictEqual(await pv.load('sans', loaded), '');
    await new Promise(r => setImmediate(r));
    assert.strictEqual(loaded.sans, undefined, '失败不留在缓存里');
    ok = true;
    assert.strictEqual(await pv.load('sans', loaded), 'hljpv-sans-aaaa', '重试成功');
    const n = calls;
    assert.strictEqual(await pv.load('sans', loaded), 'hljpv-sans-aaaa');
    assert.strictEqual(calls, n, '成功后不再加载');
  } finally { console.warn = warn; global.wx = saved; delete require.cache[file]; }
  assert.ok(JS.includes('this._pvBad = !noneFont') && JS.includes('retry && this._pvBad'), '页面：失败后切字体 / 标签才重试');
  assert.ok(/onTab\(e\)[^\n]*this\._pvRetry = true/.test(JS) && /onSwipe\(e\)[^\n]*this\._pvRetry = true/.test(JS));
});

// ---------- 页面结构 ----------
test('裁剪面板：框高按窗口高度限制、按钮栏固定在底部、拖动每帧只 setData 一次', () => {
  assert.ok(JS.includes('this._maxH = wh ?') && JS.includes('Math.max(260, Math.min(620'));
  assert.ok(JS.includes('const maxH = this._maxH || 620;'));
  assert.ok(/\.crop-sheet \.sheet-btns \{ position: sticky; bottom: 0;/.test(WXSS) && /env\(safe-area-inset-bottom\)/.test(WXSS.split('.crop-sheet .sheet-btns {')[1].split('}')[0]));
  const move = JS.split('onCropMove(e) {')[1].split('onCropEnd')[0];
  assert.ok(!/this\.setData\(/.test(move), 'onCropMove 不直接 setData，只走 cropRender(edit)');
  assert.strictEqual((move.match(/this\.cropRender\(/g) || []).length, 2, '平移 / 缩放各一次');
  assert.ok(JS.includes('if (edit) upd.cropEdit = edit;') && JS.includes('if (d.cropFrame.w !== w'));
});

test('会员字体试看：第一次弹窗，之后只 toast', () => {
  assert.ok(JS.includes("wx.getStorageSync('tryFontTip')") && JS.includes("wx.setStorageSync('tryFontTip', 1)"));
  assert.ok(JS.includes("title: '会员字体，仅试看'") && JS.includes('return this.tryHint();'));
  assert.ok(!JS.includes("return vip.explain('PDF 字体', VIP_TIP);\n    }\n    if (d.tryFont)"), '试看不再每次弹窗');
});

test('机构模式用词：页面 wxml 用 o.t，js 用 orgtext；封底示意与云端一致', () => {
  assert.ok(WXML.includes("o.t('封面标题（不填用礼簿名）', org)") && !/>封面标题（不填用礼簿名）</.test(WXML));
  assert.ok(WXML.includes("o.t('白事礼簿封面不使用照片', org)") && WXML.includes("o.t('记账人签名栏', org)"));
  assert.ok(JS.includes("orgtext.t('记账人', d.org)"));
  const ot = require('../miniprogram/utils/orgtext.js');
  assert.strictEqual(ot.t('记账人签名栏', true), '礼台人员签名栏');
  assert.strictEqual(ot.t('白事礼簿封面不使用照片', true), '白事场次封面不使用照片');
  assert.strictEqual(ot.t('封面标题（不填用礼簿名）', true), '封面标题（不填用场次名）');
});

test('云端 export：机构模式封底「礼台人员」、表格「场次」；非机构不变', async () => {
  process.env.HLJ_FONT_TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hlj-v3832-'));
  let T;
  try { T = loadFunction('export')._test; } catch (e) { return 'SKIP 未安装 pdfkit / exceljs'; }
  const rows = [{ payerName: '张三', amount: 100, payMethod: 'wechat', relation: '朋友' }];
  const mk = org => T.buildMeta(rows, { account: { accountName: '主家', orgMode: org }, book: { _id: 'b1', name: '场A', type: 'other', date: '2026-10-01' }, startDay: '', endDay: '', themeName: '', pdfThemeKey: 'red_gold', pdfCustom: null, pdfDeco: '', premiumOk: true });
  const mo = mk(true), mn = mk(false);
  assert.strictEqual(mo.org, true); assert.strictEqual(mn.org, false);
  assert.strictEqual(T.orgT(mn, '记账人'), '记账人');
  assert.strictEqual(T.orgT(mo, '记账人'), '礼台人员');
  assert.strictEqual(T.orgT(mo, '礼簿日期'), '场次日期');
  assert.strictEqual(T.orgT(mo, '传统礼簿'), '传统礼簿', '固定名称不替换');
  assert.ok(T.subtitleLines(mo).join('').includes('场次日期：') && !T.subtitleLines(mo).join('').includes('礼簿日期'));
  assert.ok(T.subtitleLines(mn).join('').includes('礼簿日期：'));
  assert.strictEqual(T.colsFor({ ...mo, bookName: '' }).find(c => c.key === 'themeName').title, '场次');
  assert.strictEqual(T.colsFor({ ...mn, bookName: '' }).find(c => c.key === 'themeName').title, '礼簿');
  const src = read('cloudfunctions/export/index.js');
  assert.ok(src.includes("`${orgT(meta, '记账人')}：${names}`") && src.includes("`${orgT(meta, '记账人')}（签字）`"));
  assert.ok(src.includes("非正式${orgT(meta, '礼簿')}"));
});

test('样式：示意图小字调大、点击区放大、芯片统一透明边框、试看只改边框样式', () => {
  assert.ok(/\.pc \{[^}]*scale\(0\.68\)/.test(WXSS) && WXSS.includes('.pv-swiper { height: 340rpx; }'));
  const px = (sel, prop) => Number((new RegExp(sel.replace(/[.]/g, '\\.') + ' \\{[^}]*?' + prop + ': (\\d+)rpx').exec(WXSS) || [])[1]);
  assert.ok(px('.pg-ca', 'font-size') >= 19 && px('.pg-yen', 'font-size') >= 16 && px('.pg-c', 'font-size') >= 24 && px('.pc-sm', 'font-size') >= 26);
  assert.ok(px('.crop-zb', 'width') >= 80 && px('.fcell', 'height') >= 72);
  assert.ok(/\.pv-tab \{ padding: 24rpx 32rpx; margin: -12rpx 8rpx;/.test(WXSS) && /\.pv-fold \{[^}]*margin: -20rpx/.test(WXSS), '点击区用内边距撑大、负 margin 抵回');
  assert.ok(/\.chip \{ border: 2rpx solid transparent; padding: 6rpx 24rpx; \}/.test(WXSS));
  assert.ok(/\.chip\.try \{ border-style: dashed; border-color: var\(--primary\)/.test(WXSS));
});

test('照片加载失败提示、封底落款 placeholder 缩短、保存中文案、版本号', () => {
  assert.ok(WXML.includes('binderror="onPhotoErr"') && JS.includes('onPhotoErr() {') && JS.includes("title: '照片加载失败，请重新选择'"));
  assert.ok(WXML.includes('placeholder="自动：沿用封面落款或默认"'));
  assert.ok(WXML.includes("{{saving ? '保存中' : (dirty ? '保存样式' : '已保存')}}"));
  assert.ok(/VERSION: '3\.83\.([2-9]|\d{2})'/.test(read('miniprogram/config.js')));
});
