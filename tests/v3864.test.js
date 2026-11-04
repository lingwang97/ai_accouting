// v3.86.4 界面检查 G1/G2/G4：records 状态条标签缩窄、换排序 / 重名后重测渐变箭头、注释更新
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { ROOT } = require('./helpers/sdk-stub.js');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('G1 records 状态条标签：不拉伸（flex:none），字号 >=22rpx，高亮紧贴文字（v3.86.5：padding 8rpx + 透明 border 作点击区）', () => {
  const s = read('miniprogram/pages/records/records.wxss');
  const m = s.match(/\.filter-row \.st-seg \.seg-item \{([^}]*)\}/);
  assert.ok(m, '缺少 .st-seg .seg-item 规则');
  assert.ok(/flex: none/.test(m[1]) && !/flex: 1/.test(m[1]));
  assert.ok(/padding: 8rpx 8rpx/.test(m[1]) && /border-width: 0 6rpx/.test(m[1]) && /background-clip: padding-box/.test(m[1]));
  const fs2 = Number(m[1].match(/font-size: (\d+)rpx/)[1]);
  assert.ok(fs2 >= 22, '字号不能小于 22rpx');
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

test('v3.86.5 两处标签条：高亮紧贴文字（小 padding），点击区用透明 border + background-clip:padding-box 保留', () => {
  const mg = read('miniprogram/components/my-gifts/index.wxss');
  const m = mg.match(/\.mg-seg-item \{([^}]*)\}/);
  assert.ok(m, '缺少 .mg-seg-item 规则');
  assert.ok(/flex: none/.test(m[1]) && /padding: 12rpx 14rpx/.test(m[1]));
  assert.ok(/border-width: 0 10rpx/.test(m[1]) && /background-clip: padding-box/.test(m[1]));
  assert.ok(!/padding: 12rpx 26rpx/.test(m[1]), '高亮不能再比文字宽一倍');
});
