// v3.64.2 起的界面修复：回执图片标题超宽缩字 / 截断（receipt.fitTitle）
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const receipt = require('../miniprogram/utils/receipt.js');

// 假画布：每个汉字宽度 = 字号
function fakeCtx() {
  const ctx = { font: '' };
  ctx.measureText = s => {
    const size = Number((/(\d+)px/.exec(ctx.font) || [])[1]) || 0;
    return { width: Array.from(String(s)).length * size };
  };
  return ctx;
}

test('fitTitle：短标题保持 44px', () => {
  const r = receipt.fitTitle(fakeCtx(), '礼金回执', 630, 'sans-serif');
  assert.ok(/bold 44px/.test(r.font));
  assert.strictEqual(r.text, '礼金回执');
});
test('fitTitle：超宽先缩字号，放得下就不截断', () => {
  const r = receipt.fitTitle(fakeCtx(), '一二三四五六七八九十一二三四五六', 630, 'sans-serif'); // 16 字 → 39px 放不下 ≤ 630 的最大偶数字号 38
  assert.ok(/bold 38px/.test(r.font), r.font);
  assert.strictEqual(r.text.length, 16);
});
test('fitTitle：缩到 30px 仍放不下才截断并加省略号', () => {
  const r = receipt.fitTitle(fakeCtx(), '一二三四五六七八九十一二三四五六七八九十', 630, 'serif'); // 20 字 * 30 = 600 放得下
  assert.ok(/bold 30px serif/.test(r.font), r.font);
  const r2 = receipt.fitTitle(fakeCtx(), 'x'.repeat(40).replace(/x/g, '字'), 630, 'sans-serif'); // 40 字
  assert.ok(r2.text.endsWith('…') && r2.text.length * 30 <= 630 + 30);
});
