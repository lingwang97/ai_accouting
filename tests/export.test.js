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
