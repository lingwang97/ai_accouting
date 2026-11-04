// v3.86.4 界面检查 G1/G2/G4：records 状态条标签缩窄、换排序 / 重名后重测渐变箭头、注释更新
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { ROOT } = require('./helpers/sdk-stub.js');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('G1 records 状态条标签：不拉伸（flex:none），字号 >=22rpx，左右 padding 12rpx', () => {
  const s = read('miniprogram/pages/records/records.wxss');
  const m = s.match(/\.filter-row \.st-seg \.seg-item \{([^}]*)\}/);
  assert.ok(m, '缺少 .st-seg .seg-item 规则');
  assert.ok(/flex: none/.test(m[1]) && !/flex: 1/.test(m[1]));
  assert.ok(/padding: 8rpx 12rpx/.test(m[1]));
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
