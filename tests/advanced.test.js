// v3.61.1 高级功能各项可用性（miniprogram/utils/advperm.js，纯函数）
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const A = require('../miniprogram/utils/advperm.js');

test('机构模式：主家 + 套餐含机构版 → 可用，无会员标签', () => {
  const r = A.orgItem({ role: 'owner', orgMode: false, features: { org: true } });
  assert.deepStrictEqual(r, { enabled: true, reason: '', contact: false, vip: false });
});

test('机构模式：主家、免费版、未开启 → 置灰，原因「机构版功能」，带联系我们，有会员标签', () => {
  const r = A.orgItem({ role: 'owner', orgMode: false, features: { org: false } });
  assert.strictEqual(r.enabled, false);
  assert.ok(/机构版/.test(r.reason));
  assert.strictEqual(r.contact, true);
  assert.strictEqual(r.vip, true);
});

test('机构模式：已开启但套餐到期 → 仍可操作（可关闭）', () => {
  const r = A.orgItem({ role: 'owner', orgMode: true, features: {} });
  assert.strictEqual(r.enabled, true);
});

test('机构模式：记账人 / 家人 → 置灰「仅主家可设置」，不带联系我们', () => {
  ['clerk', 'viewer'].forEach(role => {
    [true, false].forEach(org => {
      const r = A.orgItem({ role, orgMode: true, features: { org } });
      assert.strictEqual(r.enabled, false);
      assert.strictEqual(r.reason, '仅主家可设置');
      assert.strictEqual(r.contact, false);
    });
  });
});

test('刷新频率：主家 / 有确认权限的记账人可用', () => {
  assert.strictEqual(A.pollItem({ role: 'owner', perms: [], features: {} }).enabled, true);
  assert.strictEqual(A.pollItem({ role: 'clerk', perms: ['confirm'], features: { fastRefresh: true } }).enabled, true);
});

test('刷新频率：无确认权限的记账人、家人 → 置灰并写明原因，不带联系我们', () => {
  const c = A.pollItem({ role: 'clerk', perms: ['desk'], features: {} });
  assert.strictEqual(c.enabled, false);
  assert.ok(/确认收礼/.test(c.reason));
  assert.strictEqual(c.contact, false);
  assert.strictEqual(A.pollItem({ role: 'clerk', perms: null, features: {} }).enabled, false);
  const v = A.pollItem({ role: 'viewer', perms: [], features: {} });
  assert.strictEqual(v.enabled, false);
  assert.strictEqual(v.contact, false);
});

test('刷新频率：套餐关闭 fastRefresh → 标准档可选、高档置灰，带会员标签与联系我们；缺项视为开放', () => {
  const r = A.pollItem({ role: 'owner', perms: [], features: { fastRefresh: false } });
  assert.strictEqual(r.vip, true);
  assert.strictEqual(r.contact, true);
  assert.strictEqual(A.pollOptionEnabled(r, 'off'), true);
  ['low', 'mid', 'high'].forEach(k => assert.strictEqual(A.pollOptionEnabled(r, k), false));
  const open = A.pollItem({ role: 'owner', perms: [], features: {} });
  assert.strictEqual(open.vip, false);
  ['off', 'low', 'mid', 'high'].forEach(k => assert.strictEqual(A.pollOptionEnabled(open, k), true));
  const none = A.pollItem({ role: 'viewer', perms: [], features: {} });
  ['off', 'low'].forEach(k => assert.strictEqual(A.pollOptionEnabled(none, k), false));
});
