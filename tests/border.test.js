// 小票花边（v3.60.0）：无花边逐字节不变、折行宽度、手工对齐、倍大金额行、花纹带字节数、款式解析
const assert = require('assert');
const crypto = require('crypto');
const { test } = require('./helpers/harness.js');
const { dump } = require('./helpers/escdump.js');
const escpos = require('../miniprogram/utils/escpos.js');
const bt = require('../miniprogram/utils/bordertiles.js');

const REC = { _id: 'abcdef123456', payerName: '张三', amount: 88.5, payMethod: 'cash', paidAt: new Date('2026-10-10T12:30:00'), accountName: '李府', handlerName: '王记账', bookType: 'wedding', themeName: '新婚之喜', remark: '另送花篮一对，祝福百年好合白头偕老', relation: '同学' };
const QR = [0x1d, 0x76, 0x30, 0, 2, 0, 2, 0, 1, 2, 3, 4];
const QR_OLD = [0x1d, 0x76, 0x30, 0, 1, 0, 1, 0, 0xff]; // 生成上面哈希时用的码图字节
const build = (tpl, rec, opts) => escpos.buildReceipt({ ...REC, ...rec }, tpl, opts);
const sha = buf => crypto.createHash('sha1').update(Buffer.from(buf)).digest('hex');

test('花边：未开启（缺字段 / off）时小票字节与 v3.59.5 逐字节一致', () => {
  // 期望值是 v3.59.5 的 escpos.js 对同一批输入生成的 SHA1
  const cases = [
    [{ paperWidth: 32, fields: escpos.DEFAULT_FIELDS, thanks: '感谢光临' }, undefined, 'a8a2ece7b11638a89a0d483b6fe26c86cc028661'],
    [{ paperWidth: 32, fields: escpos.DEFAULT_FIELDS, thanks: '感谢光临' }, { qr: QR_OLD }, '8314fc853b6bbdc4831eb30c25cdec8b7c82097c'],
    [{ paperWidth: 48, fields: [...escpos.DEFAULT_FIELDS, 'relation', 'payMethod'], amountSize: 'tall', footer: '电话13800000000' }, undefined, 'a846e5c56690b6412a340ed853a231fece5b00b2'],
    [{ paperWidth: 48, fields: [...escpos.DEFAULT_FIELDS, 'relation', 'payMethod'], amountSize: 'tall', footer: '电话13800000000' }, { qr: QR_OLD }, '3d7beca025b4c3088e9b69df65f466d4872d681d'],
    [{ paperWidth: 32, fields: ['title', 'amount'], amountSize: 'normal', titleAlign: 'left' }, undefined, '4a5c1341244b67cdeeb06b1c4bc3b2207d40b192'],
    [{ paperWidth: 32, fields: ['title', 'amount'], amountSize: 'normal', titleAlign: 'left' }, { qr: QR_OLD }, '614a4e15a181f9fa6994e9f4e1cb1d2ae8aadd72']
  ];
  for (const [tpl, opts, want] of cases) {
    assert.strictEqual(sha(build(tpl, {}, opts)), want);
    assert.strictEqual(sha(build({ ...tpl, border: 'off', borderSide: true }, {}, opts)), want); // 显式 off 同样不变
    assert.strictEqual(sha(build({ ...tpl, border: '乱写' }, {}, opts)), want); // 非法值回落 off
  }
});

test('花边：withDefaults 缺字段视为 off，borderSide 默认开，非法值回落', () => {
  const t = escpos.withDefaults({});
  assert.strictEqual(t.border, 'off');
  assert.strictEqual(t.borderSide, true);
  assert.strictEqual(escpos.withDefaults({ border: 'auto', borderSide: false }).borderSide, false);
  assert.strictEqual(escpos.withDefaults({ border: 'xx' }).border, 'off');
  assert.strictEqual(escpos.withDefaults({ border: 'shou' }).border, 'shou');
});

test('花边：折行宽度 28 / 44（按 GBK 字节宽度）', () => {
  const s = '一二三四五六七八九十一二三四五六七八九十'; // 20 个汉字 = 40 列
  assert.deepStrictEqual(escpos.wrapCols(s, 28).map(x => x.length), [14, 6]);
  assert.deepStrictEqual(escpos.wrapCols(s, 44).map(x => x.length), [20]);
  assert.deepStrictEqual(escpos.wrapCols('abc·def', 4), ['abc', '·de', 'f']); // 「·」是全角，占 2 列
});

for (const [pw, dots] of [[32, 384], [48, 576]]) {
  test(`花边：${pw} 列每个文字行恰好占满 ${pw} 列，首尾为装饰字符`, () => {
    const lines = dump(build({ paperWidth: pw, fields: [...escpos.DEFAULT_FIELDS, 'relation'], border: 'auto', thanks: '感谢光临', footer: '电话 13800000000' }));
    const texts = lines.filter(l => l.type === 'text' && l.text.length);
    assert.ok(texts.length >= 10);
    for (const l of texts) {
      assert.strictEqual(l.cols, pw, `列数不对：${l.text}`);
      assert.ok(/^[◆◇]/.test(l.text) && /[◆◇]$/.test(l.text), l.text);
      assert.strictEqual(l.text[0], l.text[l.text.length - 1]);
    }
    // 逐行交替
    assert.notStrictEqual(texts[0].text[0], texts[1].text[0]);
    // 分隔线缩短为内容宽度
    assert.ok(texts.some(l => l.text.slice(1, -1) === '-'.repeat(pw - 4)));
    // 居中 / 右对齐（大写行）
    const upper = texts.find(l => l.text.includes('大写：'));
    assert.ok(/ +大写：[^ ]+◆$|◇$/.test(upper.text) && !/ $/.test(upper.text.slice(0, -1)), upper.text);
    // 花纹带与正文各空一行（v3.60.2）：第一行和最后一行文字行只有两侧字符
    assert.strictEqual(texts[0].text.slice(1, -1).trim(), '');
    assert.strictEqual(texts[texts.length - 1].text.slice(1, -1).trim(), '');
    const title = texts[1].text.slice(1, -1);
    assert.ok(title.trim() === '礼金回执' && Math.abs(title.search(/\S/) - (title.length - title.trimEnd().length)) <= 1, title);
    // 顶部、底部各一条花纹带，且宽度为纸宽
    const rasters = lines.filter(l => l.type === 'raster');
    assert.strictEqual(rasters.length, 2);
    rasters.forEach(r => { assert.strictEqual(r.wBytes * 8, dots); assert.strictEqual(r.h, 24); });
  });
}

test('花边：倍大金额行 —— 内容放大后右对齐，行宽仍为纸宽；放不下退回正常字号', () => {
  for (const pw of [32, 48]) {
    const l = dump(build({ paperWidth: pw, fields: ['amount'], amountSize: 'double', border: 'xi', promo: false }, { payMethod: 'wechat' }))
      .filter(x => x.type === 'text' && x.text.includes('88.50'))[0];
    assert.strictEqual(l.cols, pw);
    assert.ok(/^[◆◇] *￥88\.50[◆◇]$/.test(l.text), l.text);
  }
  const big = dump(build({ paperWidth: 32, fields: ['amount'], amountSize: 'double', border: 'xi', promo: false }, { amount: 12345678901.5, payMethod: 'wechat' }))
    .filter(x => x.type === 'text' && x.text.includes('￥'))[0];
  assert.strictEqual(big.cols, 32);
  const bytes = Buffer.from(build({ paperWidth: 32, fields: ['amount'], amountSize: 'double', border: 'xi', promo: false }, { amount: 12345678901.5, payMethod: 'wechat' }));
  assert.ok(!bytes.includes(Buffer.from([0x1d, 0x21, 0x11]))); // 放不下：没有倍宽指令
});

test('花边：仅上下（borderSide=false）内容宽度不变，文字行没有装饰字符', () => {
  const b = build({ paperWidth: 32, fields: escpos.DEFAULT_FIELDS, border: 'hui', borderSide: false, thanks: '感谢光临' });
  const lines = dump(b);
  assert.strictEqual(lines.filter(l => l.type === 'raster').length, 2);
  assert.ok(lines.filter(l => l.type === 'text').every(l => !/[◆◇※]/.test(l.text)));
  assert.ok(lines.some(l => l.type === 'text' && l.text === '-'.repeat(32)));
});

test('花边：二维码行不加装饰字符，也不超出两侧字符之间的 336 点', () => {
  const lines = dump(build({ paperWidth: 32, fields: ['amount'], border: 'xi', promo: false }, {}, { qr: QR }));
  const i = lines.findIndex(l => l.type === 'raster' && l.h === 2);
  assert.ok(i > 0);
  assert.ok(QR[4] * 8 <= 384 - 48);
  const hint = lines.slice(i + 1).find(l => l.type === 'text' && l.text.length);
  assert.ok(hint.text.includes('扫码查看电子回执') && hint.cols === 32);
});

test('花边：花纹带字节数 = 8 字节头 + 每行字节 x 24 行', () => {
  for (const k of bt.STYLE_KEYS) {
    const a = bt.bandBytes(k, 384), c = bt.bandBytes(k, 576);
    assert.strictEqual(a.length, 8 + 48 * 24);
    assert.strictEqual(c.length, 8 + 72 * 24);
    assert.deepStrictEqual(a.slice(0, 8), [0x1d, 0x76, 0x30, 0, 48, 0, 24, 0]);
    assert.deepStrictEqual(c.slice(0, 8), [0x1d, 0x76, 0x30, 0, 72, 0, 24, 0]);
    assert.ok(a.slice(8).some(v => v)); // 不是空白
  }
  // 左右各留 12 点空白（块数取奇数居中）：每行首字节全 0、第二字节高 4 位为 0
  const row0 = bt.bandBytes('xi', 384).slice(8, 8 + 48);
  assert.strictEqual(row0[0], 0);
  assert.strictEqual(row0[1] & 0xf0, 0);
  // 整张小票多出：两条带 + 两个 ESC J + 带与正文之间各一个空行（LF）
  const off = build({ paperWidth: 32, fields: ['amount'], promo: false }).byteLength;
  const on = build({ paperWidth: 32, fields: ['amount'], promo: false, border: 'xi', borderSide: false }).byteLength;
  assert.strictEqual(on - off, 2 * (8 + 48 * 24) + 6 + 2);
});

test('花边：款式解析 —— 跟随类型、白事强制素雅、off 不打', () => {
  assert.strictEqual(bt.resolve('off', true, 'wedding'), null);
  assert.strictEqual(bt.resolve(undefined, true, 'wedding'), null);
  assert.strictEqual(bt.resolve('auto', true, 'wedding').key, 'xi');
  assert.strictEqual(bt.resolve('auto', true, 'birthday').key, 'shou');
  assert.strictEqual(bt.resolve('auto', true, 'baby').key, 'fu');
  assert.strictEqual(bt.resolve('auto', true, 'funeral').key, 'su');
  assert.strictEqual(bt.resolve('xi', true, 'funeral').key, 'su'); // 白事不能选喜庆款式
  assert.strictEqual(bt.resolve('auto', true, '未知').key, 'hui');
  assert.strictEqual(bt.resolve('shou', false, 'wedding').side, null);
  assert.deepStrictEqual(bt.resolve('auto', true, 'funeral').side, ['·', '·']);
});

test('花边：白事素雅线，侧边为「·」且列数正确', () => {
  const lines = dump(build({ paperWidth: 32, fields: ['title', 'payerName', 'amount'], border: 'auto', promo: false }, { bookType: 'funeral', payMethod: 'wechat' }));
  const texts = lines.filter(l => l.type === 'text' && l.text.length);
  texts.forEach(l => { assert.strictEqual(l.cols, 32); assert.ok(l.text.startsWith('·') && l.text.endsWith('·'), l.text); });
});

test('花边：books.saveTpl 白名单与前端款式一致', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../cloudfunctions/books/index.js'), 'utf8');
  const m = src.match(/BORDER_VALUES = \[([^\]]*)\]/);
  assert.ok(m, 'books 云函数缺少 BORDER_VALUES');
  const cloud = m[1].split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepStrictEqual(cloud, bt.BORDER_VALUES);
  assert.ok(/borderSide: t\.borderSide !== false/.test(src));
});
