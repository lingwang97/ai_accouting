// v3.75.1 写账一致性（上线前必修）：礼台同名重试不重复入簿、读库失败不当成「记录不存在」、限流数值与提示、确认 / 修改超时后重试按成功处理
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction } = require('./helpers/sdk-stub.js');

const OWNER = 'o-owner';
const MP = path.join(__dirname, '..', 'miniprogram');
const read = f => fs.readFileSync(path.join(MP, f), 'utf8');

/** 用桩模块加载小程序页面 / 工具模块（stubs：{ 'utils/request.js': {...} }） */
function loadMp(file, stubs, globals) {
  const keys = [];
  Object.keys(stubs || {}).forEach(k => {
    const p = path.join(MP, k);
    require.cache[p] = { id: p, filename: p, loaded: true, exports: stubs[k] };
    keys.push(p);
  });
  Object.assign(global, globals || {});
  const target = path.join(MP, file);
  delete require.cache[target];
  let page = null;
  global.Page = o => { page = o; };
  const exp = require(target);
  keys.forEach(p => { delete require.cache[p]; });
  delete require.cache[target];
  return page || exp;
}
function pageInst(page) {
  const inst = Object.assign({}, page, { data: JSON.parse(JSON.stringify(page.data)) });
  inst.setData = function (d) { Object.assign(this.data, d); };
  inst.selectComponent = () => ({ reset() {} });
  return inst;
}
const wxStub = () => ({ showToast() {}, showModal() {}, showLoading() {}, hideLoading() {}, vibrateShort() {}, getStorageSync() { return ''; }, setStorageSync() {}, removeStorageSync() {} });

// ---- ❌1 礼台记账：同名选择后响应丢失，重点「入簿」仍带同一个 reqId
test('cash.onSave：nameCheck 与选同名后的第二次调用、以及超时后重点入簿，都带同一个 reqId', async () => {
  const calls = [];
  let step = 0;
  const req = {
    cashEntry: async d => {
      calls.push(JSON.parse(JSON.stringify(d)));
      step++;
      if (step === 1) return { needPick: true, map: { 王五: [{ ref: 'r-old', tag: '东村', inBook: 1, count: 1 }] } };
      if (step === 2) { const e = new Error('timeout'); e.net = true; throw e; } // 云端其实已入簿，响应丢了
      return { record: { _id: 'q1', payerName: '王五', amount: 200, payMethod: 'cash' }, duplicate: true };
    }
  };
  const page = loadMp('pages/cash/cash.js', {
    'utils/request.js': req,
    'utils/printer.js': { autoConnect: async () => 'none' },
    'utils/ble.js': { onStateChange() {}, offStateChange() {}, printerStatus: () => 'none', loadDevice: () => null, state: {} },
    'utils/theme.js': { apply: () => ({}), early() {} },
    'utils/perm.js': { can: () => true }
  }, { wx: wxStub(), getApp: () => ({ globalData: { account: null } }) });
  const p = pageInst(page);
  p.data.books = [];
  p.data.payerName = '王五';
  p.data.amount = '200';
  // 同名弹窗：两次都选「本场的王五」
  p.pickSameName = async payload => { payload.personRef = 'r-old'; payload.tag = '东村'; return { notes: [] }; };
  p.print = async () => {};
  await p.onSave();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].nameCheck, true);
  assert.strictEqual(calls[1].personRef, 'r-old');
  assert.strictEqual(calls[0].reqId, calls[1].reqId, '选同名后的提交复用同一个 reqId');
  // 超时后表单还在，重点入簿：表单重建（不带 personRef），仍是同一个 reqId
  await p.onSave();
  assert.strictEqual(calls[2].reqId, calls[0].reqId, '重点入簿复用 reqId，云端会跳过同名检查、按重复提交返回');
  assert.strictEqual(calls[2].nameCheck, true);
  assert.strictEqual(p._reqId, '', '成功后换新 reqId');
  // 改了表单就是新的一笔
  p.data.payerName = '王五'; p.data.amount = '300';
  step = 2; // 下一次直接成功
  await p.onSave();
  assert.notStrictEqual(calls[3].reqId, calls[0].reqId);
});

// 服务端配合：同一 reqId 第一次 needPick（未写入）→ 第二次入簿 → 重试带 nameCheck 直接返回 duplicate，只有一条
function seedDesk() {
  db.reset().applyUpdates = true;
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '李府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, type: 'wedding', name: '婚宴', statReady: true, statCount: 0, statFen: 0, statSince: new Date(0) }])
    .seed('records', []);
  db.persist = true;
  sdk.openapi.security = { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) };
}
const origCol = db.collection.bind(db);
/** 记录 _id 已存在时 add 抛错（与真实数据库一致）；getFail(id, n)：返回 true 时该次 doc(id).get 抛网络错误 */
async function withDb(fn, getFail) {
  let n = 0;
  db.collection = name => {
    const c = origCol(name);
    if (name === 'records') {
      const add = c.add;
      c.add = async o => { if (o && o.data && o.data._id && (db.data.records || []).some(x => x._id === o.data._id)) throw new Error('duplicate key'); return add(o); };
      const doc = c.doc;
      c.doc = id => {
        const d = doc(id);
        const get = d.get.bind(d);
        d.get = async () => { if (getFail && getFail(id, n++)) { const e = new Error('database request timeout'); e.errCode = -501001; throw e; } return get(); };
        return d;
      };
    }
    return c;
  };
  try { await fn(); } finally { db.collection = origCol; db.aggList = null; }
}
const desk = ev => { state.openid = OWNER; return loadFunction('payment').main({ action: 'cashEntry', amount: 200, bookId: 'b1', ...ev }); };

test('cashEntry：needPick 后同一 reqId 入簿，重试（带 nameCheck）按重复返回，不再入簿、合计只加一次', async () => {
  seedDesk();
  db.aggList = a => (a.stages.some(s => s[0] === 'group') ? [{ _id: { name: '王五', openid: '', tag: '东村', bk: 'b1' }, count: 1, ref: 'r-old' }] : []);
  await withDb(async () => {
    const r1 = await desk({ payerName: '王五', nameCheck: true, reqId: 'cdesk-0001' });
    assert.strictEqual(r1.data.needPick, true);
    const r2 = await desk({ payerName: '王五', tag: '东村', reqId: 'cdesk-0001' });
    assert.strictEqual(r2.code, 0, r2.msg);
    const r3 = await desk({ payerName: '王五', nameCheck: true, reqId: 'cdesk-0001' });
    assert.strictEqual(r3.code, 0, r3.msg);
    assert.ok(!r3.data.needPick);
    assert.strictEqual(r3.data.duplicate, true);
    assert.strictEqual(db.data.records.length, 1);
    assert.strictEqual(db.data.books[0].statFen, 20000);
  });
});

// ---- ❌2 读库失败不当成「记录不存在」
function seedPay(records) {
  db.reset().applyUpdates = true;
  sdk.openapi.subscribeMessage = { send: async () => {} };
  sdk.openapi.security = { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) };
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '张府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER, nickname: '主家' }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '新婚之喜', type: 'wedding', statReady: true, statCount: 0, statFen: 0, statSince: new Date(0) }])
    .seed('records', records);
}
const rec = (id, extra) => ({ _id: id, aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', payerOpenid: 'g1', payerName: '王五', amount: 600, payMethod: 'wechat', status: 'transferred', createdAt: new Date(), transferredAt: new Date(), ...extra });
const call = (ev, id) => { state.openid = id; return loadFunction('payment').main(ev); };

test('status / transferred：读记录遇到数据库错误返回 code 2「网络异常」，不说「记录不存在」', async () => {
  seedPay([rec('r1', { status: 'pending' })]);
  await withDb(async () => {
    const s = await call({ action: 'status', rid: 'r1' }, 'g1');
    assert.strictEqual(s.code, 2);
    assert.ok(!/不存在/.test(s.msg));
    const t = await call({ action: 'transferred', rid: 'r1' }, 'g1');
    assert.strictEqual(t.code, 2);
    assert.strictEqual(db.data.records[0].status, 'pending', '读失败时没有改状态');
  }, () => true);
  // 真不存在仍是「记录不存在」
  const s2 = await call({ action: 'status', rid: 'nope' }, 'g1');
  assert.strictEqual(s2.code, 1);
  assert.ok(/不存在/.test(s2.msg));
});

test('confirm：状态已改成入簿后读回记录失败，仍累加礼簿合计、返回记录供打印（不报「记录不存在」）', async () => {
  seedPay([rec('r1')]);
  let reads = 0;
  await withDb(async () => {
    const r = await call({ action: 'confirm', rid: 'r1' }, OWNER);
    assert.strictEqual(r.code, 0, r.msg);
    assert.strictEqual(r.data.record.status, 'paid');
    assert.strictEqual(r.data.record.amount, 600);
    assert.ok(!JSON.stringify(r.data).includes('g1'), '返回前端不带 openid');
    assert.ok(!('autoCancelled' in r.data.record), '数据库指令（_.remove）不出现在返回里');
  }, id => id === 'r1' && ++reads >= 2); // 第 1 次（更新前）成功，之后都失败
  assert.strictEqual(db.data.records[0].status, 'paid');
  assert.strictEqual(db.data.books[0].statCount, 1);
  assert.strictEqual(db.data.books[0].statFen, 60000);
});

test('confirm：按实际金额入簿时读回失败，合计按实收累加', async () => {
  seedPay([rec('r1')]);
  let reads = 0;
  await withDb(async () => {
    const r = await call({ action: 'confirm', rid: 'r1', amount: 500 }, OWNER);
    assert.strictEqual(r.code, 0, r.msg);
    assert.strictEqual(r.data.record.amount, 500);
  }, id => id === 'r1' && ++reads >= 2);
  assert.strictEqual(db.data.books[0].statFen, 50000);
});

test('void：作废前也先读记录，读回失败仍按原金额减合计', async () => {
  seedPay([rec('r1', { status: 'paid', paidAt: new Date() })]);
  db.data.books[0].statCount = 1; db.data.books[0].statFen = 60000;
  let reads = 0;
  await withDb(async () => {
    const r = await call({ action: 'void', rid: 'r1' }, OWNER);
    assert.strictEqual(r.code, 0, r.msg);
  }, id => id === 'r1' && ++reads >= 2);
  assert.strictEqual(db.data.books[0].statCount, 0);
  assert.strictEqual(db.data.books[0].statFen, 0);
});

test('confirm 批次：先读记录失败时报网络异常，不降级成只确认一笔', async () => {
  seedPay([rec('a', { batchId: 'B1', batchIdx: 0 }), rec('b', { batchId: 'B1', batchIdx: 1, payerName: '李四' })]);
  await withDb(async () => {
    const r = await call({ action: 'confirm', rid: 'a' }, OWNER);
    assert.strictEqual(r.code, 2);
  }, () => true);
  assert.deepStrictEqual(db.data.records.map(x => x.status), ['transferred', 'transferred']);
});

test('transferred：给主家发新礼金提醒出错不影响结果', async () => {
  seedPay([rec('r1', { status: 'pending' })]);
  const notify = require('../cloudfunctions/payment/notify.js');
  const old = notify.TMPL_ID;
  notify.TMPL_ID = old || 'tmpl-test';
  try {
    const m = loadFunction('payment');
    // 重新加载后 notify 模块是新实例：把 users 查询弄坏，让 recipientsOf → giftOnly 抛错
    const origCol2 = db.collection.bind(db);
    db.collection = name => { if (name === 'users') throw new Error('db busy'); return origCol2(name); };
    try {
      state.openid = 'g1';
      const r = await m.main({ action: 'transferred', rid: 'r1' });
      assert.strictEqual(r.code, 0, r.msg);
    } finally { db.collection = origCol2; }
  } finally { notify.TMPL_ID = old; }
  assert.strictEqual(db.data.records[0].status, 'transferred');
});

// ---- ⚠️5 限流数值与提示
test('限流：每宾客每分钟 5、每本礼簿每分钟 150、同名检查每 10 分钟 40；提示说明「稍等几秒」', () => {
  const src = fs.readFileSync(path.join(__dirname, '../cloudfunctions/payment/index.js'), 'utf8');
  assert.ok(/const RATE_MAX = 5;/.test(src));
  assert.ok(/const BOOK_RATE_MAX = 150;/.test(src));
  assert.ok(/const NAME_CHECK_MAX = 40;/.test(src));
  assert.ok(/BUSY_MSG = '提交太频繁，请稍等几秒再试'/.test(src));
  assert.ok(/CROWD_MSG = '现在登记的人较多，请稍等几秒再试'/.test(src));
  assert.ok(!/操作太频繁，请稍后再试'\)/.test(src.split('async function appeal')[0]), 'create 不再用旧文案');
  const pay = read('pages/pay/pay.js');
  assert.ok(/稍等几秒/.test(pay) && /不要直接扫礼台的收款码转账/.test(pay), 'pay 页被限流时弹窗提醒先别转账');
  assert.ok(/payStatus\(this\.data\.record\._id, \{ silent: true \}\)/.test(pay), '等待页轮询静默');
  assert.ok(/payStatus\(o\.rid, \{ silent: true \}\)/.test(pay));
});

// ---- L3 确认超时后重试：已入簿按成功处理并打印未打印的
function loadConfirm(detail, printed) {
  const toasts = [];
  const req = {
    recordDetail: async id => ({ record: detail[id] }),
    showErr: e => toasts.push('err:' + e.message),
    payConfirm: async () => { const e = new Error('当前状态不可操作，请刷新'); e.biz = true; throw e; }
  };
  const C = loadMp('utils/confirm.js', {
    'utils/request.js': req,
    'utils/printer.js': { autoConnect: async () => 'ok', printRecord: async r => { printed.push(r._id); } },
    'utils/notify.js': { renewSilently() {} }
  }, { wx: Object.assign(wxStub(), { showToast: o => toasts.push(o.title) }), getApp: () => ({ refreshBadge() {} }) });
  return { C, toasts };
}
const flush = () => new Promise(r => setTimeout(r, 10));

test('confirm.confirmDirect：报「当前状态不可操作」但其实已入簿 → 提示已记入并补打（已打印的不重打）', async () => {
  const printed = [];
  const { C, toasts } = loadConfirm({ r1: { _id: 'r1', status: 'paid', printed: false, amount: 600 } }, printed);
  assert.strictEqual(await C.confirmDirect({ _id: 'r1', amount: 600 }), true);
  await flush();
  assert.deepStrictEqual(toasts, ['已记入礼簿']);
  assert.deepStrictEqual(printed, ['r1']);

  const p2 = [];
  const x = loadConfirm({ a: { _id: 'a', status: 'paid', printed: true }, b: { _id: 'b', status: 'paid', printed: false } }, p2);
  assert.strictEqual(await x.C.confirmDirect({ _id: 'a', amount: 1, records: [{ _id: 'a' }, { _id: 'b' }] }), true);
  await flush();
  assert.deepStrictEqual(p2, ['b']);
});

test('confirm.confirmDirect：别人标了未收到等非入簿状态 → 照常提示错误，返回 false', async () => {
  const printed = [];
  const { C, toasts } = loadConfirm({ r1: { _id: 'r1', status: 'rejected' } }, printed);
  assert.strictEqual(await C.confirmDirect({ _id: 'r1', amount: 600 }), false);
  assert.deepStrictEqual(toasts, ['err:当前状态不可操作，请刷新']);
  assert.deepStrictEqual(printed, []);
});

test('records 修改：「刚被修改」时读回最新内容，与这次要改的一致按成功处理', () => {
  const src = read('pages/records/records.js');
  assert.ok(/payAmend\(a\.rid, fields, \{ silent: true \}\)/.test(src));
  assert.ok(/刚被修改/.test(src) && /recordDetail\(a\.rid/.test(src) && /amendDone\(cur, fields\)/.test(src));
  const m = src.match(/function amendDone\(cur, fields\) \{[\s\S]*?\n\}/);
  const amendDone = new Function(m[0] + '; return amendDone;')();
  assert.strictEqual(amendDone({ amount: 500, payerName: '王五' }, { amount: 500 }), true);
  assert.strictEqual(amendDone({ amount: 600, payerName: '王五' }, { amount: 500 }), false);
  assert.strictEqual(amendDone({ amount: 600, payerName: '王六', relation: '' }, { payerName: '王六', relation: '' }), true);
  const r = read('utils/request.js');
  assert.ok(/recordDetail: \(rid, opts\) => call\('records', \{ action: 'detail', rid \}, opts\)/.test(r));
  assert.ok(/function showErr\(e\)/.test(r));
});
