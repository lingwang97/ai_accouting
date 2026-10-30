// v3.77.3 礼簿页：「只看重名」从排序下拉移出，改为独立「重名」开关；筛选 / 排序图标
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, 'miniprogram', f), 'utf8');

function loadRecords() {
  const src = read('pages/records/records.js');
  let def = null;
  const calls = { reload: 0, scroll: 0 };
  const wxStub = { pageScrollTo() { calls.scroll++; }, getStorageSync() { return ''; }, setStorageSync() {} };
  const sandboxRequire = p => (p.startsWith('../../') ? require(path.join(ROOT, 'miniprogram', p.replace('../../', ''))) : require(p));
  new Function('require', 'Page', 'wx', 'getApp', src)(sandboxRequire, o => { def = o; }, wxStub, () => ({ globalData: {} }));
  const page = Object.assign({}, def, {
    data: JSON.parse(JSON.stringify(def.data)),
    setData(o) { Object.assign(this.data, o); },
    reload() { calls.reload++; }
  });
  page.data.books = [{ _id: '', name: '全部礼簿' }, { _id: 'b1', name: '婚宴' }];
  return { page, calls };
}

test('礼簿页排序项不含「只看重名」，只剩 5 项', () => {
  const { page } = loadRecords();
  assert.deepStrictEqual(page.data.sorts, ['最新', '最早', '金额高→低', '金额低→高', '按姓名']);
  assert.ok(!/'dup'\]/.test(read('pages/records/records.js').match(/const SORT_KEYS = \[[^\]]*\]/)[0]));
});

test('重名开关：开启请求 sort:dup 并与关系 / 状态 / 关键词组合；排序下拉不可改；关闭恢复原排序', () => {
  const { page, calls } = loadRecords();
  page.onSort({ detail: { value: 2 } });
  assert.strictEqual(page.buildParams(1).sort, 'amount_desc');
  page.onDup();
  assert.strictEqual(page.data.dupOn, true);
  assert.strictEqual(calls.reload, 2);
  page.setData({ relIdx: 1, stIdx: 3, keyword: '张', bookIdx: 1 });
  const p = page.buildParams(1);
  assert.strictEqual(p.sort, 'dup');
  assert.strictEqual(p.status, 'paid');
  assert.strictEqual(p.keyword, '张');
  assert.strictEqual(p.bookId, 'b1');
  assert.ok(p.relation);
  page.onSort({ detail: { value: 4 } }); // 开启时忽略
  assert.strictEqual(page.data.sortIdx, 2);
  page.onDup();
  assert.strictEqual(page.data.dupOn, false);
  assert.strictEqual(page.buildParams(1).sort, 'amount_desc'); // 恢复之前的排序
});

test('排序下拉选值越界时收敛；旧版本地没有排序持久化，不会出现越界的 dup 下标', () => {
  const { page } = loadRecords();
  page.onSort({ detail: { value: 5 } });
  assert.strictEqual(page.data.sortIdx, 4);
  const src = read('pages/records/records.js');
  assert.ok(!/Storage\([^)]*sort/i.test(src), '排序未持久化，无需迁移');
});

test('records.wxml：提示依赖 dupOn；重名开关、排序置灰、图标引用', () => {
  const w = read('pages/records/records.wxml');
  assert.ok(!/sortIdx === 5/.test(w));
  assert.ok(/wx:if="\{\{dupOn && dupTruncated\}\}"/.test(w) && /dupOn \? '没有重名的记录'/.test(w));
  assert.ok(/bindtap="onDup"/.test(w) && /disabled="\{\{dupOn\}\}"/.test(w) && /按姓名排列/.test(w));
  assert.ok(/filter-\{\{/.test(w) && /sort-\{\{/.test(w) && /themeIcon/.test(w));
});

test('图标：filter / sort 的灰色与全部主题色变体文件存在；themeIcon 取值都有对应文件', () => {
  const dir = path.join(ROOT, 'miniprogram/assets/icons');
  ['filter', 'sort'].forEach(n => ['g', 'r', 'd', 'n', 'y', 'b', 'k'].forEach(v => assert.ok(fs.existsSync(path.join(dir, `${n}-${v}.svg`)), `${n}-${v}.svg`)));
  const theme = read('utils/theme.js');
  const keys = [...theme.match(/const ICON_KEYS = \{([^}]*)\}/)[1].matchAll(/: '([a-z])'/g)].map(m => m[1]);
  assert.ok(keys.length >= 3);
  keys.forEach(k => ['filter', 'sort'].forEach(n => assert.ok(fs.existsSync(path.join(dir, `${n}-${k}.svg`)), `${n}-${k}.svg`)));
});

test('FAQ 不再说排序里选「只看重名」', () => {
  const f = read('pages/guide/faq.js');
  assert.ok(!/排序里选「只看重名」/.test(f) && /「重名」开关/.test(f));
});
