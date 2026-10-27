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

// ---- v3.64.3 白事校正与会员版式降级
test('白事：旧模板的红色卡片 / 喜庆版式读取时校正为简约 + 灰黑主色；合规的原样保留', () => {
  const t = receipt.normalizeTpl({ style: 'card', color: '#C8161D', fields: ['payerName'] }, 'funeral');
  assert.strictEqual(t.style, 'simple');
  assert.strictEqual(t.color, '#333333');
  const f = receipt.normalizeTpl({ style: 'festive', color: '#555555', fields: ['payerName'] }, 'funeral');
  assert.strictEqual(f.style, 'simple');
  assert.strictEqual(f.color, '#555555');
  const ok = receipt.normalizeTpl({ style: 'elegant', color: '#777777', fields: ['payerName'] }, 'funeral');
  assert.strictEqual(ok.style, 'elegant');
  assert.strictEqual(ok.color, '#777777');
});
test('非白事不被校正；未保存模板的白事默认值本来就合规', () => {
  const w = receipt.normalizeTpl({ style: 'festive', color: '#C8161D', fields: ['payerName'] }, 'wedding');
  assert.strictEqual(w.style, 'festive');
  const d = receipt.normalizeTpl(null, 'funeral');
  assert.ok(receipt.FUNERAL_STYLES.includes(d.style) && receipt.isGrey(d.color));
});
test('isGrey 与白事色板', () => {
  assert.ok(receipt.FUNERAL_COLORS.every(receipt.isGrey));
  assert.ok(!receipt.isGrey('#C8161D') && !receipt.isGrey('') && !receipt.isGrey(undefined));
});
test('buildModel：套餐关闭会员版式（premiumOpen=false）预览降成 card；免费版式与开放时不变', () => {
  const rec = { ...receipt.SAMPLE.record };
  const tpl = { ...receipt.DEFAULT_TPL, style: 'guofeng' };
  assert.strictEqual(receipt.buildModel(rec, tpl, '张府', { premiumOpen: false }).style, 'card');
  assert.strictEqual(receipt.buildModel(rec, tpl, '张府', { premiumOpen: true }).style, 'guofeng');
  assert.strictEqual(receipt.buildModel(rec, tpl, '张府').style, 'guofeng');
  assert.strictEqual(receipt.buildModel(rec, { ...tpl, style: 'elegant' }, '张府', { premiumOpen: false }).style, 'elegant');
});

// ---- v3.65.0 高峰模式提示条的剩余时间文案
test('advperm.peakLeftText：未开启 / 已到期为空；小时分钟；不足 1 分钟按 1 分钟；整点不出「60 分钟」', () => {
  const A = require('../miniprogram/utils/advperm.js');
  const now = 1e12, HOUR = 3600000;
  assert.strictEqual(A.peakLeftText(0, now), '');
  assert.strictEqual(A.peakLeftText(now, now), '');
  assert.strictEqual(A.peakLeftText(now - 5, now), '');
  assert.strictEqual(A.peakLeftText(now + 7 * HOUR + 30 * 60000, now), '7 小时 30 分钟');
  assert.strictEqual(A.peakLeftText(now + 20 * 60000, now), '20 分钟');
  assert.strictEqual(A.peakLeftText(now + 5000, now), '1 分钟');
  assert.strictEqual(A.peakLeftText(now + 2 * HOUR, now), '2 小时 0 分钟');
  assert.strictEqual(A.peakLeftText(now + HOUR + 59 * 60000 + 30000, now), '2 小时 0 分钟');
});
