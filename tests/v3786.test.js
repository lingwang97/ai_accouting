// v3.78.6：上线前清单四个模板与关键词；清除测试数据默认不保留管理员数据；逐笔确认卡片恢复核对提示
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('v3.78.6 清单：四个模板 ID 与各自关键词', () => {
  const s = read('cloudfunctions/system/index.js');
  const line = s.split('\n').find(l => l.includes("key: 'tmpl'"));
  assert.ok(line && line.includes('四个') && !line.includes('三个'));
  ['NOTIFY_TMPL_ID', 'GUEST_NOTIFY_TMPL_ID', 'GUEST_REJECT_TMPL_ID', 'REMIND_TMPL_ID'].forEach(k => assert.ok(line.includes(k), k));
  ['thing1/thing4/amount7/time9/thing3', 'thing6/amount3/time1/thing8/thing5', 'thing4/time1/amount2/thing3', 'thing2/thing10/time11/thing12/thing4'].forEach(k => assert.ok(line.includes(k), k));
  const cfg = read('miniprogram/config.js');
  ['NOTIFY_TMPL_ID', 'GUEST_NOTIFY_TMPL_ID', 'GUEST_REJECT_TMPL_ID', 'REMIND_TMPL_ID'].forEach(k => assert.ok(new RegExp(k + ":\\s*'[^']+'").test(cfg), k));
});

test('v3.78.6 清除测试数据：默认不保留管理员，上线前检查统计含管理员数据', () => {
  assert.ok(/wipeKeepAdmins: false/.test(read('miniprogram/pages/admin/admin.js')));
  const s = read('cloudfunctions/system/index.js');
  assert.ok(/wipeAll\(admin, false, \{ keepAdmins: false \}\)/.test(s));
  assert.ok(!/wipeAll\(admin, false, \{ keepAdmins: true \}\)/.test(s));
});

test('v3.78.6 逐笔确认卡片：按转账+现金 / 现金 / 转账给出简短核对提示', () => {
  const w = read('miniprogram/pages/pending/pending.wxml');
  const m = w.match(/<view class="tip muted">\{\{current\.mixed \? '([^']+)' : \(current\.payMethod === 'cash' \? '([^']+)' : '([^']+)'\)\}\}<\/view>/);
  assert.ok(m, '核对提示存在');
  m.slice(1).forEach(t => { assert.ok(t.length <= 12, t); assert.ok(!/礼金/.test(t), t); });
});
