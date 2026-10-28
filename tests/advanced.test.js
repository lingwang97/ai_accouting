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

test('v3.70.0 去掉「工作台刷新频率」：advperm 不再有 pollItem / pollOptionEnabled，高级功能页没有刷新卡片', () => {
  assert.strictEqual(A.pollItem, undefined);
  assert.strictEqual(A.pollOptionEnabled, undefined);
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, '..', 'miniprogram', 'pages', 'advanced');
  const wxml = fs.readFileSync(path.join(dir, 'advanced.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(dir, 'advanced.js'), 'utf8');
  assert.ok(!/工作台刷新频率/.test(wxml) && !/onPollHead|onPick|setPollLevel/.test(wxml + js));
});
