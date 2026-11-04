// v3.86.4 界面检查 G1/G2/G4：records 状态条标签缩窄、换排序 / 重名后重测渐变箭头、注释更新
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { ROOT } = require('./helpers/sdk-stub.js');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('G1 records 状态条标签：外层 flex:none 只管点击区，字号 >=22rpx，选中底色画在内层 .st-pill（v3.86.6）', () => {
  const s = read('miniprogram/pages/records/records.wxss');
  const m = s.match(/\.filter-row \.st-seg \.seg-item \{([^}]*)\}/);
  assert.ok(m, '缺少 .st-seg .seg-item 规则');
  assert.ok(/flex: none/.test(m[1]) && !/flex: 1/.test(m[1]));
  const fs2 = Number(m[1].match(/font-size: (\d+)rpx/)[1]);
  assert.ok(fs2 >= 22, '字号不能小于 22rpx');
  assert.ok(/\.seg-item\.on \{ background: transparent;/.test(s), '外层选中态不能带底色（盖掉全局 .seg-item.on）');
  assert.ok(/\.seg-item\.on \.st-pill \{ background: var\(--primary\)/.test(s), '底色只画在内层 pill');
  assert.ok(read('miniprogram/pages/records/records.wxml').includes('<text class="st-pill">{{item}}</text>'));
});

test('G2 onSort / onDup 之后重新测量状态条渐变箭头', () => {
  const j = read('miniprogram/pages/records/records.js');
  const sort = j.match(/onSort\(e\) \{[\s\S]*?\n  \},/)[0];
  const dup = j.match(/onDup\(\) \{[\s\S]*?\n  \},/)[0];
  assert.ok(/setTimeout\(\(\) => this\.measureSt\(\), 100\)/.test(sort));
  assert.ok(/setTimeout\(\(\) => this\.measureSt\(\), 100\)/.test(dup));
});

test('G4 records.wxss 注释不再写「屏宽够就平分」', () => {
  const s = read('miniprogram/pages/records/records.wxss');
  assert.ok(!s.includes('屏宽够就平分'));
  assert.ok(s.includes('不拉伸'));
});

test('v3.86.6 两处标签条：选中底色画在内层 pill（文字 + 小空白），外层只管点击区，不再随外层宽度变宽', () => {
  const mg = read('miniprogram/components/my-gifts/index.wxss');
  const m = mg.match(/\.mg-seg-item \{([^}]*)\}/);
  assert.ok(m, '缺少 .mg-seg-item 规则');
  assert.ok(/flex: none/.test(m[1]) && !/background/.test(m[1]), '外层不带底色');
  assert.ok(/\.mg-seg-item\.on \.mg-pill \{ background: var\(--primary\)/.test(mg), '底色只画在 .mg-pill');
  assert.ok(!/\.mg-seg-item\.on \{ background/.test(mg));
  assert.ok(/<text class="mg-pill">\{\{item\.t\}\}/.test(read('miniprogram/components/my-gifts/index.wxml')));
});
