// v3.86.7：五项标签条（随礼记录 my-gifts、礼簿页 records 状态分段）退回 v3.86.0 的样式
// 经过：v3.86.1 起改 scroll-view 横滑 + 渐变箭头，几轮改动后选中高亮宽度仍不满意（真机上看不到、靠推理调，没调准），用户要求退回
// 退回后：普通 view + overflow-x:auto，5 个标签平分宽度（flex:1 0 auto），和其他页面的分段按钮同风格；没有「›」提示和自动滑动
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');

const root = path.join(__dirname, '../miniprogram');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('v3.86.7 my-gifts 标签条：普通 view + overflow-x:auto，没有 scroll-view / pill / 渐变箭头', () => {
  const w = read('components/my-gifts/index.wxml');
  const c = read('components/my-gifts/index.wxss');
  const j = read('components/my-gifts/index.js');
  assert.ok(/<view class="mg-seg">/.test(w) && !/scroll-view/.test(w) && !/mg-pill/.test(w) && !/mg-seg-fade/.test(w));
  assert.ok(/\.mg-seg \{[^}]*overflow-x: auto/.test(c) && /\.mg-seg-item \{[^}]*flex: 1 0 auto/.test(c));
  assert.ok(!/segTo|segFade|measureSeg/.test(j));
});

test('v3.86.7 records 状态分段：普通 view + overflow-x:auto，没有 scroll-view / pill / 渐变箭头', () => {
  const w = read('pages/records/records.wxml');
  const c = read('pages/records/records.wxss');
  const j = read('pages/records/records.js');
  assert.ok(/<view class="seg st-seg">/.test(w) && !/class="st-seg" scroll-x/.test(w) && !/st-pill|st-fade/.test(w));
  assert.ok(/\.st-seg \{[^}]*overflow-x: auto/.test(c) && /\.st-seg \.seg-item \{[^}]*flex: 1 0 auto/.test(c));
  assert.ok(!/stFade|measureSt|onStScroll/.test(j));
});

test('v3.86.7 保留的其他界面修复：F6「开启变更提醒」点击区、F8 records 标签单独一行', () => {
  assert.ok(/\.mg-resub \{[^}]*padding: 18rpx 16rpx/.test(read('components/my-gifts/index.wxss')));
  assert.ok(read('pages/records/records.wxml').includes('class="r-tags"') && /\.r-tags \{/.test(read('pages/records/records.wxss')));
});

test('v3.86.8 礼簿管理：「归档」和「编辑」同色（不再用 .gray 浅灰）', () => {
  const w = read('pages/books/books.wxml');
  const c = read('pages/books/books.wxss');
  assert.ok(/<view class="op-link" [^>]*onArchive">归档<\/view>/.test(w));
  assert.ok(!/op-link gray/.test(w) && !/\.op-link\.gray/.test(c));
});

test('v3.86.9 主包不放只被分包用的 JS：pvfont / orgtext 在 booktheme 分包，vip 在 booktheme 与 receiptset 各一份', () => {
  ['pvfont.js', 'orgtext.js', 'vip.js'].forEach(f => assert.ok(!fs.existsSync(path.join(root, 'utils', f)), 'utils/' + f + ' 应已移出主包'));
  ['pvfont.js', 'orgtext.js', 'vip.js'].forEach(f => assert.ok(fs.existsSync(path.join(root, 'pages/booktheme', f)), 'booktheme/' + f));
  assert.ok(fs.existsSync(path.join(root, 'pages/receiptset/vip.js')));
  const bt = read('pages/booktheme/booktheme.js');
  assert.ok(bt.includes("require('./vip.js')") && bt.includes("require('./orgtext.js')") && bt.includes("require('./pvfont.js')"));
  assert.ok(read('pages/receiptset/receiptset.js').includes("require('./vip.js')"));
  assert.ok(read('pages/booktheme/pvfont.js').includes("require('../../utils/request.js')"));
  assert.strictEqual(read('pages/booktheme/vip.js').split('\n').slice(1).join('\n'), read('pages/receiptset/vip.js').split('\n').slice(1).join('\n'), '两份 vip.js 正文一致');
});
