// v3.51.0 常见问题数据（miniprogram/pages/guide/faq.js）结构校验
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { FAQ, WHO } = require('../miniprogram/pages/guide/faq.js');

const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
const PAGES = new Set(appJson.pages.map(p => '/' + p));
(appJson.subpackages || []).forEach(sp => sp.pages.forEach(p => PAGES.add('/' + sp.root + '/' + p)));
const TAB_PAGES = new Set(((appJson.tabBar && appJson.tabBar.list) || []).map(t => '/' + t.pagePath));
const all = FAQ.reduce((a, c) => a.concat(c.items.map(it => ({ cat: c.cat, ...it }))), []);

test('faq：分类与条数合理，每条有 q、a、who', () => {
  assert.ok(FAQ.length >= 5);
  assert.ok(all.length >= 40 && all.length <= 80, '条数 ' + all.length);
  FAQ.forEach(c => assert.ok(c.cat && c.items.length > 0, '分类为空：' + c.cat));
  all.forEach(it => {
    assert.ok(typeof it.q === 'string' && it.q.trim(), '缺少 q：' + it.cat);
    assert.ok(typeof it.a === 'string' && it.a.trim(), '缺少 a：' + it.q);
    assert.ok(Array.isArray(it.who) && it.who.length > 0, '缺少 who：' + it.q);
    it.who.forEach(w => assert.ok(WHO.includes(w), `${it.q} 的身份「${w}」不合法`));
    if (it.qOrg || it.aOrg) assert.ok(it.qOrg && it.aOrg, '机构文案须成对：' + it.q);
  });
});

test('faq：分类 key 唯一且含 guest（页面链接 cat=guest 依赖它）', () => {
  const keys = FAQ.map(c => c.key);
  assert.ok(keys.every(k => /^[a-z]+$/.test(k)), '分类缺少 key');
  assert.strictEqual(new Set(keys).size, keys.length, '分类 key 重复');
  assert.ok(keys.includes('guest'));
  // 随礼页、宾客首页的链接参数必须能对上分类
  ['pages/pay/pay.js', 'pages/index/index.js'].forEach(f => {
    const m = fs.readFileSync(path.join(__dirname, '../miniprogram', f), 'utf8').match(/guide\?tab=faq&cat=(\w+)/);
    assert.ok(m && keys.includes(m[1]), f + ' 的 cat 参数无对应分类');
  });
});

test('faq：url 指向 app.json 里存在的页面，tab 页用 switchTab 标记', () => {
  all.filter(it => it.url).forEach(it => {
    assert.ok(PAGES.has(it.url), `${it.q} 的 url 不存在：${it.url}`);
    assert.strictEqual(!!it.tab, TAB_PAGES.has(it.url), `${it.q}：底部菜单页须 tab:true，非菜单页不能 tab:true（${it.url}）`);
  });
});

test('faq：没有重复的问题；答案里没有技术信息', () => {
  const seen = new Set();
  all.forEach(it => {
    assert.ok(!seen.has(it.q), '重复的问题：' + it.q);
    seen.add(it.q);
    assert.ok(!/§|v\d+\.\d+|\.js|:\d+/.test(it.q + it.a), '含技术信息：' + it.q);
  });
});

test('faq / guide：不再出现旧路径（隐私说明、我的 → 清除我的全部数据）', () => {
  const guideSrc = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/guide/guide.js'), 'utf8');
  const text = JSON.stringify(FAQ) + guideSrc;
  assert.ok(!/我的\s*→\s*隐私说明/.test(text), '仍有「我的 → 隐私说明」');
  assert.ok(!/我的\s*→\s*清除我的全部数据/.test(text), '仍有「我的 → 清除我的全部数据」');
  assert.ok(/隐私与数据 → 清除我的全部数据/.test(text), '缺少新路径');
});
