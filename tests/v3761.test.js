// v3.76.1 宾客提交页：限流只提示一次（固定文案弹窗）、其他错误照常提示、疑似重复弹窗文案分支
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, 'miniprogram', f), 'utf8');

/** 载入 pay.js 的 Page 定义，stub 掉 request / wx */
function loadPay(createImpl, dataExtra) {
  const src = read('pages/pay/pay.js');
  let def = null;
  const log = { toasts: [], modals: [], createOpts: [] };
  const req = {
    payCreate: async (d, opts) => { log.createOpts.push(opts); return createImpl(d, opts); },
    showErr: e => log.toasts.push('err:' + e.message),
    isNetErr: e => !!(e && !e.biz && (e.net || e.errMsg))
  };
  const sandboxRequire = p => {
    if (p === '../../utils/request.js') return req;
    if (p === '../../utils/guestsub.js') return { ask: async () => ({}), flags: () => ({}) };
    if (p.startsWith('../../')) return require(path.join(ROOT, 'miniprogram', p.replace('../../', '')));
    return require(p);
  };
  const wxStub = {
    showToast: o => log.toasts.push(o.title), showModal: o => { log.modals.push(o); if (o.success) o.success({ confirm: false }); },
    getStorageSync() { return ''; }, setStorageSync() {}, vibrateShort() {}
  };
  new Function('require', 'Page', 'wx', 'getApp', src)(sandboxRequire, o => { def = o; }, wxStub, () => ({ globalData: {} }));
  const page = Object.assign({}, def, {
    data: { ...def.data, aid: 'a1', payerName: '张三', amount: '500', payMethod: 'wechat', paidFirst: false, ...(dataExtra || {}) }, // v3.86.10 起「转账了吗？」不预选，这里按已选「还没转」
    setData(o) { Object.assign(this.data, o); }
  });
  return { page, log };
}
const bizErr = msg => { const e = new Error(msg); e.biz = true; return e; };

test('pay 提交：被限流时不弹 toast，只弹一个固定文案的弹窗（不含云端原话）', async () => {
  for (const msg of ['提交太频繁，请稍等几秒再试', '现在登记的人较多，请稍等几秒再试']) {
    const { page, log } = loadPay(async () => { throw bizErr(msg); });
    await page.onConfirmTransfer();
    assert.deepStrictEqual(log.toasts, []);
    assert.strictEqual(log.modals.length, 1);
    assert.strictEqual(log.modals[0].title, '还没有登记成功');
    assert.ok(!log.modals[0].content.includes(msg), '不拼云端原话');
    assert.ok(/不要直接扫礼台的收款码转账/.test(log.modals[0].content));
    assert.ok(log.modals[0].confirmText.length <= 4);
    assert.strictEqual(page.data.submitting, false);
    assert.deepStrictEqual(log.createOpts, [{ silent: true }]);
  }
});

test('pay 提交：现金随礼被限流的弹窗不提转账与收款码', async () => {
  const { page, log } = loadPay(async () => { throw bizErr('提交太频繁，请稍等几秒再试'); }, { payMethod: 'cash' });
  await page.onConfirmTransfer();
  assert.strictEqual(log.modals.length, 1);
  assert.ok(!/收款码|转账/.test(log.modals[0].content));
});

test('pay 提交：非限流错误（业务拒绝、网络失败）silent 后仍会提示一次，程序内部异常不弹', async () => {
  let { page, log } = loadPay(async () => { throw bizErr('该礼簿已归档，不能再登记'); });
  await page.onConfirmTransfer();
  assert.deepStrictEqual(log.toasts, ['err:该礼簿已归档，不能再登记']);
  assert.strictEqual(log.modals.length, 0);

  ({ page, log } = loadPay(async () => { const e = new Error('x'); e.net = true; throw e; }));
  await page.onConfirmTransfer();
  assert.deepStrictEqual(log.toasts, ['err:x']);

  ({ page, log } = loadPay(async () => { throw new TypeError('boom'); }));
  await page.onConfirmTransfer();
  assert.deepStrictEqual(log.toasts, []);
  assert.strictEqual(log.modals.length, 0);
});

test('request.payCreate 透传 opts（silent）', () => {
  const src = read('utils/request.js');
  assert.ok(/payCreate: \(d, opts\) => call\('payment', \{ action: 'create', envVersion: envVersion\(\), \.\.\.d \}, opts\)/.test(src));
});

test('askDup 文案：喜事转账保持原文案；现金改「礼台还没确认」；白事不出现「礼金」', () => {
  const dup = { name: '张三', amount: 500, status: 'pending', minutes: 3 };
  const run = extra => {
    const { page, log } = loadPay(async () => ({}), extra);
    page.askDup(dup);
    return log.modals[0];
  };
  let m = run({ act: '随礼', isFuneral: false, payMethod: 'wechat' });
  assert.ok(m.content.includes('还没点「我已完成转账」') && m.content.includes('确定再登记一笔礼金？'));
  assert.strictEqual(m.title, '你刚登记过这笔');
  m = run({ act: '随礼', isFuneral: false, payMethod: 'cash' });
  assert.ok(m.content.includes('礼台还没确认') && !m.content.includes('我已完成转账'));
  m = run({ act: '登记', isFuneral: true, payMethod: 'cash' });
  assert.ok(!m.content.includes('礼金') && m.content.includes('奠仪') && m.title === '你刚登记过');
  assert.ok(m.confirmText === '再登记' && m.cancelText === '不用了');
});
