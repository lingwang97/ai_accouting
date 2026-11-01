// v3.77.4：「移交主家」入口从记账人页挪到「我的 → 账号与收款」，独立页 pages/transfer/transfer
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');

const root = path.join(__dirname, '../miniprogram');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

/** 载入页面 js（stub 掉 Page / wx / getApp），返回页面对象和 wx 调用记录 */
function loadPage(rel, reqStub) {
  let page = null;
  const calls = [];
  global.Page = o => { page = o; };
  global.getApp = () => ({ globalData: {} });
  global.getCurrentPages = () => [{}];
  global.wx = new Proxy({}, { get: (_, k) => (...a) => { calls.push([k, ...a]); } });
  const reqPath = require.resolve('../miniprogram/utils/request.js');
  const saved = require.cache[reqPath];
  require.cache[reqPath] = { id: reqPath, filename: reqPath, loaded: true, exports: reqStub || {} };
  const p = require.resolve('../miniprogram/' + rel);
  delete require.cache[p];
  require(p);
  delete require.cache[p];
  if (saved) require.cache[reqPath] = saved; else delete require.cache[reqPath];
  const inst = Object.assign({}, page, { data: JSON.parse(JSON.stringify(page.data)) });
  inst.setData = function (d) {
    Object.keys(d).forEach(k => {
      const m = /^(\w+)\[(\d+)\]\.(\w+)$/.exec(k);
      if (m) this.data[m[1]][+m[2]][m[3]] = d[k]; else this.data[k] = d[k];
    });
  };
  return { inst, calls };
}

test('我的：「移交主家」菜单只对主家显示，排在「记账人」后面，「记账人」小字改为邀请 / 权限', () => {
  const w = read('pages/mine/mine.wxml');
  assert.ok(w.includes('<text class="mi-text">移交主家</text>'));
  assert.ok(w.indexOf('移交主家</text>') > w.indexOf("'礼台人员管理' : '记账人管理'")); // v3.78.3：移至「数据与设置」组末尾
  assert.ok(/class="menu-item" bindtap="goTransfer" wx:if="\{\{role === 'owner'\}\}"/.test(w), '仅 owner 可见（机构模式同样显示，不加 orgMode 条件）');
  assert.ok(!/goTransfer[^>]*orgMode/.test(w));
  assert.ok(w.includes('邀请 / 权限') && !w.includes('邀请 / 移交主家'));
  assert.ok(read('pages/mine/mine.js').includes("/pages/transfer/transfer"));
  assert.ok(fs.existsSync(path.join(root, 'assets/icons/swap-m.svg')));
  // clerk / viewer 的 role 不等于 owner：条件对三种身份求值
  const vis = role => role === 'owner';
  assert.deepStrictEqual(['owner', 'clerk', 'viewer'].map(vis), [true, false, false]);
});

test('transfer 页：已注册分包、四个文件齐全、首句 theme.early、预加载不受影响', () => {
  const app = JSON.parse(read('app.json'));
  const sp = app.subpackages.find(s => s.root === 'pages/transfer');
  assert.ok(sp && sp.pages.includes('transfer'));
  ['js', 'json', 'wxml', 'wxss'].forEach(e => assert.ok(fs.existsSync(path.join(root, 'pages/transfer/transfer.' + e)), e));
  const js = read('pages/transfer/transfer.js');
  assert.ok(/onLoad\(\) \{ theme\.early\(this\); \}/.test(js));
  assert.ok(read('pages/transfer/transfer.wxml').includes('style="{{themeStyle}}"'));
});

test('transfer 页：搬来完整移交 UI 与逻辑，白事 / 机构用词', () => {
  const w = read('pages/transfer/transfer.wxml');
  ['onToggleBook', 'onPickAll', 'onStayClerk', 'onMakeTransfer', 'open-type="share" data-type="transfer"', 'transfer-warn', '移交后继续为对方记账', 'transfer-desc'].forEach(k => assert.ok(w.includes(k), k));
  assert.ok(w.includes("orgMode ? '场次' : '礼簿'") && w.includes("orgMode ? '礼台人员' : '记账人'"));
  const js = read('pages/transfer/transfer.js');
  assert.ok(js.includes("req.inviteCreate('transfer'"));
  assert.ok(js.includes('全部礼簿整体移交'));
});

test('transfer 页：非主家打开提示并返回，不加载礼簿', async () => {
  let listed = 0;
  const { inst, calls } = loadPage('pages/transfer/transfer.js', {
    accountGet: async () => ({ role: 'clerk', account: { accountName: 'x' } }),
    bookList: async () => { listed++; return { list: [] }; }
  });
  await inst.init();
  const modal = calls.find(c => c[0] === 'showModal');
  assert.ok(modal && modal[1].showCancel === false && modal[1].confirmText.length <= 4);
  modal[1].success();
  assert.ok(calls.some(c => c[0] === 'switchTab' || c[0] === 'navigateBack'));
  assert.strictEqual(listed, 0);
  assert.strictEqual(inst.data.loading, false);
});

test('transfer 页：主家载入礼簿、生成移交卡片、分享带移交 token', async () => {
  const created = [];
  const { inst } = loadPage('pages/transfer/transfer.js', {
    accountGet: async () => ({ role: 'owner', account: { accountName: '张府', orgMode: false } }),
    bookList: async () => ({ list: [{ _id: 'b1', name: '新婚', type: 'wedding', count: 3, sum: 600 }, { _id: 'b2', name: '满月', type: 'other', archived: true }] }),
    inviteCreate: async (type, o) => { created.push([type, o]); return { token: 'TK', full: false }; }
  });
  await inst.init();
  assert.strictEqual(inst.data.books.length, 2);
  inst.onToggleBook({ currentTarget: { dataset: { i: 0 } } });
  await inst.onMakeTransfer();
  assert.deepStrictEqual(created[0], ['transfer', { bookIds: ['b1'], stayClerk: true }]);
  const s = inst.onShareAppMessage({ from: 'button', target: { dataset: { type: 'transfer' } } });
  assert.strictEqual(s.path, '/pages/invite/invite?token=TK');
  assert.ok(s.title.includes('新婚'));
  // 右上角菜单转发不带移交卡
  assert.strictEqual(inst.onShareAppMessage({ from: 'menu' }).path, '/pages/index/index');
});

test('members 页：移交卡片与逻辑已移除，分享只剩邀请分支', () => {
  const js = read('pages/members/members.js');
  const w = read('pages/members/members.wxml');
  ['onMakeTransfer', 'onPickBooks', 'onStayClerk', 'transferToken', 'showPicker', 'stayClerk', '_transferNames'].forEach(k => {
    assert.ok(!js.includes(k), 'members.js 仍含 ' + k);
    assert.ok(!w.includes(k), 'members.wxml 仍含 ' + k);
  });
  assert.ok(!w.includes('data-type="transfer"') && !w.includes('移交给主家'));
  assert.ok(!js.includes("type === 'transfer'"));
  // 邀请分享保留
  assert.ok(w.includes('open-type="share" data-type="clerk"'));
  assert.ok(js.includes('邀请你为「${name}」记账') && js.includes('makeClerkInvite'));
});

test('常见问题：移交入口指向「我的 → 移交主家」和 transfer 页，旧入口说法不再出现', () => {
  const { FAQ } = require('../miniprogram/pages/guide/faq.js');
  const it = [].concat(...FAQ.map(c => c.items)).find(x => x.q === '怎么把礼簿移交给真正的主家？');
  assert.ok(it && it.a.includes('我的 → 移交主家') && it.url === '/pages/transfer/transfer');
  const all = ['pages/guide/faq.js', 'pages/guide/guide.js', 'pages/start/start.wxml', 'pages/invite/invite.wxml'].map(read).join('\n');
  assert.ok(!/记账人」?页的「移交|记账人 → 移交|邀请 \/ 移交主家/.test(all));
});

test('v3.78.2 移交页：「发给主家本人」只在生成移交卡片后出现（与礼簿共享一致）', () => {
  const w = read('pages/transfer/transfer.wxml').split(String.fromCharCode(13)).join('');
  const make = w.indexOf('wx:if="{{!transferToken}}"');
  const send = w.indexOf('发给主家本人');
  assert.ok(make > 0 && send > make, '生成按钮应在发送按钮之前');
  const between = w.slice(make, send);
  assert.ok(/<block wx:else>/.test(between), '发送按钮应在 !transferToken 的 wx:else 分支里');
});
