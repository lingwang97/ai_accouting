// v3.72.1：回执页导航浅灰黑字、白事不闪红；收款码选图压缩；宾客端交易用语改记账口径；提审文档与代码一致
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('receipt.json：导航栏 #F7F7F7 黑字；receipt.js 不再改导航色，model 与 themeStyle 同一次 setData，初始素灰', () => {
  const j = JSON.parse(read('miniprogram/pages/receipt/receipt.json'));
  assert.strictEqual(j.navigationBarBackgroundColor, '#F7F7F7');
  assert.strictEqual(j.navigationBarTextStyle, 'black');
  const s = read('miniprogram/pages/receipt/receipt.js');
  assert.ok(!/setNavigationBarColor/.test(s));
  assert.ok(/themeStyle: GRAY_STYLE/.test(s));
  assert.ok(/setData\(\{ model, bookType: [^}]*themeStyle: record\.bookType === 'funeral' \? GRAY_STYLE : RED_STYLE \}\)/.test(s));
});

function loadCompress(env) {
  global.wx = {
    compressImage: env.noCompress ? undefined : o => {
      env.calls.push(o.quality);
      if (env.fail) return o.fail({});
      o.success({ tempFilePath: o.src + '@q' + o.quality });
    },
    getFileSystemManager: () => ({ getFileInfo: o => o.success({ size: env.sizes[o.filePath] !== undefined ? env.sizes[o.filePath] : 100 }) })
  };
  const p = require.resolve('../miniprogram/utils/imgcompress.js');
  delete require.cache[p];
  return require(p);
}

test('imgcompress.payCode：≤300KB 原图；大图质量 80，仍大再压 60；失败 / 无接口用原图', async () => {
  let env = { calls: [], sizes: {} };
  assert.strictEqual(await loadCompress(env).payCode('a.png', 200 * 1024), 'a.png');
  assert.deepStrictEqual(env.calls, []);
  env = { calls: [], sizes: { 'b.png@q80': 200 * 1024 } };
  assert.strictEqual(await loadCompress(env).payCode('b.png', 3 * 1024 * 1024), 'b.png@q80');
  assert.deepStrictEqual(env.calls, [80]);
  env = { calls: [], sizes: { 'c.png@q80': 500 * 1024 } };
  assert.strictEqual(await loadCompress(env).payCode('c.png', 3 * 1024 * 1024), 'c.png@q80@q60');
  assert.deepStrictEqual(env.calls, [80, 60]);
  env = { calls: [], sizes: {}, fail: true };
  assert.strictEqual(await loadCompress(env).payCode('d.png', 3 * 1024 * 1024), 'd.png');
  env = { calls: [], sizes: {}, noCompress: true };
  assert.strictEqual(await loadCompress(env).payCode('e.png', 3 * 1024 * 1024), 'e.png');
  delete global.wx;
});

test('收款码三处选图都先压缩再上传', () => {
  for (const f of ['pages/account/account.js', 'pages/bookedit/bookedit.js', 'pages/setup/setup.js']) {
    const s = read('miniprogram/' + f);
    assert.ok(/imgc\.payCode\(f\.tempFilePath, f\.size\)/.test(s), f);
  }
});

test('宾客端与用户可见文案不用「付款 / 支付」（微信菜单名「收付款」除外）', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const bad = [];
  for (const f of walk(path.join(ROOT, 'miniprogram')).filter(x => /\.(wxml|js|json)$/.test(x))) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = /\.wxml$/.test(f) ? line.replace(/<!--.*?-->/g, '') : line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (/^\s*\*/.test(code)) return;
      const t = code.replace(/收付款/g, '');
      if (/付款|支付/.test(t) && /[>'"`]/.test(t)) bad.push(path.relative(ROOT, f) + ':' + (i + 1));
    });
  }
  assert.deepStrictEqual(bad, []);
});

test('提审文档：审核备注用第二个微信扫码；索引 31 条与 system INDEXES 一致；触发器只有 warmer / export', () => {
  const doc = read('docs/提审与隐私说明.md');
  assert.ok(doc.includes('请用第二个微信扫这个礼簿码'));
  const src = read('cloudfunctions/system/index.js').replace(/\r/g, '');
  const names = [...src.match(/const INDEXES = \[([\s\S]*?)\n\];/)[1].matchAll(/\['(\w+)', '(\w+)'/g)].map(m => m[1] + '|' + m[2]);
  assert.strictEqual(names.length, 31);
  names.forEach(n => { const [c, i] = n.split('|'); assert.ok(doc.includes(`| ${c} | ${i} |`), n); });
  for (const fn of fs.readdirSync(path.join(ROOT, 'cloudfunctions'))) {
    const p = path.join(ROOT, 'cloudfunctions', fn, 'config.json');
    if (!fs.existsSync(p)) continue;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (cfg.triggers) assert.ok(['warmer', 'export'].includes(fn), fn + ' 有触发器');
    (cfg.permissions && cfg.permissions.openapi || []).forEach(api => assert.ok(doc.includes(api), fn + ' ' + api));
  }
});
