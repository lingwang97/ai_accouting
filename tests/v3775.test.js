// v3.77.5：「记账人」菜单改名「记账人管理」，新增「礼簿共享管理」入口；members / bookshare 页标题统一
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');

const root = path.join(__dirname, '../miniprogram');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('我的：菜单名「记账人管理 / 礼台人员管理」，小字仍为邀请 / 权限', () => {
  const w = read('pages/mine/mine.wxml');
  assert.ok(w.includes("account.orgMode ? '礼台人员管理' : '记账人管理'"));
  assert.ok(w.includes('邀请 / 权限'));
  assert.ok(!/<text class="mi-text">\{\{account\.orgMode \? '礼台人员' : '记账人'\}\}/.test(w));
});

test('我的：「礼簿共享管理」在「移交主家」下面，可见条件与礼簿管理共享按钮一致，viewer 看不到', () => {
  const w = read('pages/mine/mine.wxml');
  assert.ok(w.indexOf('礼簿共享管理') > w.indexOf('<text class="mi-text">移交主家</text>'));
  assert.ok(w.includes("account.orgMode ? '场次共享管理' : '礼簿共享管理'"));
  assert.ok(w.includes('分享给家人只读查看'));
  assert.ok(/bindtap="goShare" wx:if="\{\{account && pm\.members\}\}"/.test(w));
  assert.ok(/class="btn btn-lg btn-outline" wx:if="\{\{pm\.members\}\}"[^>]*bindtap="goShare"/.test(read('pages/books/books.wxml')), '礼簿管理底部「礼簿共享」按钮保留');
  // 该菜单组整体包在 role !== 'viewer' 里
  assert.ok(w.indexOf("wx:if=\"{{role !== 'viewer'}}\"") < w.indexOf('礼簿共享管理'));
  assert.ok(read('pages/mine/mine.js').includes("/pages/bookshare/bookshare"));
  assert.ok(fs.existsSync(path.join(root, 'assets/icons/share-m.svg')));
});

test('页面标题：members「记账人管理 / 礼台人员管理」，bookshare「礼簿共享管理 / 场次共享管理」', () => {
  assert.ok(read('pages/members/members.js').includes("title: orgMode ? '礼台人员管理' : '记账人管理'"));
  assert.ok(read('pages/members/members.json').includes('"记账人管理"'));
  assert.ok(read('pages/bookshare/bookshare.json').includes('"礼簿共享管理"'));
  assert.ok(read('pages/bookshare/bookshare.js').includes("acc && acc.orgMode ? '场次共享管理' : '礼簿共享管理'"));
});

test('FAQ / 教程：「我的 → 记账人」统一为「记账人管理」，共享 FAQ 增加新入口，机构模式替换不重复', () => {
  const all = ['pages/guide/faq.js', 'pages/guide/guide.js', 'pages/start/start.wxml'].map(read).join('\n');
  assert.ok(!/我的 → 记账人(?!管理)/.test(all));
  const { FAQ } = require('../miniprogram/pages/guide/faq.js');
  const it = [].concat(...FAQ.map(c => c.items)).find(x => x.q.startsWith('想让家人也能看礼簿'));
  assert.ok(it.a.includes('我的 → 礼簿共享管理') && it.a.includes('「礼簿共享」'));
  // 机构模式替换规则：记账人 → 礼台人员，「记账人管理」得到「礼台人员管理」
  const orgText = s => String(s).replace(/礼簿管理/g, '场次管理').replace(/记账人/g, '礼台人员');
  assert.strictEqual(orgText('我的 → 记账人管理'), '我的 → 礼台人员管理');
  assert.ok(read('pages/guide/mock.js').includes("'记账人管理'"));
});
