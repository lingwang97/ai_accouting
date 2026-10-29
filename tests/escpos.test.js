// 小票 ESC/POS 字节流（v3.56.0）：新字段、默认值、留白、折行、旧模板兼容
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const escpos = require('../miniprogram/utils/escpos.js');
const gbk = require('../miniprogram/utils/gbk.js');

const REC = { _id: 'abcdef123456', payerName: '张三', amount: 88.5, payMethod: 'wechat', paidAt: new Date('2026-10-10T12:30:00'), accountName: '李府', handlerName: '王记账', bookType: 'wedding' };
const build = (rec, tpl, opts) => Array.from(new Uint8Array(escpos.buildReceipt({ ...REC, ...rec }, tpl, opts)));
const has = (bytes, sub) => {
  const s = Buffer.from(bytes).toString('latin1');
  return s.includes(Buffer.from(sub).toString('latin1'));
};
const hasText = (bytes, str) => has(bytes, Array.from(gbk.encode(str)));

test('escpos：默认留白上 1 行、下 5 行，末尾切纸', () => {
  const b = build({}, { paperWidth: 32, fields: escpos.DEFAULT_FIELDS });
  assert.deepStrictEqual(b.slice(0, 5), [0x1b, 0x40, 0x1b, 0x64, 1]);
  assert.deepStrictEqual(b.slice(-7), [0x1b, 0x64, 5, 0x1d, 0x56, 0x42, 0x00]);
});

test('escpos：留白可调，上 0 行不输出走纸指令，范围夹紧', () => {
  const b0 = build({}, { fields: ['amount'], feedTop: 0, feedBottom: 2 });
  assert.deepStrictEqual(b0.slice(0, 2), [0x1b, 0x40]);
  assert.notDeepStrictEqual(b0.slice(2, 4), [0x1b, 0x64]);
  assert.deepStrictEqual(b0.slice(-7, -4), [0x1b, 0x64, 2]);
  const t = escpos.withDefaults({ feedTop: 99, feedBottom: 0 });
  assert.strictEqual(t.feedTop, 4);
  assert.strictEqual(t.feedBottom, 2);
});

test('escpos：旧模板缺新字段取默认值，且旧字段集不变', () => {
  const t = escpos.withDefaults({ paperWidth: 32, fields: ['title', 'amount'], title: 'x' });
  assert.strictEqual(t.amountSize, 'double');
  assert.strictEqual(t.titleBold, true);
  assert.strictEqual(t.showHandler, true);
  assert.strictEqual(t.footer, '');
  assert.deepStrictEqual(t.fields, ['title', 'amount']);
  const b = build({}, { fields: ['title', 'amount'], title: 'x' });
  assert.ok(!hasText(b, '大写：') && !hasText(b, '编号：'));
});

test('escpos：金额大写、编号、支付方式、页脚', () => {
  const b = build({}, { fields: ['amount', 'amountUpper', 'receiptNo', 'payMethod'], footer: '电话 13800000000', promo: false });
  assert.ok(hasText(b, '大写：捌拾捌元伍角整'));
  assert.ok(hasText(b, '编号：R20261010123456'));
  assert.ok(hasText(b, '方式：微信'));
  assert.ok(hasText(b, '电话 13800000000'));
  const c = build({ payMethod: 'cash' }, { fields: ['amount', 'payMethod'], promo: false });
  assert.ok(hasText(c, '方式：现金'));
  assert.ok(!hasText(c, '（现金）')); // 有「方式」行时不重复标注
  const d = build({ payMethod: 'cash' }, { fields: ['amount'], promo: false });
  assert.ok(hasText(d, '（现金）')); // 旧行为保持
});

test('escpos：金额字号三档、记账人开关、主家称呼始终打印', () => {
  const sz = n => build({}, { fields: ['amount'], amountSize: n, promo: false });
  assert.ok(has(sz('double'), [0x1d, 0x21, 0x11]));
  assert.ok(has(sz('tall'), [0x1d, 0x21, 0x01]));
  assert.ok(!has(sz('normal'), [0x1d, 0x21, 0x11]));
  const on = build({}, { fields: ['title'], promo: false });
  assert.ok(hasText(on, '记账：王记账'));
  const off = build({}, { fields: ['title'], showHandler: false, promo: false });
  assert.ok(!hasText(off, '记账：') && hasText(off, '主家：李府'));
});

test('escpos：标题靠左 / 加粗开关', () => {
  const l = build({}, { fields: ['title'], titleAlign: 'left', titleBold: false, promo: false });
  assert.ok(!has(l, [0x1b, 0x45, 0x01]));
  assert.ok(!has(l, [0x1b, 0x61, 0x01]));
});

test('escpos：长文本按 32 列折行不截断', () => {
  const long = '礼品是一对花篮外加两条红色的毛巾和一箱牛奶谢谢你们的到来';
  const rows = escpos.wrap(long, 32);
  assert.ok(rows.length >= 2);
  assert.strictEqual(rows.join(''), long);
  rows.forEach(r => assert.ok(gbk.encode(r).length <= 32));
});

test('escpos：白事不印推广语；二维码字节插在致谢之后', () => {
  const f = build({ bookType: 'funeral' }, { fields: ['thanks'], thanks: '叩谢', promo: true });
  assert.ok(!hasText(f, '慧礼记'));
  const q = build({}, { fields: ['thanks'], thanks: '叩谢', promo: false }, { qr: [0x1d, 0x28, 0x6b] });
  assert.ok(has(q, [0x1d, 0x28, 0x6b]));
});
