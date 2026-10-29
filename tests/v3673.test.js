// v3.67.3：常见问题分句、导航栏跟主题、硬编码警示色改变量、对账图行数上限、点击区与 placeholder
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');

const root = path.join(__dirname, '../miniprogram');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

function loadGuide() {
  let page = null;
  global.Page = o => { page = o; };
  global.getApp = () => ({ globalData: { account: null } });
  global.wx = {};
  const p = require.resolve('../miniprogram/pages/guide/guide.js');
  delete require.cache[p];
  require(p);
  const inst = Object.assign({}, page, { data: JSON.parse(JSON.stringify(page.data)) });
  inst.setData = function (d) { Object.assign(this.data, d); };
  return inst;
}

test('faq：长答案按句号分行显示，短答案不动；搜索命中不受分行影响', () => {
  const g = loadGuide();
  g.data.kw = '';
  g.data.openCat = { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true };
  g.data.openQ = {};
  g.buildFaq();
  const all = [].concat(...g.data.faqView.map(c => c.items));
  assert.ok(all.some(i => i.a.indexOf('\n') >= 0), '至少有一条长答案被分行');
  all.filter(i => i.a.length <= 90).forEach(i => assert.ok(i.a.indexOf('\n') < 0));
  all.forEach(i => assert.ok(!/。\n[」）』]/.test(i.a), '句号后紧跟引号 / 括号不拆'));
  g.data.kw = '打印';
  g.buildFaq();
  assert.ok([].concat(...g.data.faqView.map(c => c.items)).length > 0);
});

test('faq 样式：答案换行保留、长英文 / 数字可断', () => {
  const w = read('pages/guide/guide.wxss');
  assert.ok(/\.faq-a-text[^}]*overflow-wrap: anywhere[^}]*white-space: pre-wrap|\.faq-a-text[^}]*white-space: pre-wrap[^}]*overflow-wrap: anywhere/.test(w));
  assert.ok(!/\.faq-a-text[^}]*break-all/.test(w));
});

test('导航栏：login / invite / myreceipts 调用 theme.applyNav', () => {
  ['login/login', 'invite/invite', 'myreceipts/myreceipts'].forEach(p => assert.ok(/theme\.applyNav\(\)/.test(read(`pages/${p}.js`)), p));
  assert.ok(/function applyNav/.test(read('utils/theme.js')));
});

test('硬编码橙 / 棕色改用 --warn 变量', () => {
  ['pages/account/account.wxss', 'pages/pending/pending.wxss', 'pages/mine/mine.wxss', 'pages/bookedit/bookedit.wxss'].forEach(f => {
    const s = read(f);
    assert.ok(!/#B8860B|#FFD591|#f0b429|#d94c4c|255, 159, 28|#FFFBF0|#fffaf0/i.test(s), f);
  });
});

test('clipLines：未超限原样；超限截断并补说明行（总行数不超上限）', () => {
  const fmt = require('../miniprogram/utils/format.js');
  const a = Array.from({ length: 10 }, (_, i) => 'L' + i);
  assert.strictEqual(fmt.clipLines(a, 70), a);
  const b = Array.from({ length: 200 }, (_, i) => 'L' + i);
  const r = fmt.clipLines(b, 70);
  assert.strictEqual(r.length, 70);
  assert.ok(/另有 131 行未画出/.test(r[69]));
  assert.strictEqual(r[0], 'L0');
  assert.ok(/MAX_LINES = 70/.test(read('pages/reconcile/reconcile.js')) && /clipLines/.test(read('pages/reconcile/reconcile.js')));
});

test('点击区与 placeholder：FAQ 清除、bookshare 链接加大；invite 占位文字缩短', () => {
  assert.ok(/\.faq-clear[^}]*min-width: 72rpx/.test(read('pages/guide/guide.wxss')));
  assert.ok(/\.v-row \.link[^}]*padding: 18rpx 14rpx/.test(read('pages/bookshare/bookshare.wxss')));
  const w = read('pages/invite/invite.wxml');
  assert.ok(/placeholder="如：李华"/.test(w) && /回执、小票上显示，主家据此辨认/.test(w));
});
