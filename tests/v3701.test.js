// v3.70.1：页面首帧前同步套主题色（导航栏 / themeStyle / 底部菜单初始值），避免非红主题先闪红
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function loadTheme(globalData, storage) {
  const calls = [];
  global.wx = {
    setNavigationBarColor: o => calls.push(o),
    getStorageSync: k => (storage || {})[k] || '',
    setStorageSync() {}
  };
  global.getApp = () => ({ globalData: globalData || {}, refreshTabBar() {} });
  const p = require.resolve('../miniprogram/utils/theme.js');
  delete require.cache[p];
  return { theme: require(p), calls };
}
const mkPage = () => ({ data: {}, setData(d) { Object.assign(this.data, d); } });

test('early：绿色主题同步设导航栏（无动画）与 themeStyle，不出现默认红', () => {
  const { theme, calls } = loadTheme({ themePrimary: '#07C160', bookType: 'wedding' });
  const pg = mkPage();
  const t = theme.early(pg);
  assert.strictEqual(t.primary, '#07C160');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].backgroundColor, '#07C160');
  assert.strictEqual(calls[0].frontColor, '#ffffff');
  assert.strictEqual(calls[0].animation.duration, 0);
  assert.ok(pg.data.themeStyle.includes('--primary:#07C160'));
  assert.strictEqual(pg.data.themePrimary, '#07C160');
});

test('early：白事礼簿素灰；未选过主题为中国红；与 apply 结果一致', () => {
  let r = loadTheme({ themePrimary: '#07C160', bookType: 'funeral' });
  const pg = mkPage();
  assert.strictEqual(r.theme.early(pg).primary, '#4A4A4A');
  assert.strictEqual(r.calls[0].backgroundColor, '#4A4A4A');
  const pa = mkPage();
  assert.strictEqual(r.theme.apply(pa).primary, '#4A4A4A');
  assert.strictEqual(pa.data.themeStyle, pg.data.themeStyle);
  r = loadTheme({ bookType: '' }, {});
  assert.strictEqual(r.theme.early(mkPage()).primary, '#C8161D');
});

test('early：本地存的主题色（冷启动 globalData 为空）也生效；page 缺失不抛错', () => {
  const r = loadTheme({}, { theme_primary: '#2B7FFF' });
  assert.strictEqual(r.theme.early(null).primary, '#2B7FFF');
  assert.strictEqual(r.calls[0].backgroundColor, '#2B7FFF');
});

test('跟主家主题的页面：onLoad 第一条语句是 theme.early(this)；宾客端页面不调用', () => {
  const dirs = fs.readdirSync(path.join(ROOT, 'miniprogram/pages'));
  const followers = [], others = [];
  for (const d of dirs) {
    const f = `miniprogram/pages/${d}/${d}.js`;
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    const s = read(f);
    if (/theme\.(apply|applyNav)\(/.test(s)) followers.push([d, s]); else others.push(d);
  }
  assert.ok(followers.length >= 35);
  for (const [d, s] of followers) {
    const m = s.match(/^  (?:async )?onLoad\([^)]*\) \{(.*)\n?/m);
    assert.ok(m, `${d} 缺 onLoad`);
    const after = s.slice(s.indexOf(m[0]) + m[0].length);
    const first = m[1].trim() ? m[1].trim() : after.split('\n')[0].trim();
    assert.ok(/^(?:onLoad\(\) \{ )?theme\.early\(this\);/.test(first) || first.startsWith('theme.early(this)'), `${d} onLoad 首句不是 theme.early：${first}`);
  }
  // 宾客端 / 自带主题逻辑：不跟主家主题
  for (const d of ['pay', 'receipt', 'qrcode']) {
    assert.ok(others.includes(d), d);
    assert.ok(!/theme\.early/.test(read(`miniprogram/pages/${d}/${d}.js`)), `${d} 不应调用 early`);
  }
});

test('底部菜单初始值取当前主题；app.json 默认导航色仍为红（宾客页沿用）', () => {
  const s = read('miniprogram/custom-tab-bar/index.js');
  assert.ok(/color: theme\.current\(\)\.primary,/.test(s) && /iconOn: theme\.current\(\)\.icon/.test(s));
  assert.strictEqual(JSON.parse(read('miniprogram/app.json')).window.navigationBarBackgroundColor, '#C8161D');
  assert.ok(/VERSION: '\d+\.\d+\.\d+'/.test(read('miniprogram/config.js'))); // 只校验版本号格式，不写死具体版本（每次发版不必改测试）
});
