// 导出字体加载（云存储 -> /tmp 缓存）：下载成功 / 失败 / 已缓存 / 未上传 / 文件损坏，以及黑体、宋体、毛笔的失败处理
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('./helpers/harness.js');
const F = require('../cloudfunctions/export/fonts.js');

const FONT_DIR = path.join(__dirname, '..', 'tools', 'fonts');
const files = Object.fromEntries(Object.entries(F.FONT_FILES).map(([k, n]) => [k, fs.readFileSync(path.join(FONT_DIR, n))]));
const metaOf = (keys = ['sans', 'serif', 'brush']) => ({
  fonts: Object.fromEntries(keys.map(k => [k, { fileID: 'cloud://env/export-fonts/' + F.FONT_FILES[k], name: F.FONT_FILES[k], size: files[k].length, sha256: F.sha256(files[k]) }]))
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hlj-font-test-'));
/** 造一个 loader：calls 记下载次数；mode 控制下载行为 */
function mk(opts = {}) {
  const calls = [];
  let t = 0;
  const loader = F.createLoader({
    tmpDir: opts.tmpDir || tmp(),
    now: () => t,
    getMeta: async () => (opts.meta === undefined ? metaOf() : (typeof opts.meta === 'function' ? opts.meta() : opts.meta)),
    download: async fileID => {
      calls.push(fileID);
      if (opts.download) return opts.download(fileID);
      const key = Object.keys(F.FONT_FILES).find(k => fileID.endsWith(F.FONT_FILES[k]));
      return files[key];
    }
  });
  return { loader, calls, tick: ms => { t += ms; } };
}

test('下载成功：取到字体、校验通过、写入 /tmp 缓存；同一实例再取不再下载', async () => {
  const dir = tmp();
  const { loader, calls } = mk({ tmpDir: dir });
  const r = await loader.prepare(['sans']);
  assert.deepStrictEqual(r.failed, {});
  assert.ok(Buffer.compare(r.buffers.sans, files.sans) === 0);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.ttf')).length, 1);
  assert.strictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.part')).length, 0, '不留临时文件');
  await loader.prepare(['sans']);
  assert.strictEqual(calls.length, 1);
});

test('/tmp 已缓存（新实例、内存为空）：不下载，直接读缓存', async () => {
  const dir = tmp();
  await mk({ tmpDir: dir }).loader.prepare(['sans', 'brush']);
  const { loader, calls } = mk({ tmpDir: dir, download: () => { throw new Error('不该下载'); } });
  const r = await loader.prepare(['sans', 'brush']);
  assert.deepStrictEqual(r.failed, {});
  assert.strictEqual(calls.length, 0);
  assert.ok(Buffer.compare(r.buffers.brush, files.brush) === 0);
});

test('/tmp 缓存损坏（被截断）：丢弃并重新下载', async () => {
  const dir = tmp();
  await mk({ tmpDir: dir }).loader.prepare(['sans']);
  const f = fs.readdirSync(dir).find(x => x.endsWith('.ttf'));
  fs.writeFileSync(path.join(dir, f), files.sans.slice(0, 5000));
  const { loader, calls } = mk({ tmpDir: dir });
  const r = await loader.prepare(['sans']);
  assert.deepStrictEqual(r.failed, {});
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(fs.statSync(path.join(dir, f)).size, files.sans.length);
});

test('下载失败：prepare 不抛错，failed 带 DOWNLOAD；之后重试可恢复（失败不会被缓存）', async () => {
  let down = true;
  const { loader, calls } = mk({ download: fileID => { if (down) throw new Error('network'); return files.sans; } });
  let r = await loader.prepare(['sans']);
  assert.strictEqual(r.failed.sans.code, 'DOWNLOAD');
  assert.ok(!r.buffers.sans);
  down = false;
  r = await loader.prepare(['sans']);
  assert.deepStrictEqual(r.failed, {});
  assert.strictEqual(calls.length, 2);
});

test('下载内容损坏（大小或 sha256 不符 / 不是 TTF）：CORRUPT，不写缓存', async () => {
  const dir = tmp();
  for (const bad of [files.sans.slice(0, 4096), Buffer.concat([Buffer.from([0, 1, 0, 1]), files.sans.slice(4)]), Buffer.from('<html>error</html>'.repeat(100))]) {
    const { loader } = mk({ tmpDir: dir, download: () => bad });
    const r = await loader.prepare(['sans']);
    assert.strictEqual(r.failed.sans.code, 'CORRUPT');
  }
  assert.strictEqual(fs.readdirSync(dir).length, 0);
});

test('字体还没上传（无登记）：NOT_READY；上传后 15 秒内即可用', async () => {
  let meta = null;
  const { loader, tick } = mk({ meta: () => meta });
  let r = await loader.prepare(['sans']);
  assert.strictEqual(r.failed.sans.code, 'NOT_READY');
  meta = metaOf();
  r = await loader.prepare(['sans']); // 还在 15 秒缓存内
  assert.strictEqual(r.failed.sans && r.failed.sans.code, 'NOT_READY');
  tick(16 * 1000);
  r = await loader.prepare(['sans']);
  assert.deepStrictEqual(r.failed, {});
});

test('只登记了部分字体：其余字体 NOT_READY，已登记的正常', async () => {
  const { loader } = mk({ meta: metaOf(['sans']) });
  const r = await loader.prepare(['sans', 'serif']);
  assert.ok(r.buffers.sans && r.failed.serif.code === 'NOT_READY');
});

test('并发取同一字体只下载一次', async () => {
  const { loader, calls } = mk();
  const rs = await Promise.all([loader.prepare(['brush']), loader.prepare(['brush']), loader.prepare(['brush'])]);
  rs.forEach(r => assert.deepStrictEqual(r.failed, {}));
  assert.strictEqual(calls.length, 1);
});

// —— 失败处理策略（planFor）——
const prep = (have, failedCode = 'DOWNLOAD') => {
  const buffers = {}, failed = {};
  ['sans', 'serif', 'brush'].forEach(k => { if (have.includes(k)) buffers[k] = files[k]; else failed[k] = { code: failedCode, message: 'x' }; });
  return { buffers, failed };
};

test('表格 PDF：只要黑体；黑体失败报错（未上传提示「字体准备中」，下载失败提示重试）', () => {
  const plan = F.planFor('pdf', {});
  assert.deepStrictEqual(plan.keys, ['sans']);
  assert.ok(plan.resolve(prep(['sans'])).fonts.sans);
  assert.strictEqual(plan.resolve(prep([], 'NOT_READY')).error, '字体准备中，请稍后重试');
  assert.strictEqual(plan.resolve(prep([], 'DOWNLOAD')).error, '字体加载失败，请重试');
  assert.strictEqual(plan.resolve(prep([], 'CORRUPT')).error, '字体加载失败，请重试');
});

test('传统礼簿（黑体）：只要黑体；黑体失败报错', () => {
  const plan = F.planFor('book', { font: 'sans', mark: '' });
  assert.deepStrictEqual(plan.keys, ['sans']);
  const r = plan.resolve(prep(['sans']));
  assert.ok(r.fonts.main === files.sans, 'r.fonts.main');
  assert.ok(r.fonts.sub === files.sans, 'r.fonts.sub');
  assert.deepStrictEqual(r.notes, []);
  assert.ok(plan.resolve(prep([])).error);
});

test('传统礼簿（宋体）：宋体失败回退黑体并给提示；黑体失败仍报错', () => {
  const plan = F.planFor('book', { font: 'serif', mark: '' });
  assert.deepStrictEqual(plan.keys.sort(), ['sans', 'serif']);
  let r = plan.resolve(prep(['sans', 'serif']));
  assert.ok(r.fonts.main === files.serif, 'r.fonts.main'); assert.deepStrictEqual(r.notes, []);
  r = plan.resolve(prep(['sans']));
  assert.ok(r.fonts.main === files.sans, 'r.fonts.main');
  assert.ok(r.notes.length === 1 && r.notes[0].includes('宋体') && r.notes[0].includes('黑体'));
  assert.ok(plan.resolve(prep(['serif'])).error, '黑体缺失即使宋体在也报错（小字 / 回退都要黑体）');
});

test('传统礼簿（毛笔）：小字用黑体；毛笔失败回退黑体并提示；毛笔的水印字用宋体', () => {
  const plan = F.planFor('book', { font: 'brush', mark: '福' });
  assert.deepStrictEqual(plan.keys.sort(), ['brush', 'sans', 'serif']);
  let r = plan.resolve(prep(['sans', 'serif', 'brush']));
  assert.ok(r.fonts.main === files.brush, 'r.fonts.main');
  assert.ok(r.fonts.sub === files.sans, 'r.fonts.sub');
  assert.ok(r.fonts.mark === files.serif, 'r.fonts.mark');
  r = plan.resolve(prep(['sans', 'serif']));
  assert.ok(r.fonts.main === files.sans, 'r.fonts.main');
  assert.ok(r.notes[0].includes('毛笔'));
  r = plan.resolve(prep(['sans', 'brush'])); // 宋体缺：非「囍」的水印用黑体（毛笔字形不全），不报错
  assert.ok(r.fonts.mark === files.sans && !r.error && !r.dropMark, 'mark falls back to sans');
});

test('囍水印：宋体不可用时省略水印（黑体里没有囍字形），并提示', () => {
  const plan = F.planFor('book', { font: 'sans', mark: '囍' });
  assert.deepStrictEqual(plan.keys.sort(), ['sans', 'serif']);
  let r = plan.resolve(prep(['sans', 'serif']));
  assert.ok(r.fonts.mark === files.serif, 'r.fonts.mark'); assert.ok(!r.dropMark);
  r = plan.resolve(prep(['sans']));
  assert.ok(r.dropMark && r.notes[0].includes('水印'));
});

test('云函数 export 代码包里不再带字体数据（包体积）', () => {
  const dir = path.join(__dirname, '..', 'cloudfunctions', 'export');
  const big = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).size > 500 * 1024 && f !== 'package-lock.json');
  assert.deepStrictEqual(big, []);
  assert.ok(!fs.readdirSync(dir).some(f => /^font-.*\.js$/.test(f)));
});
