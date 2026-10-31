// v3.78.0：家人共享（viewer）工作台精简、可切换共享的礼簿、空状态、导出传统礼簿按钮条件
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, loadFunction } = require('./helpers/sdk-stub.js');

const ROOT = path.join(__dirname, '..');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const OWNER = 'o-owner';

function seed(opts) {
  opts = opts || {};
  db.reset().applyUpdates = true;
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }, { openid: 'fam' }])
    .seed('books', opts.books || [
      { _id: 'b1', ownerOpenid: OWNER, name: '甲', type: 'wedding', statReady: true },
      { _id: 'b2', ownerOpenid: OWNER, name: '乙', type: 'other', statReady: true },
      { _id: 'b3', ownerOpenid: OWNER, name: '丙', type: 'other', statReady: true }
    ])
    .seed('members', [{ _id: 'm2', aid: 'acc1', memberOpenid: 'fam', role: 'viewer', bookIds: opts.bookIds || ['b2', 'b3'] }])
    .seed('records', []);
}
const dash = async (who, bookId) => {
  state.openid = who;
  const r = await loadFunction('records').main({ action: 'dashboard', ...(bookId ? { bookId } : {}) });
  assert.strictEqual(r.code, 0, r.msg);
  return r.data;
};

test('dashboard：家人共享指定 bookId 且在共享范围内才采用，返回共享本数 sharedN', async () => {
  seed();
  const d = await dash('fam', 'b3');
  assert.strictEqual(d.book._id, 'b3');
  assert.strictEqual(d.sharedN, 2);
  assert.strictEqual(d.needBooks, false);
});

test('dashboard：越权 bookId（不在共享范围）回退默认，不泄露其他礼簿', async () => {
  seed();
  const d = await dash('fam', 'b1'); // b1 是主家当前礼簿但没共享给家人
  assert.notStrictEqual(d.book && d.book._id, 'b1');
  assert.strictEqual(d.book._id, 'b2'); // 回退到共享里的第一本
  const d2 = await dash('fam', 'not-exist');
  assert.strictEqual(d2.book._id, 'b2');
});

test('dashboard：不传 bookId 用默认；主家传 bookId 不影响（只对 viewer 生效）', async () => {
  seed();
  assert.strictEqual((await dash('fam')).book._id, 'b2');
  const o = await dash(OWNER, 'b3');
  assert.strictEqual(o.book._id, 'b1');
  assert.strictEqual(o.sharedN, undefined);
});

test('dashboard：共享的礼簿都归档 / 删除时无可看礼簿（book 为空、不再要求补建礼簿）', async () => {
  seed({
    books: [
      { _id: 'b1', ownerOpenid: OWNER, name: '甲', type: 'wedding', statReady: true },
      { _id: 'b2', ownerOpenid: OWNER, name: '乙', type: 'other', statReady: true, archived: true }
    ],
    bookIds: ['b2', 'b3']
  });
  const d = await dash('fam', 'b2');
  assert.strictEqual(d.book, null);
  assert.strictEqual(d.sharedN, 0);
  assert.strictEqual(d.needBooks, false);
  assert.strictEqual(d.role, 'viewer');
});

test('dashboard：归档的不计入 sharedN，指定归档礼簿回退到未归档的', async () => {
  seed({
    books: [
      { _id: 'b2', ownerOpenid: OWNER, name: '乙', type: 'other', statReady: true, archived: true },
      { _id: 'b3', ownerOpenid: OWNER, name: '丙', type: 'other', statReady: true }
    ]
  });
  const d = await dash('fam', 'b2');
  assert.strictEqual(d.sharedN, 1);
  assert.strictEqual(d.book._id, 'b3');
});

test('前端：viewer 宫格为 礼金明细 / 礼簿统计 / 导出 / 共享给我的礼簿，不再有一键对账', () => {
  const w = rd('miniprogram/pages/index/index.wxml');
  const g = w.slice(w.indexOf('家人共享：只读入口'), w.indexOf('常用操作：三行两列'));
  const titles = [...g.matchAll(/<view class="g-title">([^<]*)<\/view>/g)].map(m => m[1]);
  assert.deepStrictEqual(titles, ['礼金明细', '礼簿统计', '导出', "{{account.orgMode ? '共享给我的场次' : '共享给我的礼簿'}}"]);
  assert.ok(!g.includes('一键对账'));
  assert.ok(g.includes('bindtap="goRecords"') && g.includes('bindtap="goBookDetail"') && g.includes('bindtap="goExportBook"') && g.includes('bindtap="goBooks"'));
  assert.ok(!g.includes('goReconcile'));
  assert.ok(g.includes('共 {{sharedN}}'));
  assert.ok(/class="grid" wx:if="\{\{readonly && !viewerEmpty\}\}"/.test(w));
  assert.ok(/class="grid" wx:elif="\{\{!readonly\}\}"/.test(w)); // 主家 / 记账人宫格保持
});

test('前端：卡片「切换礼簿」仅共享 ≥2 本，空状态提示卡 + 切换身份', () => {
  const j = rd('miniprogram/pages/index/index.js');
  assert.ok(j.includes("d.role === 'viewer' ? (d.sharedN || 0) >= 2"));
  assert.ok(j.includes("viewerEmpty: d.role === 'viewer' && !b"));
  assert.ok(j.includes('async switchViewerBook()') && j.includes('if (this.data.readonly) return this.switchViewerBook();'));
  assert.ok(j.includes('viewerbook.set(b._id)'));
  assert.ok(j.includes('req.dashboard({ silent: true }, viewerbook.get())'));
  const sw = j.slice(j.indexOf('async switchViewerBook()'), j.indexOf('async onSwitchBook()'));
  assert.ok(sw.includes('list.length > 6 ? 5 : 6') && sw.includes('共享给我的场次…') && sw.includes('共享给我的礼簿…')); // 最多 6 项
  assert.ok(!sw.includes('bookSetActive'), '不改主家的当前礼簿');
  const w = rd('miniprogram/pages/index/index.wxml');
  assert.ok(w.includes('主家暂未共享') && w.includes('或共享已取消，可联系主家重新共享'));
  assert.ok(w.includes('bindtap="goMine">切换身份'));
  assert.ok(/class="book-card" wx:if="\{\{!viewerEmpty\}\}"/.test(w));
  assert.ok(j.includes('goExportBook()') && j.includes("'/pages/export/export' + (b ? `?bookId=${b._id}` : '')"));
});

test('viewerbook：本机记住所选礼簿，存储异常时不抛错', () => {
  const store = {};
  global.wx = { getStorageSync: k => store[k], setStorageSync: (k, v) => { store[k] = v; } };
  delete require.cache[require.resolve('../miniprogram/utils/viewerbook.js')];
  const vb = require('../miniprogram/utils/viewerbook.js');
  assert.strictEqual(vb.get(), '');
  vb.set('b3');
  assert.strictEqual(vb.get(), 'b3');
  global.wx = { getStorageSync() { throw new Error('x'); }, setStorageSync() { throw new Error('x'); } };
  assert.strictEqual(vb.get(), '');
  vb.set('b2');
  delete global.wx;
});

test('前端：礼簿页 / 导出 / 礼簿管理跟随所选礼簿，books 页 viewer 版', () => {
  const r = rd('miniprogram/pages/records/records.js');
  assert.ok(r.includes("app.globalData.role === 'viewer'") && r.includes('viewerbook.get()') && r.includes('viewerbook.set(sel._id)'));
  assert.ok(rd('miniprogram/pages/export/export.js').includes("(viewer ? viewerbook.get() : '')"));
  const bj = rd('miniprogram/pages/books/books.js');
  assert.ok(bj.includes("'共享给我的场次' : '共享给我的礼簿'") || bj.includes("org ? '共享给我的场次' : '共享给我的礼簿'"));
  assert.ok(bj.includes("role === 'viewer' ? viewerbook.get() : ''"));
  const bw = rd('miniprogram/pages/books/books.wxml');
  assert.ok(/class="book-tip muted" wx:if="\{\{!viewer\}\}"/.test(bw));
  assert.ok(bw.includes('wx:if="{{canExport && !viewer}}"'));
});

test('前端：统计页 viewer 有对账入口；mine 对 viewer 隐藏打印机 / 高级功能整组', () => {
  assert.ok(/wx:if="\{\{readonly\}\}" bindtap="goReconcile"/.test(rd('miniprogram/pages/bookdetail/bookdetail.wxml')));
  assert.ok(rd('miniprogram/pages/bookdetail/bookdetail.js').includes('/pages/reconcile/reconcile?bookId=${this.data.id}'));
  const m = rd('miniprogram/pages/mine/mine.wxml');
  const i = m.indexOf('样式与设备');
  assert.ok(m.slice(m.lastIndexOf('<block', i), i).includes("role !== 'viewer'"));
  assert.ok(m.indexOf('蓝牙打印机') > i && m.indexOf('高级功能') > i);
  assert.ok(m.slice(i).indexOf('</block>') > m.slice(i).indexOf('高级功能')); // 整组在 block 内
});

test('导出页：传统礼簿 PDF 按钮按「选中的是具体礼簿」显示（家人共享单本 / 多本、主家日期范围）', () => {
  const w = rd('miniprogram/pages/export/export.wxml');
  assert.ok(w.includes('<button wx:if="{{books[bookIdx]._id}}" class="btn-primary"'));
  assert.ok(w.includes('<text wx:if="{{books[bookIdx]._id}}" class="muted">（整本）</text>'));
  assert.ok(!/wx:if="\{\{bookIdx > 0\}\}"/.test(w));
  const show = (books, idx) => !!(books[idx] && books[idx]._id);
  assert.ok(show([{ _id: 'b1' }], 0));
  assert.ok(show([{ _id: 'b1' }, { _id: 'b2' }], 1));
  assert.ok(!show([{ _id: '' }, { _id: 'b1' }], 0));
  assert.ok(show([{ _id: '' }, { _id: 'b1' }], 1));
});

test('export 云函数：家人共享可按共享的礼簿导出传统礼簿，但不保存主题、不能生成存档', () => {
  const s = fs.readFileSync(path.join(ROOT, 'cloudfunctions/export/index.js'), 'utf8');
  assert.ok(s.includes('!canBook(ctx, book._id)'));
  assert.ok(/if \(can\(ctx, 'books'\)\) \{\s*await db\.collection\('books'\)\.doc\(book\._id\)\.update\(\{ data: \{ pdfTheme/.test(s));
  assert.ok(s.includes("!(can(ctx, 'books') && can(ctx, 'export'))"));
  assert.ok(rd('miniprogram/pages/booktheme/booktheme.js').includes("canSave: perm.can('books')"));
});

test('FAQ：家人共享说明含工作台切换礼簿', () => {
  const f = rd('miniprogram/pages/guide/faq.js');
  assert.ok(f.includes('工作台卡片上的「切换礼簿」'));
});
