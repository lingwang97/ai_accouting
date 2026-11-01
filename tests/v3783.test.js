// v3.78.3：「我的」页重新分组（主家与人员 / 礼台与样式 / 数据与设置），回收站页「保留天数」入口，教程与提示同步
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const M = require('../miniprogram/pages/guide/mock.js');

const root = path.join(__dirname, '../miniprogram');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

/** 模拟 mine.wxml 各菜单项的 wx:if，算出每个角色看到的分组与菜单项 */
function visible(ctx) {
  const { role, account, pm = {}, readonly } = ctx;
  const org = !!(account && account.orgMode);
  if (role === 'viewer') return {};
  const g1 = [
    (role !== 'clerk' || pm.info || pm.paycode) && 'account',
    account && 'members',
    account && pm.members && 'share',
    (role === 'clerk' || org) && 'gifts'
  ].filter(Boolean);
  const g2 = ['printer', account && !readonly && pm.style && 'style', account && role === 'owner' && 'theme'].filter(Boolean);
  const g3 = account ? [pm.export && 'export', role === 'owner' && 'trash', 'advanced', role === 'owner' && 'transfer'].filter(Boolean) : null;
  const out = { '主家与人员': g1, '礼台与样式': g2 };
  if (g3) out['数据与设置'] = g3;
  return out;
}

test('我的：三个新分组按顺序出现，旧分组名从 mine.wxml 消失，成员按方案 B 排列', () => {
  const w = read('pages/mine/mine.wxml');
  const pos = ['>主家与人员<', '>礼台与样式<', '>数据与设置<', '>帮助与隐私<'].map(k => w.indexOf(k));
  assert.ok(pos.every(p => p > 0) && pos.slice(1).every((p, i) => p > pos[i]), '分组顺序');
  const order = (a, b, lst) => lst.reduce((ok, k, i, arr) => ok && (i === 0 || w.indexOf(k, a) > w.indexOf(arr[i - 1], a)), true);
  assert.ok(order(pos[0], pos[1], ['主家信息与收款码', '记账人管理', '礼簿共享管理', '随礼记录']));
  const g3 = w.slice(pos[2], pos[3]);
  const idx = ['导出与备份', '回收站', '高级功能', '>移交主家<'].map(k => g3.indexOf(k));
  assert.ok(idx.every(i => i > 0) && idx.slice(1).every((p, i) => p > idx[i]), '数据与设置：导出、回收站、高级功能、移交主家（最后）');
  assert.ok(w.slice(pos[1], pos[2]).includes('蓝牙打印机') && !w.slice(pos[1], pos[2]).includes('高级功能'));
  assert.ok(g3.includes("bindtap=\"goTransfer\" wx:if=\"{{role === 'owner'}}\"") && g3.includes('把{{account.orgMode'));
});

test('我的：各角色都没有空分组（owner / clerk 不同权限 / viewer / 机构模式）', () => {
  const acc = { orgMode: false };
  const cases = [
    { n: 'owner', c: { role: 'owner', account: acc, pm: { info: true, members: true, export: true, style: true } } },
    { n: 'owner 机构', c: { role: 'owner', account: { orgMode: true }, pm: { info: true, members: true, export: true, style: true } } },
    { n: 'clerk 只有记账权限', c: { role: 'clerk', account: acc, pm: {} } },
    { n: 'clerk 全权限', c: { role: 'clerk', account: acc, pm: { info: true, members: true, export: true, style: true, paycode: true } } },
    { n: '新用户无账户', c: { role: 'owner', account: null, pm: {} } }
  ];
  cases.forEach(({ n, c }) => {
    const v = visible(c);
    Object.keys(v).forEach(g => assert.ok(v[g].length > 0, `${n}：${g} 为空`));
  });
  assert.deepStrictEqual(visible({ role: 'viewer', account: acc, pm: {} }), {}, 'viewer 前三组都不显示');
  const clerk = visible(cases[2].c);
  assert.deepStrictEqual(clerk['数据与设置'], ['advanced'], '记账人只剩高级功能也显示该组');
  assert.ok(!visible(cases[0].c)['数据与设置'].includes('x') && visible(cases[2].c)['主家与人员'].includes('gifts'));
  assert.ok(!visible(cases[2].c)['数据与设置'].includes('transfer') && visible(cases[1].c)['数据与设置'].includes('transfer'));
});

test('教程示意图 MENU：新分组与顺序，机构模式替换不出错', () => {
  assert.deepStrictEqual(M.MENU.map(g => g.g), ['主家与人员', '礼台与样式', '数据与设置', '帮助与隐私']);
  assert.deepStrictEqual(M.MENU[0].items, ['主家信息与收款码', '记账人管理', '礼簿共享管理']);
  assert.deepStrictEqual(M.MENU[2].items, ['导出与备份', '回收站', '高级功能', '移交主家']);
  const orgText = s => String(s).replace(/礼簿管理/g, '场次管理').replace(/记账人/g, '礼台人员').replace(/当前礼簿/g, '当前场次');
  M.MENU.forEach(g => assert.strictEqual(orgText(g.g), g.g, '分组名不含被替换的词'));
  assert.strictEqual(orgText('记账人管理'), '礼台人员管理');
});

test('回收站页：主家显示「保留天数：N 天」入口并跳高级功能', () => {
  const w = read('pages/trash/trash.wxml');
  assert.ok(/wx:if="\{\{isOwner && days\}\}" bindtap="goAdvanced"/.test(w));
  assert.ok(w.includes('保留天数：{{days}} 天'));
  const js = read('pages/trash/trash.js');
  assert.ok(js.includes("getApp().globalData.role === 'owner'") && js.includes("/pages/advanced/advanced"));
});

test('用户可见文案里不再有旧分组名；「我的 → 记账人 / 礼台人员」都带「管理」', () => {
  const files = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'assets') walk(p); } else if (/\.(js|wxml|json)$/.test(e.name)) files.push(p);
    });
  })(root);
  files.forEach(f => {
    const t = fs.readFileSync(f, 'utf8');
    ['账号与收款', '样式与设备', '数据管理'].forEach(k => assert.ok(!t.includes(k), `${path.relative(root, f)} 仍含旧分组名「${k}」`));
    assert.ok(!/我的 → (记账人|礼台人员)(?!管理)/.test(t), `${path.relative(root, f)} 仍有「我的 → 记账人 / 礼台人员」`);
  });
});
