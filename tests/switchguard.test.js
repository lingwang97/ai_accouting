// v3.66.4 普通模式切换当前礼簿的两次确认（utils/switchguard.js）
const assert = require('assert');
const { test } = require('./helpers/harness.js');
const { confirmSwitch } = require('../miniprogram/utils/switchguard.js');

// answers：依次对每个弹窗的回答（true=确认）；返回弹窗记录
function mockWx(answers) {
  const calls = [];
  global.wx = { showModal: o => { calls.push(o); const ok = answers[calls.length - 1]; o.success({ confirm: !!ok, cancel: !ok }); } };
  return calls;
}
const args = { orgMode: false, fromName: 'A礼簿', toName: 'B礼簿' };

test('switchguard：两次都确认才切换', async () => {
  const calls = mockWx([true, true]);
  assert.strictEqual(await confirmSwitch(args), true);
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[0].content.includes('B礼簿') && calls[0].content.includes('机构模式'));
  assert.ok(calls[1].content.includes('A礼簿') && calls[1].content.includes('B礼簿'));
  calls.forEach(c => { assert.ok(c.confirmText.length <= 4 && c.cancelText.length <= 4); });
});
test('switchguard：第一次取消不再弹第二次、不切换', async () => {
  const calls = mockWx([false]);
  assert.strictEqual(await confirmSwitch(args), false);
  assert.strictEqual(calls.length, 1);
});
test('switchguard：第二次取消不切换', async () => {
  const calls = mockWx([true, false]);
  assert.strictEqual(await confirmSwitch(args), false);
  assert.strictEqual(calls.length, 2);
});
test('switchguard：机构模式与第一本礼簿不拦', async () => {
  const calls = mockWx([]);
  assert.strictEqual(await confirmSwitch({ ...args, orgMode: true }), true);
  assert.strictEqual(await confirmSwitch({ ...args, fromName: '' }), true);
  assert.strictEqual(calls.length, 0);
});
test('switchguard：弹窗失败视为取消', async () => {
  global.wx = { showModal: o => o.fail({}) };
  assert.strictEqual(await confirmSwitch(args), false);
});
