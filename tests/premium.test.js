// v3.62.0 会员预留：礼簿 PDF 主题 / 电子回执版式 / 去广告卡
// 现阶段套餐全部开放；只有 features.xxx === false 才限制（缺项视为开放）
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction } = require('./helpers/sdk-stub.js');
const P = require('../tools/cloud-shared/plans.js');
const T = require('../cloudfunctions/export/themes.js');
const PT = require('../miniprogram/pages/booktheme/pdftheme.js');
const receipt = require('../miniprogram/utils/receipt.js');
const A = require('../miniprogram/utils/advperm.js');

test('plans：新增会员项默认开放；featureOpen 缺项开放、只有 false 才关', () => {
  assert.strictEqual(P.DEFAULT_PLANS.free.features.pdfThemePremium, true);
  assert.strictEqual(P.DEFAULT_PLANS.free.features.receiptStylePremium, true);
  assert.strictEqual(P.featureOpen({}, 'pdfThemePremium'), true);
  assert.strictEqual(P.featureOpen(undefined, 'pdfThemePremium'), true);
  assert.strictEqual(P.featureOpen({ pdfThemePremium: false }, 'pdfThemePremium'), false);
  assert.strictEqual(P.featureOpen({ pdfThemePremium: 0 }, 'pdfThemePremium'), true, '只认明确的 false');
});

test('themes：免费 4 套，前后端一致；premiumUsed 识别会员项', () => {
  assert.deepStrictEqual(T.FREE_KEYS, ['red_gold', 'peach', 'sky', 'grey']);
  assert.deepStrictEqual(PT.FREE_KEYS, T.FREE_KEYS);
  const D = { on: true, footer: '', sign: true, brand: true };
  assert.deepStrictEqual(T.premiumUsed({ key: 'red_gold', back: D }), []);
  assert.deepStrictEqual(T.premiumUsed({ key: '', back: null }), [], '没选 = 按类型默认，不算');
  assert.ok(T.premiumUsed({ key: 'wine_gold', back: D }).length);
  assert.ok(T.premiumUsed({ key: 'custom', custom: {}, back: D }).length);
  assert.ok(T.premiumUsed({ key: 'sky', back: { ...D, footer: '百年好合' } }).length, '尾页自定义落款');
  assert.ok(T.premiumUsed({ key: 'sky', back: { ...D, brand: false } }).length);
  assert.deepStrictEqual(T.premiumUsed({ funeral: true, key: 'custom', custom: { font: 'sans' }, back: D }), []);
  assert.ok(T.premiumUsed({ funeral: true, key: 'custom', custom: { font: 'brush' }, back: D }).length);
});

test('themes：降级只在会员项关闭时发生；非白事换红金并保留类型水印，白事字体改黑体', () => {
  assert.strictEqual(T.pick(true, false, 'baby', '', null).key, 'orange', '开放时不变');
  const b = T.pick(false, false, 'baby', '', null);
  assert.strictEqual(b.key, 'red_gold'); assert.strictEqual(b.mark, '福');
  assert.strictEqual(T.pick(false, false, 'wedding', 'wine_gold', null).key, 'red_gold');
  assert.strictEqual(T.pick(false, false, 'wedding', 'custom', { main: '#0B3D6B', accent: '#F5D76E' }).key, 'red_gold');
  assert.strictEqual(T.pick(false, false, 'wedding', 'peach', null).key, 'peach', '免费主题保持');
  assert.strictEqual(T.pick(false, false, 'wedding', '', null).mark, '囍', '默认水印保持');
  const f = T.pick(false, true, 'funeral', 'custom', { font: 'brush', mark: '奠' });
  assert.strictEqual(f.font, 'sans'); assert.strictEqual(f.mark, '奠'); assert.ok(f.funeral);
  assert.strictEqual(T.pick(true, true, 'funeral', 'custom', { font: 'brush' }).font, 'brush');
});

test('receipt：白事只有素雅 / 简约 / 票据；会员版式有 premium 标记', () => {
  assert.deepStrictEqual(receipt.stylesFor('funeral').map(s => s.v), ['ticket', 'simple', 'elegant']);
  assert.strictEqual(receipt.stylesFor('wedding').length, 8);
  assert.deepStrictEqual(receipt.STYLES.filter(s => s.premium).map(s => s.v), P.RECEIPT_STYLES_PREMIUM);
  assert.deepStrictEqual(receipt.STYLES.filter(s => !s.premium).map(s => s.v).sort(), P.RECEIPT_STYLES_FREE.slice().sort());
  assert.deepStrictEqual(receipt.FUNERAL_STYLES.slice().sort(), P.RECEIPT_STYLES_FUNERAL.slice().sort());
});

test('advperm.adItem：只在主家 / 记账人侧显示，会员与免费文案不同', () => {
  assert.strictEqual(A.adItem({ role: 'viewer', plan: 'free' }).show, false);
  assert.strictEqual(A.adItem({ role: 'none', plan: 'free' }).show, false);
  const free = A.adItem({ role: 'owner', plan: 'free' });
  assert.ok(free.show && !free.member);
  assert.ok(A.adItem({ role: 'clerk', plan: 'pro' }).member);
});

// ---- books.saveTpl
const OWNER = 'o-owner';
function seed(plansDoc, type, tpl) {
  db.reset().applyUpdates = true;
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1', accountName: '张府' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '本场', type: type || 'wedding', ...(tpl ? { receiptTpl: tpl } : {}) }])
    .seed('settings', plansDoc ? [{ _id: 'plans', ...plansDoc }] : []);
}
const OFF = { free: { name: '免费版', features: { receiptStylePremium: false } }, pro: { name: '专业版', features: {} } };
const save = (style, bookId) => { state.openid = OWNER; return loadFunction('books').main({ action: 'saveTpl', bookId: bookId || 'b1', receiptTpl: { style, fields: ['payerName'] } }); };

test('books.saveTpl：默认全开放，会员版式可保存', async () => {
  seed();
  const r = await save('festive');
  assert.strictEqual(r.code, 0, r.msg);
  assert.deepStrictEqual(r.data.saved, ['receiptTpl']);
});

test('books.saveTpl：套餐关闭会员版式后，新选会员版式被拒；免费版式、与已存一致的放行', async () => {
  seed(OFF);
  const r = await save('guofeng');
  assert.notStrictEqual(r.code, 0);
  assert.ok(/会员/.test(r.msg));
  assert.strictEqual((await save('elegant')).code, 0);
  seed(OFF, 'wedding', { style: 'longevity', fields: ['payerName'] });
  assert.strictEqual((await save('longevity')).code, 0, '已选的会员版式再保存其他项不被拦');
  assert.notStrictEqual((await save('business')).code, 0);
});

test('books.saveTpl：白事只能素雅 / 简约 / 票据；已存的不受影响', async () => {
  seed(null, 'funeral');
  for (const s of ['card', 'festive', 'longevity']) assert.notStrictEqual((await save(s)).code, 0, s);
  for (const s of ['elegant', 'simple', 'ticket']) assert.strictEqual((await save(s)).code, 0, s);
  seed(null, 'funeral', { style: 'card', fields: ['payerName'] });
  assert.strictEqual((await save('card')).code, 0, '旧数据里的卡片再保存不被拦');
});

// ---- 宾客回执出参降级
function seedReceipt(plansDoc, style) {
  db.reset().applyUpdates = true;
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '本场', type: 'wedding', receiptTpl: { style, color: '#C8161D', fields: ['payerName'] } }])
    .seed('records', [{ _id: 'r1', aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', status: 'paid', payerName: '李四', amount: 100, payerOpenid: 'g1', createdAt: new Date(), paidAt: new Date() }])
    .seed('settings', plansDoc ? [{ _id: 'plans', ...plansDoc }] : []);
}
const view = async () => { state.openid = 'g1'; const r = await loadFunction('payment').main({ action: 'receipt', rid: 'r1' }); assert.strictEqual(r.code, 0, r.msg); return r.data.tpl; };

test('payment.receipt：会员版式开放时原样；套餐关闭后宾客看到卡片，库里不改', async () => {
  seedReceipt(null, 'festive');
  assert.strictEqual((await view()).style, 'festive');
  seedReceipt(OFF, 'festive');
  assert.strictEqual((await view()).style, 'card');
  assert.strictEqual(db.data.books[0].receiptTpl.style, 'festive');
  seedReceipt(OFF, 'elegant');
  assert.strictEqual((await view()).style, 'elegant');
});
