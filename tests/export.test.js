// export 云函数端到端（需要 pdfkit / exceljs；本地没装会跳过）：字体从云存储下载 -> /tmp 缓存 -> 生成 PDF / Excel。
// 字体登记（settings.export_fonts）与云存储下载都用假的；下载成功 / 失败 / 已缓存 / 未上传 四种情况分别验证。
// 本地跑法：在任意目录 npm i pdfkit exceljs，然后 NODE_PATH=<该目录>/node_modules node tests/run.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('./helpers/harness.js');

let haveDeps = true;
try { require.resolve('pdfkit'); require.resolve('exceljs'); } catch (e) { haveDeps = false; }
const t = (name, fn) => test(name, async () => (haveDeps ? fn() : 'SKIP 未安装 pdfkit / exceljs'));

const { db, state, loadFunction } = require('./helpers/sdk-stub.js');
const F = require('../cloudfunctions/export/fonts.js');

const OWNER = 'o-owner';
const FONT_DIR = path.join(__dirname, '..', 'tools', 'fonts');
const files = Object.fromEntries(Object.entries(F.FONT_FILES).map(([k, n]) => [k, fs.readFileSync(path.join(FONT_DIR, n))]));
const fontMeta = () => ({ _id: 'export_fonts', fonts: Object.fromEntries(Object.keys(files).map(k => [k, { fileID: 'cloud://env.b/export-fonts/' + F.FONT_FILES[k], name: F.FONT_FILES[k], size: files[k].length, sha256: F.sha256(files[k]) }])) });

function seed(opts = {}) {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '测试主家', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '测试礼簿', type: 'wedding', date: '2026-10-01', location: '某酒店' }])
    .seed('records', Array.from({ length: 8 }, (_, i) => ({
      _id: 'r' + i, ownerOpenid: OWNER, bookId: 'b1', status: 'paid', payDay: '2026-10-01', payerName: '张三' + i, amount: 100 + i,
      relation: '朋友', payMethod: i % 2 ? 'cash' : 'wechat', createdAt: new Date(2026, 9, 1, 10, i), paidAt: new Date(2026, 9, 1, 10, i)
    })));
  if (opts.fonts !== false) db.seed('settings', [fontMeta()]);
  state.openid = OWNER;
  state.uploads.length = 0;
}

/** 每个场景用独立的 /tmp 缓存目录、重新加载 export（字体加载器内存缓存清空） */
function load(downloadImpl) {
  process.env.HLJ_FONT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hlj-export-test-'));
  const calls = [];
  state.download = async fileID => {
    calls.push(fileID);
    if (downloadImpl) return downloadImpl(fileID);
    return files[Object.keys(F.FONT_FILES).find(k => fileID.endsWith(F.FONT_FILES[k]))];
  };
  return { fn: loadFunction('export'), calls, dir: process.env.HLJ_FONT_TMP };
}
const names = calls => calls.map(c => c.split('/').pop());
const WINE = { format: 'book', bookId: 'b1', pdfTheme: 'wine_gold' }; // 宋体 + 「喜」水印
const BRUSH = { format: 'book', bookId: 'b1', pdfTheme: 'custom', pdfCustom: { main: '#B71C1C', accent: '#D4AF37', cover: '#F8E7B0', font: 'brush', pattern: 'double', mark: '囍', footer: '', title: '' } };
const isPdf = u => u && Buffer.isBuffer(u.content) && u.content.slice(0, 5).toString() === '%PDF-';

t('表格 PDF：只下载黑体，生成成功；第二次导出走内存缓存不再下载', async () => {
  seed();
  const { fn, calls } = load();
  const body = { format: 'pdf', startDay: '2026-10-01', endDay: '2026-10-01' };
  let r = await fn.main(body);
  assert.strictEqual(r.code, 0, r.msg);
  assert.deepStrictEqual(names(calls), ['NotoSansSC-Subset.ttf']);
  assert.ok(isPdf(state.uploads[0]) && !r.data.notice);
  r = await fn.main(body);
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(calls.length, 1);
});

t('传统礼簿（黑体 / 宋体 + 水印 / 毛笔 + 囍水印）：按需下载对应字体，生成成功且无提示', async () => {
  seed();
  db.data.books[0].type = 'other'; // v3.55.0 起喜事默认带囍水印（要宋体）；「其他」类型无水印，只用黑体
  let { fn, calls } = load();
  let r = await fn.main({ format: 'book', bookId: 'b1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.deepStrictEqual(names(calls), ['NotoSansSC-Subset.ttf']);
  ({ fn, calls } = load());
  r = await fn.main(WINE);
  assert.strictEqual(r.code, 0, r.msg);
  assert.deepStrictEqual(names(calls).sort(), ['NotoSansSC-Subset.ttf', 'NotoSerifSC-Subset.ttf']);
  assert.ok(isPdf(state.uploads[state.uploads.length - 1]) && !r.data.notice);
  ({ fn, calls } = load());
  r = await fn.main(BRUSH);
  assert.strictEqual(r.code, 0, r.msg);
  assert.deepStrictEqual(names(calls).sort(), ['MaShanZheng-Subset.ttf', 'NotoSansSC-Subset.ttf', 'NotoSerifSC-Subset.ttf']);
  assert.ok(!r.data.notice);
});

t('/tmp 已缓存：新实例（内存为空）导出不再下载', async () => {
  seed();
  const first = load();
  assert.strictEqual((await first.fn.main(WINE)).code, 0);
  assert.strictEqual(first.calls.length, 2);
  const fn2 = loadFunction('export'); // 同一个 HLJ_FONT_TMP，模拟冷启动但实例 /tmp 还在
  state.download = async () => { throw new Error('不该下载'); };
  const r = await fn2.main(WINE);
  assert.strictEqual(r.code, 0, r.msg);
});

t('下载失败：宋体 / 毛笔回退黑体并在结果里提示；黑体失败整体报错并提示重试', async () => {
  seed();
  let { fn } = load(fileID => { if (/Serif|MaShan/.test(fileID)) throw new Error('network'); return files.sans; });
  let r = await fn.main(WINE);
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(r.data.notice && r.data.notice.includes('宋体') && r.data.notice.includes('黑体'), r.data.notice);
  assert.ok(isPdf(state.uploads[state.uploads.length - 1]));
  ({ fn } = load(fileID => { if (/Serif|MaShan/.test(fileID)) throw new Error('network'); return files.sans; }));
  r = await fn.main(BRUSH);
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(r.data.notice.includes('毛笔') && r.data.notice.includes('水印'), r.data.notice); // 囍无黑体字形，省略水印
  ({ fn } = load(() => { throw new Error('network'); }));
  r = await fn.main({ format: 'pdf', startDay: '2026-10-01', endDay: '2026-10-01' });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.msg, '字体加载失败，请重试');
  ({ fn } = load(() => { throw new Error('network'); }));
  r = await fn.main({ format: 'book', bookId: 'b1' });
  assert.strictEqual(r.code, 1); assert.strictEqual(r.msg, '字体加载失败，请重试');
});

t('存档（keep:true）不用回退字体生成，避免替换成不对的版本', async () => {
  seed();
  const { fn } = load(fileID => { if (/Serif/.test(fileID)) throw new Error('network'); return files.sans; });
  const r = await fn.main({ ...WINE, keep: true });
  assert.strictEqual(r.code, 1);
  assert.ok(r.msg.includes('字体') && r.msg.includes('重试'));
  assert.strictEqual(state.uploads.length, 0);
});

t('字体还没上传：PDF 提示「字体准备中」，Excel 与备份照常可用', async () => {
  seed({ fonts: false });
  const { fn, calls } = load();
  let r = await fn.main({ format: 'pdf', startDay: '2026-10-01', endDay: '2026-10-01' });
  assert.strictEqual(r.code, 1); assert.strictEqual(r.msg, '字体准备中，请稍后重试');
  r = await fn.main({ format: 'book', bookId: 'b1' });
  assert.strictEqual(r.code, 1); assert.strictEqual(r.msg, '字体准备中，请稍后重试');
  r = await fn.main({ format: 'xlsx', bookId: 'b1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(state.uploads[state.uploads.length - 1].cloudPath.endsWith('.xlsx'));
  r = await fn.main({ format: 'backup' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(calls.length, 0, 'Excel / 备份不应触碰字体');
});

t('Excel 与备份在字体全部不可用时也不访问云存储字体', async () => {
  seed();
  const { fn, calls } = load(() => { throw new Error('network'); });
  assert.strictEqual((await fn.main({ format: 'xlsx', bookId: 'b1' })).code, 0);
  assert.strictEqual((await fn.main({ format: 'backup' })).code, 0);
  assert.strictEqual(calls.length, 0);
});

t('定时清理（Timer）不加载字体', async () => {
  seed();
  state.openid = '';
  const { fn, calls } = load();
  const r = await fn.main({ Type: 'Timer', TriggerName: 'cleanup' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(calls.length, 0);
  state.openid = OWNER;
});

// —— v3.53.0 传统礼簿 PDF 预览（bookPreview / bookPreviewData） ——
const writes = () => db.log.filter(l => ['update', 'remove'].includes(l.op) && ['books', 'archives'].includes(l.col));

t('预览：生成 PDF（封面 + 内页 + 封底），不写 books / 存档，文件名带「预览」', async () => {
  seed();
  const { fn } = load();
  const r = await fn.main({ action: 'bookPreview', bookId: 'b1', pdfTheme: 'wine_gold', pdfBack: { on: true }, pdfBind: 'none' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(isPdf(state.uploads[0]));
  assert.ok(r.data.fileName.includes('预览') && r.data.sample === false);
  assert.ok(state.uploads[0].cloudPath.startsWith('exports/'), '临时文件走 exports 目录（不是 archives）');
  assert.strictEqual(writes().length, 0, '预览不应更新 books / 存档');
  const pages = (state.uploads[0].content.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.strictEqual(pages, 3, '封面 + 1 页内页 + 封底');
});

t('预览：双面装订页数补齐为偶数；关闭封底少一页', async () => {
  seed();
  const { fn } = load();
  const count = () => (state.uploads[state.uploads.length - 1].content.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.strictEqual((await fn.main({ action: 'bookPreview', bookId: 'b1', pdfBind: 'double' })).code, 0);
  assert.strictEqual(count() % 2, 0);
  assert.strictEqual((await fn.main({ action: 'bookPreview', bookId: 'b1', pdfBack: { on: false } })).code, 0);
  assert.strictEqual(count(), 2);
});

t('预览：取数条件带 ownerOpenid 和 bookId，最多 8 笔，同导出的排序口径', async () => {
  seed();
  const { fn } = load();
  db.log.length = 0;
  const r = await fn.main({ action: 'bookPreviewData', bookId: 'b1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(r.data.rows.length, 8);
  assert.deepStrictEqual(Object.keys(r.data.rows[0]).sort(), ['amount', 'name'], '出参不含 openid 等内部字段');
  const g = db.log.filter(l => l.op === 'get' && l.col === 'records');
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].cond.ownerOpenid, OWNER);
  assert.strictEqual(g[0].cond.bookId, 'b1');
  assert.ok(g[0].limit <= 8);
  assert.strictEqual(g[0].orders.length, 2, '按登记时间、_id 升序（与导出一致）');
  assert.strictEqual(r.data.sample, false);
});

t('预览：别人的礼簿 / 不存在的礼簿报「礼簿不存在」，且不读礼金', async () => {
  seed();
  const { fn } = load();
  db.log.length = 0;
  state.openid = 'o-stranger';
  let r = await fn.main({ action: 'bookPreviewData', bookId: 'b1' });
  state.openid = OWNER;
  assert.strictEqual(r.code, 1);
  assert.strictEqual(db.log.filter(l => l.col === 'records').length, 0);
  r = await fn.main({ action: 'bookPreview', bookId: 'nope' });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(state.uploads.length, 0);
});

t('预览：没有礼金时用示例数据', async () => {
  seed();
  db.data.records = [];
  const { fn } = load();
  const d = await fn.main({ action: 'bookPreviewData', bookId: 'b1' });
  assert.strictEqual(d.code, 0);
  assert.ok(d.data.sample && d.data.rows.length > 0);
  const r = await fn.main({ action: 'bookPreview', bookId: 'b1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(r.data.sample, true);
});

t('预览：参数经过 sanitize（非法主题 / 配色报错；白事强制素灰）', async () => {
  seed();
  const { fn } = load();
  let r = await fn.main({ action: 'bookPreview', bookId: 'b1', pdfTheme: 'no_such_theme' });
  assert.strictEqual(r.code, 1); assert.strictEqual(r.msg, '主题不存在');
  r = await fn.main({ action: 'bookPreview', bookId: 'b1', pdfTheme: 'custom', pdfCustom: { main: 'red', accent: '#FFFFFF' } });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(state.uploads.length, 0);
  // 白事：忽略传入的预设 / 颜色
  db.data.books[0].type = 'funeral';
  r = await fn.main({ action: 'bookPreview', bookId: 'b1', pdfTheme: 'wine_gold', pdfCustom: { main: '#FF0000', font: 'sans', pattern: 'line', mark: '奠' } });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(isPdf(state.uploads[0]));
  assert.strictEqual(writes().length, 0);
});

t('预览：字体不可用时回退黑体并提示；黑体不可用报错', async () => {
  seed();
  let { fn } = load(fileID => { if (fileID.endsWith(F.FONT_FILES.serif)) throw new Error('network'); return files[Object.keys(F.FONT_FILES).find(k => fileID.endsWith(F.FONT_FILES[k]))]; });
  let r = await fn.main({ action: 'bookPreview', bookId: 'b1', pdfTheme: 'wine_gold' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(r.data.notice && r.data.notice.includes('预览使用了回退字体'));
  ({ fn } = load(() => { throw new Error('network'); }));
  r = await fn.main({ action: 'bookPreview', bookId: 'b1' });
  assert.strictEqual(r.code, 1);
});

// —— v3.54.0 封底：去掉主家 / 日期 / 合计，记账人签名自动填写 ——
const BT = require('../cloudfunctions/export/themes.js');
function fakeDoc() {
  const texts = [];
  const d = new Proxy({}, { get: (_, k) => {
    if (k === 'text') return (t) => { texts.push(String(t)); return d; };
    if (k === 'widthOfString') return (t) => String(t).length * 10;
    return () => d;
  } });
  return { doc: d, texts };
}
const backMeta = (signers, extra) => ({ bt: BT.resolve(false, 'wine_gold', null), back: BT.sanitizeBack({ sign: true, ...(extra || {}) }), bookType: 'wedding', accountName: '测试主家', bookDate: '2026-10-01', count: 8, sum: 828, signers });

t('封底：不再出现「主家：」「日期：」「合计」', async () => {
  const { _test } = load().fn;
  const { doc, texts } = fakeDoc();
  _test.drawBack(doc, backMeta({ names: ['张三'], total: 1 }));
  const all = texts.join('|');
  assert.ok(!/主家：|日期：|合计/.test(all), all);
  assert.ok(all.includes('记账人：张三'));
});

t('封底：经手人按笔数排序、最多 4 位、等 N 人，不含 openid', async () => {
  const { _test } = load().fn;
  const mk = (n, o, nm) => Array.from({ length: n }, () => ({ handlerOpenid: o, handlerName: nm }));
  const rows = [...mk(1, 'oA', '甲'), ...mk(3, 'oB', '乙'), ...mk(2, 'oC', '丙'), ...mk(1, 'oD', '丁'), ...mk(1, 'oE', '戊'), ...mk(1, 'oF', '')];
  const sg = _test.signersOf(rows);
  assert.deepStrictEqual(sg.names, ['乙', '丙', '甲', '丁']);
  assert.strictEqual(sg.total, 5);
  assert.strictEqual(_test.signText(sg), '乙　丙　甲　丁等 5 人');
  const { doc, texts } = fakeDoc();
  _test.drawBack(doc, backMeta(sg));
  assert.ok(texts.join('|').includes('记账人：乙　丙　甲　丁等 5 人'));
  assert.ok(!/oA|oB|oC|oD|oE/.test(JSON.stringify(sg) + texts.join('')));
  assert.deepStrictEqual(_test.signersOf([{ handlerName: 'oAbCdEfGhIjKlMnOpQrSt1' }]).names, [], '形似 openid 的名字丢弃');
});

t('封底：没有经手人时留空白签字横线', async () => {
  const { _test } = load().fn;
  assert.deepStrictEqual(_test.signersOf([{ amount: 1 }]), { names: [], total: 0 });
  const { doc, texts } = fakeDoc();
  _test.drawBack(doc, backMeta({ names: [], total: 0 }));
  assert.ok(texts.includes('记账人（签字）'));
});

t('封底：预览 bookPreviewData 返回经手人姓名，不带 openid；buildMeta 带 signers', async () => {
  seed();
  db.data.records.forEach((r, i) => { r.handlerOpenid = i < 5 ? 'o-secret-1' : 'o-secret-2'; r.handlerName = i < 5 ? '张会计' : '李记账'; });
  const { fn } = load();
  const r = await fn.main({ action: 'bookPreviewData', bookId: 'b1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.deepStrictEqual(r.data.signers, { names: ['张会计', '李记账'], total: 2 });
  assert.ok(!JSON.stringify(r.data).includes('o-secret'));
});

t('sanitizeBack：兼容旧字段 host / date / sum，不再输出', async () => {
  const b = BT.sanitizeBack({ on: true, footer: '福', host: true, date: false, sum: false, sign: true, brand: true });
  assert.deepStrictEqual(Object.keys(b).sort(), ['brand', 'footer', 'on', 'sign']);
  assert.strictEqual(b.sign, true);
  assert.deepStrictEqual(BT.sanitizeBack(null), { on: true, footer: '', sign: true, brand: true }); // v3.54.1 签名栏默认开
  assert.strictEqual(BT.sanitizeBack({ sign: false }).sign, false, '明确关闭的仍保持关闭');
});

// —— v3.55.0 默认主题按礼簿类型 ——
const PT = require('../miniprogram/pages/booktheme/pdftheme.js');
const DEF_TABLE = { wedding: ['red_gold', '囍'], birthday: ['shou_gold', '寿'], baby: ['orange', '福'], house: ['purple_gold', '福'], funeral: ['grey', '奠'], other: ['red_gold', ''] };

test('默认主题：typeDefault 映射表与未知类型', () => {
  for (const [ty, [key, mark]] of Object.entries(DEF_TABLE)) assert.deepStrictEqual(BT.typeDefault(ty), { key, mark }, ty);
  assert.deepStrictEqual(BT.typeDefault('xxx'), BT.typeDefault('other'));
  assert.deepStrictEqual(BT.typeDefault(undefined), { key: 'red_gold', mark: '' });
  BT.typeDefault('wedding').mark = 'X';
  assert.strictEqual(BT.typeDefault('wedding').mark, '囍', '返回副本，不污染映射表');
});

test('默认主题：resolveDefault 的 key / main / mark', () => {
  const w = BT.resolveDefault('wedding');
  assert.strictEqual(w.key, 'red_gold'); assert.strictEqual(w.main, '#B71C1C'); assert.strictEqual(w.mark, '囍');
  assert.strictEqual(BT.resolveDefault('birthday'), BT.PRESETS.find(p => p.key === 'shou_gold'), '预设自带寿，直接用预设');
  assert.strictEqual(BT.resolveDefault('baby').mark, '福');
  assert.strictEqual(BT.resolveDefault('house').key, 'purple_gold');
  assert.strictEqual(BT.resolveDefault('other').mark, '');
  const f = BT.resolveDefault('funeral');
  assert.strictEqual(f.key, 'grey'); assert.strictEqual(f.main, '#555555'); assert.strictEqual(f.mark, '奠'); assert.ok(f.funeral);
  assert.strictEqual(BT.PRESETS.find(p => p.key === 'red_gold').mark, '', '不改动预设表本身');
});

test('默认主题：前后端映射一致', () => {
  assert.deepStrictEqual(PT.TYPE_DEFAULTS, BT.TYPE_DEFAULTS);
  for (const ty of Object.keys(DEF_TABLE).concat(['zzz'])) assert.deepStrictEqual(PT.typeDefault(ty), BT.typeDefault(ty));
  // 前端预选：与后端 resolveDefault 展开后一致
  for (const ty of ['wedding', 'birthday', 'baby', 'house', 'other']) {
    const sel = PT.defaultSelection(ty), bt = BT.resolveDefault(ty);
    const c = sel.cust || PT.expand(sel.themeKey);
    assert.strictEqual(c.mark, bt.mark, ty); assert.strictEqual(c.main, bt.main, ty);
    assert.strictEqual(sel.base || sel.themeKey, bt.key, ty);
  }
  assert.strictEqual(PT.defaultSelection('wedding').themeKey, 'custom');
  assert.strictEqual(PT.defaultSelection('birthday').themeKey, 'shou_gold');
});

t('默认主题：pdfTheme 为空时 buildMeta 按类型；已保存的不受影响', async () => {
  seed();
  const { fn } = load();
  const bm = (book, extra) => fn._test.buildMeta([], { account: { accountName: 'x' }, book, startDay: '', endDay: '', themeName: '', pdfThemeKey: '', pdfCustom: null, ...(extra || {}) });
  for (const [ty, [key, mark]] of Object.entries(DEF_TABLE)) {
    const m = bm({ type: ty, name: 'n' });
    assert.strictEqual(m.bt.key, key, ty); assert.strictEqual(m.bt.mark, mark, ty);
  }
  assert.strictEqual(bm({ type: 'wedding' }).bt.main, '#B71C1C');
  assert.strictEqual(bm({ type: 'funeral' }).bt.main, '#555555');
  assert.strictEqual(bm({ type: 'mystery' }).bt.mark, '');
  // 已保存：预设 / 自定义不变（红金仍无水印）
  assert.strictEqual(bm({ type: 'wedding' }, { pdfThemeKey: 'red_gold' }).bt.mark, '');
  assert.strictEqual(bm({ type: 'wedding' }, { pdfThemeKey: 'peach' }).bt.key, 'peach');
  const cu = bm({ type: 'baby' }, { pdfThemeKey: 'custom', pdfCustom: { main: '#0B3D6B', accent: '#F5D76E', mark: '' } });
  assert.strictEqual(cu.bt.key, 'custom'); assert.strictEqual(cu.bt.mark, '');
  assert.strictEqual(bm({ type: 'funeral' }, { pdfThemeKey: 'custom', pdfCustom: { mark: '' } }).bt.mark, '', '白事已保存无水印保持不变');
});

t('默认主题：导出 / 预览不写库；喜事无主题导出成功（囍用宋体）', async () => {
  seed();
  const { fn, calls } = load();
  let r = await fn.main({ action: 'bookPreview', bookId: 'b1' });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(isPdf(state.uploads[0]));
  assert.ok(names(calls).some(n => /Serif/i.test(n)), '囍水印需要宋体：' + names(calls));
  assert.ok(!('pdfTheme' in db.data.books[0]) && writes().length === 0, '没有把默认值写进 books');
});

// —— v3.62.0 会员预留：套餐关闭 pdfThemePremium ——
const NOPREM = { _id: 'plans', free: { name: '免费版', features: { pdfThemePremium: false } }, pro: { name: '专业版', features: {} } };

t('会员主题（v3.62.0）：套餐关闭时新选会员主题 / 自定义 / 尾页设置被拒，免费主题可导出', async () => {
  seed();
  db.seed('settings', [NOPREM]);
  const { fn } = load();
  for (const bad of [WINE, BRUSH, { format: 'book', bookId: 'b1', pdfTheme: 'peach', pdfBack: { on: true, footer: '百年好合' } }]) {
    const r = await fn.main(bad);
    assert.notStrictEqual(r.code, 0);
    assert.ok(/会员/.test(r.msg), r.msg);
  }
  assert.strictEqual(state.uploads.length, 0, '被拒时不生成文件');
  const ok = await fn.main({ format: 'book', bookId: 'b1', pdfTheme: 'peach' });
  assert.strictEqual(ok.code, 0, ok.msg);
});

t('会员主题（v3.62.0）：礼簿已存会员主题，套餐关闭后导出按免费样式降级，库里不改', async () => {
  seed();
  db.seed('settings', [NOPREM]);
  db.data.books[0].pdfTheme = { key: 'wine_gold' };
  const { fn, calls } = load();
  const r = await fn.main({ format: 'book', bookId: 'b1' });
  assert.strictEqual(r.code, 0, r.msg);
  // 降级为红金 + 婚礼默认水印「囍」：宋体只用来画囍字，正文黑体（酒红鎏金本身的宋体正文不再使用）
  assert.ok(names(calls).includes('NotoSansSC-Subset.ttf'));
  assert.ok(!names(calls).some(n => /Brush|Zheng/i.test(n)), names(calls).join());
  assert.strictEqual(db.data.books[0].pdfTheme.key, 'wine_gold');
  // 与已存完全一致的再次选择放行（只是重新导出）
  const again = await fn.main({ format: 'book', bookId: 'b1', pdfTheme: 'wine_gold' });
  assert.strictEqual(again.code, 0, again.msg);
});
