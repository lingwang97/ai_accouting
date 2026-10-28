// v3.68.0：教程示意图的界面元素清单（pages/guide/mock.js）与真实页面（mine.wxml、index.wxml、cash.wxml）一致；
// 教程步骤的高亮项都存在；机构模式替换覆盖到教程文字；旧入口名称不再出现
// 页面改了菜单 / 宫格而没改 mock.js，这里会报错（只比对静态文字，条件表达式里的引号文字也会抽出来）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const M = require('../miniprogram/pages/guide/mock.js');

const root = path.join(__dirname, '../miniprogram');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

/** 取某个 class 的 <text>/<view> 文字：纯文字直接取；含 {{ }} 的取里面所有单引号字符串 */
function textsOf(src, cls) {
  const re = new RegExp('<(?:text|view)[^>]*class="' + cls + '"[^>]*>([^<]*)</', 'g');
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    const t = m[1].trim();
    if (t.indexOf('{{') < 0) { if (t) out.push(t); continue; }
    (t.match(/'([^']+)'/g) || []).map(x => x.slice(1, -1)).filter(x => /[一-龥]/.test(x)).forEach(x => out.push(x));
  }
  return out;
}

function loadGuide(org) {
  let page = null;
  global.Page = o => { page = o; };
  global.getApp = () => ({ globalData: { account: org ? { orgMode: true } : { orgMode: false } } });
  global.wx = {};
  const p = require.resolve('../miniprogram/pages/guide/guide.js');
  delete require.cache[p];
  require(p);
  const inst = Object.assign({}, page, { data: JSON.parse(JSON.stringify(page.data)) });
  inst.setData = function (d) { Object.assign(this.data, d); };
  return inst;
}

test('示意图：「我的」菜单 4 组 11 行与 mine.wxml 一致', () => {
  const src = read('pages/mine/mine.wxml');
  const rows = textsOf(src, 'mi-text');
  const groups = textsOf(src, 'group-title');
  const flat = [].concat(...M.MENU.map(g => g.items));
  assert.strictEqual(M.MENU.length, 4);
  assert.strictEqual(flat.length, 11);
  flat.forEach(t => assert.ok(rows.includes(t), '「我的」页没有菜单项：' + t));
  M.MENU.forEach(g => assert.ok(groups.includes(g.g), '「我的」页没有分组：' + g.g));
  // 反过来：页面上的菜单项（管理员区的「系统设置」除外）都要画进示意图
  rows.filter(t => t !== '系统设置').forEach(t => {
    const ok = flat.includes(t) || ['收款码（申请更换）', '礼台人员', '导出礼簿'].includes(t);
    assert.ok(ok, '示意图缺少「我的」页的菜单项：' + t);
  });
});

test('示意图：工作台宫格与 index.wxml 一致，机构模式多「场次汇总」', () => {
  const src = read('pages/index/index.wxml');
  const body = src.slice(src.indexOf('<view class="grid" wx:else>'));
  const titles = textsOf(body.slice(0, body.indexOf('<ad-slot')), 'g-title');
  M.GRID_ORG.forEach(t => assert.ok(titles.includes(t) || (t === '礼簿管理' && titles.includes('礼簿管理')), '工作台没有宫格：' + t));
  titles.forEach(t => assert.ok(M.GRID_ORG.includes(t) || t === '场次管理', '示意图缺少工作台宫格：' + t));
  assert.ok(titles.includes('场次管理'));
  assert.deepStrictEqual(M.GRID_ORG.slice(0, 6), M.GRID);
  assert.strictEqual(M.GRID_ORG[6], '场次汇总');
});

test('示意图：提示条、打印机三态、礼台记账元素与真实页面文字一致', () => {
  const idx = read('pages/index/index.wxml');
  assert.ok(idx.includes('网络不稳定，数据可能不是最新'));
  assert.ok(idx.includes('高峰模式进行中'));
  assert.ok(/其他\{\{account\.orgMode \? '场次' : '礼簿'\}\}还有 \{\{otherPending\}\} 份待确认礼金/.test(idx));
  M.PRINTER_STATES.forEach(s => assert.ok(idx.includes(s.k), '工作台没有打印机状态：' + s.k));
  assert.ok(read('utils/notify.js').includes('新礼金提醒次数已用完'));
  const cash = read('pages/cash/cash.wxml');
  assert.ok(cash.includes('打印机已连接，入簿自动打印小票'));
  assert.ok(cash.includes('宾客姓名'));
  assert.ok(cash.includes('本次已登记'));
  assert.ok(M.BARS.some(b => b.vip && /高峰模式/.test(b.t)), '高峰模式提示条要标「会员」');
});

test('教程：每一步的高亮项都在示意图里，普通 / 机构模式都一样', () => {
  [false, true].forEach(org => {
    const g = loadGuide(org);
    ['host', 'clerk', 'guest'].forEach(tab => {
      const secs = g.secsOf(tab);
      assert.ok(secs.length > 0);
      secs.forEach(s => s.steps.forEach(st => {
        const k = `${org ? '机构' : '普通'}/${tab}/${st.title}`;
        const m = st.mock;
        if (m.type === 'grid') {
          assert.ok(m.items.length === (org ? 7 : 6), k + ' 宫格格数');
          if (m.hl) assert.ok(m.items.includes(m.hl), k + ' 高亮格不存在：' + m.hl);
        } else if (m.type === 'menu') {
          const flat = [].concat(...m.groups.map(x => x.items));
          assert.strictEqual(flat.length, 11, k);
          if (m.hl) {
            assert.ok(flat.includes(m.hl), k + ' 高亮菜单项不存在：' + m.hl);
            assert.ok(m.groups.some(x => x.show && x.items.includes(m.hl)), k + ' 高亮项所在组要展开');
          }
        } else if (m.type === 'bars') {
          assert.ok(m.items.some(b => b.k === m.hl), k);
        } else if (m.type === 'printer3') {
          assert.ok(m.items.some(b => b.k === m.hl), k);
        } else if (m.type === 'cashdesk') {
          assert.ok(['status', 'name', 'amount', 'sum'].includes(m.hl), k);
        } else if (m.type === 'flow') {
          assert.ok(m.items.includes(m.hl), k + ' 流程高亮不存在：' + m.hl);
        } else {
          assert.strictEqual(m.type, 'page', k);
        }
      }));
    });
  });
});

test('教程：跳转页面存在于 app.json，底部菜单页用 tab 标记', () => {
  const app = JSON.parse(read('app.json'));
  const pages = new Set(app.pages.map(p => '/' + p));
  (app.subpackages || []).forEach(sp => sp.pages.forEach(p => pages.add('/' + sp.root + '/' + p)));
  const tabs = new Set(((app.tabBar && app.tabBar.list) || []).map(t => '/' + t.pagePath));
  const g = loadGuide(false);
  ['host', 'clerk', 'guest'].forEach(tab => g.secsOf(tab).forEach(s => s.steps.forEach(st => {
    if (!st.url) return;
    assert.ok(pages.has(st.url), st.title + ' 的 url 不存在：' + st.url);
    assert.strictEqual(!!st.tab, tabs.has(st.url), st.title + ' 的 tab 标记不对');
  })));
});

test('教程：机构模式的文字替换覆盖标题、说明、位置、示意图提示条', () => {
  const g = loadGuide(true);
  const text = [];
  ['host', 'clerk', 'guest'].forEach(tab => g.secsOf(tab).forEach(s => s.steps.forEach(st => {
    text.push(st.title, st.desc, st.where);
    if (st.mock.type === 'bars') st.mock.items.forEach(b => text.push(b.t));
  })));
  const all = text.join('\n');
  assert.ok(!/礼簿管理|当前礼簿|其他礼簿|记账人/.test(all), '机构模式教程里仍有普通模式称呼：' + (all.match(/.{6}(礼簿管理|当前礼簿|其他礼簿|记账人).{6}/) || [''])[0]);
  assert.ok(/场次管理/.test(all) && /礼台人员/.test(all) && /其他场次/.test(all));
  assert.ok(!g.secsOf('host').some(s => s.sec === '平时'), '机构模式不显示「往来」');
});

test('教程：普通模式的内容要点（邀请规则、免费版额度、默认关闭的提醒）', () => {
  const g = loadGuide(false);
  const all = ['host', 'clerk', 'guest'].map(t => JSON.stringify(g.secsOf(t))).join('');
  assert.ok(/主家本人发的卡/.test(all), '缺少邀请规则');
  assert.ok(!/等主家同意"/.test(all), '不应再写「接受后一律等主家同意」');
  assert.ok(/免费版最多 3 本/.test(all) && /免费版最多 3 位/.test(all));
  assert.ok(/默认关闭/.test(all) && /高级功能/.test(all));
  assert.ok(/稳定模式/.test(all) && /10 分钟/.test(all));
  assert.ok(/等待主家确认/.test(all) && /入簿通知/.test(all));
  assert.ok(/回收站/.test(all));
});

test('文案：不再出现「外观设置」旧入口；回执样式入口是「我的」', () => {
  const files = ['pages/guide/guide.js', 'pages/guide/faq.js', 'pages/account/account.wxml', 'pages/account/account.js', 'pages/appearance/appearance.json', 'pages/appearance/appearance.js'];
  files.forEach(f => assert.ok(!/外观设置/.test(read(f)), f + ' 仍有「外观设置」'));
  assert.ok(!/工作台 → 回执样式/.test(read('pages/guide/faq.js') + read('pages/guide/guide.js')), '回执样式在「我的」里');
  assert.ok(/"navigationBarTitleText": "主题色"/.test(read('pages/appearance/appearance.json')));
});

test('文案：邀请卡规则各处一致（主家本人发的直接生效，转发的需同意）', () => {
  ['pages/invite/invite.wxml', 'pages/start/start.wxml', 'pages/bookshare/bookshare.wxml'].forEach(f => {
    const s = read(f);
    assert.ok(/主家本人发的卡|转发/.test(s), f + ' 没有写清邀请规则');
  });
  const faq = read('pages/guide/faq.js');
  assert.ok(!/点开就直接成为记账人/.test(faq));
  assert.ok(/不需要你再同意/.test(faq));
});
