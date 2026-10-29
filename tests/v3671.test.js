// v3.67.1 界面修复：常见问题搜索可收起 / 遮罩锁背景 / 下拉刷新点颜色 / 回收站副标题 / admin 与 orgsummary 样式
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');

const read = f => fs.readFileSync(path.join(__dirname, '../miniprogram', f), 'utf8');

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

test('faq 搜索：宽词只默认展开前 5 条，其余收起', () => {
  const g = loadGuide();
  g.data.kw = '的';
  g.buildFaq();
  const items = [].concat(...g.data.faqView.map(c => c.items));
  assert.ok(items.length > 5);
  assert.strictEqual(items.filter(i => i.open).length, 5);
  assert.ok(g.data.faqView.every(c => c.open));
});

test('faq 搜索：点问题、点分类都能收起 / 展开', () => {
  const g = loadGuide();
  g.data.kw = '的';
  g.buildFaq();
  const first = g.data.faqView[0].items[0];
  assert.ok(first.open);
  g.onToggleQ({ currentTarget: { dataset: { k: first.k } } });
  assert.strictEqual(g.data.faqView[0].items[0].open, false);
  g.onToggleQ({ currentTarget: { dataset: { k: first.k } } });
  assert.strictEqual(g.data.faqView[0].items[0].open, true);
  const ci = g.data.faqView[0].ci;
  g.onToggleCat({ currentTarget: { dataset: { ci } } });
  assert.strictEqual(g.data.faqView[0].open, false);
});

test('faq 搜索：换搜索词后手动记录作废；清空恢复默认展开', () => {
  const g = loadGuide();
  g.data.kw = '的';
  g.buildFaq();
  const k = g.data.faqView[0].items[0].k;
  g.onToggleQ({ currentTarget: { dataset: { k } } });
  g.onKw({ detail: { value: '的' } });
  assert.deepStrictEqual(g._sQ, {});
  g.onKwClear();
  assert.strictEqual(g.data.kw, '');
});

test('遮罩弹层都锁住背景滚动（pending / members / bookshare / records / renqing）', () => {
  for (const f of ['pages/pending/pending.wxml', 'pages/members/members.wxml', 'pages/bookshare/bookshare.wxml', 'pages/records/records.wxml', 'pages/renqing/renqing.wxml']) {
    const lines = read(f).split('\n').filter(l => /class="mask/.test(l));
    assert.ok(lines.length, f);
    lines.forEach(l => assert.ok(/catchtouchmove/.test(l), `${f}: ${l.trim()}`));
  }
  for (const f of ['pages/members/members.js', 'pages/bookshare/bookshare.js', 'pages/pending/pending.js']) assert.ok(/noop\(\)/.test(read(f)), f);
});

test('app.json：下拉刷新圆点为深色；mine 回收站副标题不写死天数', () => {
  assert.strictEqual(JSON.parse(read('app.json')).window.backgroundTextStyle, 'dark');
  assert.ok(!/保留 15 天/.test(read('pages/mine/mine.wxml')));
});

test('admin 按钮间距选择器带 :not([size=mini])；orgsummary 名称省略、金额不换行', () => {
  assert.ok(/\.row button\.btn:not\(\[size=mini\]\)\s*\{\s*margin-left/.test(read('pages/admin/admin.wxss')));
  const o = read('pages/orgsummary/orgsummary.wxss');
  assert.ok(/\.r-name\s*\{[^}]*text-overflow: ellipsis/.test(o));
  assert.ok(/\.st-row \.money[^{]*\{[^}]*nowrap/.test(o) || /\.r-top \.money[^{]*\{[^}]*nowrap/.test(o));
});
