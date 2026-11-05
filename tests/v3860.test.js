// v3.86.0 先转账后登记（pay 页「转账了吗？」+ create paidFirst）、登记时订阅一次、回来提醒、取消状态误判、台卡上下两块
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');

const OWNER = 'o-owner';
const MIN = 60 * 1000;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const quiet = async fn => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; } };

// ———————— 云端 create ————————
function seed(records) {
  db.reset().applyUpdates = true;
  db.persist = true;
  sdk.openapi.security = { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) };
  sdk.openapi.subscribeMessage = { send: async () => {} };
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '李府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, type: 'wedding', name: '婚宴', statReady: true, statCount: 0, statFen: 0, statSince: new Date(0) }])
    .seed('records', records || []);
}
let seq = 0;
const create = (extra, who) => { state.openid = who || 'g1'; return loadFunction('payment').main({ action: 'create', aid: 'acc1', payerName: '张三', amount: 500, dupCheck: true, reqId: 'pf860-' + (++seq) + '-xxxx', ...extra }); };
const rows = () => db.data.records;

test('create：paidFirst + 微信转账 → 直接是「已转账」，记 transferredAt 与 paidFirst，不要收款码', async () => {
  seed();
  const r = await create({ paidFirst: true });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(r.data.record.status, 'transferred');
  assert.ok(!r.data.record.payCodeUrl);
  const d = rows()[0];
  assert.strictEqual(d.status, 'transferred');
  assert.strictEqual(d.paidFirst, true);
  assert.ok(d.transferredAt instanceof Date);
  assert.strictEqual(d.payMethod, 'wechat');
});

test('create：不带 paidFirst（或不是布尔 true）仍是待转账 pending，行为不变', async () => {
  for (const v of [undefined, false, 'true', 1, {}]) {
    seed();
    const r = await create({ paidFirst: v });
    assert.strictEqual(r.code, 0, r.msg);
    assert.strictEqual(rows()[0].status, 'pending', String(v));
    assert.ok(!('paidFirst' in rows()[0]));
    assert.ok(!rows()[0].transferredAt);
  }
});

test('create：paidFirst 不能用于现金（含被降为现金的转账+现金），现金照旧、不带 paidFirst 标记', async () => {
  seed();
  let r = await create({ payMethod: 'cash', paidFirst: true });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(rows()[0].payMethod, 'cash');
  assert.ok(!('paidFirst' in rows()[0]), '现金不记 paidFirst');
  seed();
  // 转账+现金，但每个人都选现金：按现金处理
  r = await create({ payMethod: 'mixed', paidFirst: true, items: [{ name: '甲', amount: 100, method: 'cash' }, { name: '乙', amount: 200, method: 'cash' }] });
  assert.strictEqual(r.code, 0, r.msg);
  assert.ok(rows().every(x => x.payMethod === 'cash' && !('paidFirst' in x)));
  // 单人 mixed 选现金
  seed();
  await create({ payMethod: 'mixed', paidFirst: true, items: [{ name: '甲', amount: 100, method: 'cash' }] });
  assert.ok(rows().every(x => !('paidFirst' in x)));
});

test('create：批次与转账+现金混合支付都支持先转后登（整批已转账）', async () => {
  seed();
  let r = await create({ paidFirst: true, items: [{ name: '甲', amount: 100 }, { name: '乙', amount: 200 }] });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(rows().length, 2);
  assert.ok(rows().every(x => x.status === 'transferred' && x.paidFirst === true && x.batchId));
  seed();
  r = await create({ paidFirst: true, payMethod: 'mixed', items: [{ name: '甲', amount: 100, method: 'wechat' }, { name: '乙', amount: 200, method: 'cash' }] });
  assert.strictEqual(r.code, 0, r.msg);
  assert.strictEqual(r.data.record.transferAmount, 100);
  assert.strictEqual(r.data.record.cashAmount, 200);
  assert.ok(rows().every(x => x.status === 'transferred' && x.paidFirst === true && x.batchPay === 'mixed'));
});

test('create：paidFirst 仍做疑似重复检查（dupOf，不建记录）与同名检查（needTag）', async () => {
  seed([{ _id: 'r1', aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', payerOpenid: 'g1', payerName: '张三', amount: 500, payMethod: 'wechat', status: 'transferred', createdAt: new Date(Date.now() - 5 * MIN) }]);
  let r = await create({ paidFirst: true });
  assert.ok(r.data.dupOf, '应提示疑似重复');
  assert.strictEqual(rows().length, 1);
  r = await create({ paidFirst: true, allowDup: true });
  assert.ok(r.data.record && r.data.record.status === 'transferred');
  assert.strictEqual(rows().length, 2);
  // 同名：本场已有别人（g9）登记的「李四」
  seed([{ _id: 'r9', aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', payerOpenid: 'g9', payerName: '李四', amount: 100, status: 'paid' }]);
  r = await create({ paidFirst: true, payerName: '李四', amount: 300 });
  assert.deepStrictEqual(r.data.needTag, ['李四']);
  assert.strictEqual(rows().length, 1, '要求区分备注时不建记录');
});

test('create：paidFirst 同一 reqId 重试只记一条，返回库里真实状态；限流规则不变', async () => {
  seed();
  const a = await create({ paidFirst: true, reqId: 'pf860-retry-0001' });
  const b = await create({ paidFirst: true, reqId: 'pf860-retry-0001' });
  // fakedb 的 add 不拒绝重复 _id（真实库会），这里只核对返回的是同一条记录
  assert.strictEqual(b.data.record._id, a.data.record._id);
  assert.strictEqual(b.data.record.status, 'transferred');
  // 同一付款人每分钟最多 5 次：不同姓名连发，超过后被拒
  seed();
  const out = [];
  for (let i = 0; i < 8; i++) out.push(await create({ paidFirst: true, payerName: '宾' + i, amount: 100 + i }, 'g-rate'));
  assert.ok(out.slice(0, 5).every(x => x.code === 0));
  assert.ok(out.slice(5).every(x => x.code !== 0), '第 6 次起被限流');
});

test('create：宾客登记时就存订阅标记（微信转账也存），之后点「已转账」不带也行', async () => {
  seed();
  await create({ guestNotify: true, guestRejectNotify: true, envVersion: 'trial' });
  const d = rows()[0];
  assert.strictEqual(d.status, 'pending');
  assert.strictEqual(d.guestNotify, true);
  assert.strictEqual(d.guestRejectNotify, true);
  assert.strictEqual(d.guestEnv, 'trial');
  seed();
  await create({ paidFirst: true, guestNotify: true });
  assert.strictEqual(rows()[0].guestNotify, true);
  seed();
  await create({});
  assert.ok(!('guestNotify' in rows()[0]));
});

test('status：已取消带 auto（超时自动取消 true，宾客自己取消 false）；时间线标明先转后登', async () => {
  seed([
    { _id: 'c1', aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', payerOpenid: 'g1', payerName: '甲', amount: 1, status: 'cancelled', autoCancelled: true, createdAt: new Date() },
    { _id: 'c2', aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', payerOpenid: 'g1', payerName: '乙', amount: 1, status: 'cancelled', createdAt: new Date() },
    { _id: 'c3', aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', payerOpenid: 'g1', payerName: '丙', amount: 1, status: 'transferred', createdAt: new Date() }
  ]);
  state.openid = 'g1';
  const P = loadFunction('payment');
  assert.strictEqual((await P.main({ action: 'status', rid: 'c1' })).data.auto, true);
  assert.strictEqual((await P.main({ action: 'status', rid: 'c2' })).data.auto, false);
  assert.ok(!('auto' in (await P.main({ action: 'status', rid: 'c3' })).data));
  seed();
  const r = await create({ paidFirst: true });
  state.openid = 'g1';
  const my = await loadFunction('payment').main({ action: 'myReceipts', tab: 'waiting' });
  const row = (my.data.list || my.data.rows || []).find(x => x._id === r.data.record._id);
  assert.ok(row, '待确认标签里有这一笔');
  assert.ok(row.timeline.some(t => /先转账，再登记/.test(t.text)) && !row.timeline.some(t => /我已完成转账/.test(t.text)));
});

test('主家待确认：paidFirst 的记录在 pending 列表（带标记），不在「宾客未点完成」', async () => {
  seed();
  await create({ paidFirst: true });
  state.openid = OWNER;
  const res = await quiet(() => loadFunction('records').main({ action: 'pending' }));
  assert.strictEqual(res.code, 0, res.msg);
  assert.strictEqual(res.data.list.length, 1);
  assert.strictEqual(res.data.list[0].paidFirst, true);
  assert.strictEqual(res.data.stalled.length, 0);
  assert.ok(!/payerOpenid/.test(JSON.stringify(res.data)));
});

// ———————— pay 页前端（假 wx） ————————
function loadPay(opts) {
  const o = opts || {};
  const src = read('miniprogram/pages/pay/pay.js');
  const calls = { create: [], transferred: [], ask: 0, modals: [], toasts: [] };
  const store = Object.assign({}, o.storage || {});
  let now = 10000000;
  const realNow = Date.now;
  Date.now = () => now;
  const realGuest = require(path.join(ROOT, 'miniprogram/utils/guestsub.js'));
  const reqStub = {
    accountGetByAid: async () => ({ account: { accountName: '李府', book: { type: o.funeral ? 'funeral' : 'wedding', name: '婚宴' } } }),
    payCreate: async d => { calls.create.push(d); if (o.createFail) throw Object.assign(new Error('x'), { biz: true }); return o.createRes ? o.createRes(d) : { record: { _id: 'r1', status: d.paidFirst && d.payMethod !== 'cash' ? 'transferred' : (d.payMethod === 'cash' ? 'transferred' : 'pending'), payMethod: d.payMethod, payerName: d.payerName || '批', amount: d.amount || 100, transferAmount: d.amount || 100, cashAmount: 0, payCodeUrl: 'https://x/c.png', items: [] } }; },
    payTransferred: async (rid, sub) => { calls.transferred.push({ rid, sub }); return o.transferredRes || { status: 'transferred', changed: true }; },
    payStatus: async () => o.statusRes || { status: 'pending' },
    payCancel: async () => ({}),
    receiptGet: async () => { throw new Error('x'); },
    isNetErr: () => false, showErr() {}, errText: () => ''
  };
  const guestStub = { ask: () => { calls.ask++; return Promise.resolve({ guestNotify: true, guestRejectNotify: true }); }, flags: realGuest.flags };
  const sandboxRequire = p => {
    if (p === '../../utils/request.js') return reqStub;
    if (p === '../../utils/guestsub.js') return guestStub;
    if (p.startsWith('../../')) return require(path.join(ROOT, 'miniprogram', p.replace('../../', '')));
    return require(p);
  };
  const wxStub = {
    getStorageSync: k => store[k], setStorageSync: (k, v) => { store[k] = v; }, removeStorageSync: k => { delete store[k]; },
    showToast: t => calls.toasts.push(t.title), showModal: m => { calls.modals.push(m); if (o.modalReply) setImmediate(() => m.success && m.success(o.modalReply(m))); },
    setNavigationBarColor() {}, setNavigationBarTitle() {}, vibrateShort() {}, stopPullDownRefresh() {}
  };
  let def = null;
  new Function('require', 'Page', 'wx', 'getApp', src)(sandboxRequire, d => { def = d; }, wxStub, () => ({ globalData: {} }));
  const timers = [];
  const rST = global.setTimeout, rCT = global.clearTimeout;
  global.setTimeout = f => { timers.push(f); return timers.length; };
  global.clearTimeout = () => {};
  const page = Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)), setData(x) { Object.assign(this.data, x); } });
  const done = () => { page.stopPoll(); Date.now = realNow; global.setTimeout = rST; global.clearTimeout = rCT; };
  const tick = () => new Promise(r => setImmediate(r));
  return { page, calls, store, done, tick, advance: ms => { now += ms; } };
}
const fill = (page, extra) => Object.assign(page.data, { payerName: '张三', amount: '500', account: { accountName: '李府' } }, extra || {});

test('pay（v3.86.10）：「转账了吗？」不预选——小程序码 scene / via=scan / 分享链接进入都是 null', async () => {
  for (const opt of [{ scene: 'acc1' }, { aid: 'acc1', via: 'scan' }, { aid: 'acc1' }]) {
    const h = loadPay();
    try { h.page.onLoad(opt); await h.tick(); assert.strictEqual(h.page.data.paidFirst, null, JSON.stringify(opt)); } finally { h.done(); }
  }
});

test('pay（v3.86.10）：没选「已转账 / 还没转」提交 → 弹窗提示先选（按钮不超过 4 字），不登记、不弹订阅；现金不需要选', async () => {
  let h = loadPay();
  try {
    fill(h.page);
    assert.strictEqual(h.page.data.paidFirst, null);
    await h.page.onConfirmTransfer();
    assert.strictEqual(h.calls.create.length, 0, '没选不登记');
    assert.strictEqual(h.calls.ask, 0, '没选不弹订阅');
    assert.strictEqual(h.calls.modals.length, 1);
    assert.ok(/是否已转账/.test(h.calls.modals[0].content));
    assert.ok([...h.calls.modals[0].confirmText].length <= 4);
  } finally { h.done(); }
  h = loadPay();
  try {
    fill(h.page, { payMethod: 'cash' });
    await h.page.onConfirmTransfer();
    assert.strictEqual(h.calls.create.length, 1, '现金不受影响');
  } finally { h.done(); }
  // 重新登记（onRetry）回到未选
  h = loadPay();
  try { h.page.data.paidFirst = true; h.page.onRetry(); assert.strictEqual(h.page.data.paidFirst, null); } finally { h.done(); }
  // wxml：按钮没选时置灰，两个选项都按 === 判断（null 时都不亮）
  const w = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/pay/pay.wxml'), 'utf8');
  assert.ok(w.includes("paidFirst === null ? 'btn-dim' : ''"));
  assert.ok(w.includes("paidFirst === true ? 'on' : ''") && w.includes("paidFirst === false ? 'on' : ''"));
});

test('pay：选「已转账，现在登记」提交 → 带 paidFirst:true，直接进入等待确认，不出现转账步骤；订阅只问一次', async () => {
  const h = loadPay();
  try {
    fill(h.page, { paidFirst: true });
    await h.page.onConfirmTransfer();
    assert.strictEqual(h.calls.create.length, 1);
    assert.strictEqual(h.calls.create[0].paidFirst, true);
    assert.strictEqual(h.calls.create[0].payMethod, 'wechat');
    assert.strictEqual(h.calls.create[0].guestNotify, true, '登记时就带订阅标记');
    assert.strictEqual(h.page.data.step, 'waiting');
    assert.strictEqual(h.calls.ask, 1);
    assert.ok(!h.store.pay_open, '已转账登记不留「未完成」记录');
    assert.strictEqual(h.calls.transferred.length, 0);
  } finally { h.done(); }
});

test('pay：现金随礼即使选了「已转账」也不带 paidFirst；批次 / 混合支付带上', async () => {
  let h = loadPay();
  try {
    fill(h.page, { paidFirst: true, payMethod: 'cash' });
    await h.page.onConfirmTransfer();
    assert.ok(!('paidFirst' in h.calls.create[0]));
  } finally { h.done(); }
  h = loadPay();
  try {
    Object.assign(h.page.data, { account: {}, batchMode: true, payMethod: 'mixed', paidFirst: true });
    h.page._batchRows = [{ name: '甲', amount: '100', method: 'wechat' }, { name: '乙', amount: '200', method: 'cash' }];
    await h.page.onConfirmTransfer();
    if (h.calls.create.length) {
      assert.strictEqual(h.calls.create[0].paidFirst, true);
      assert.strictEqual(h.calls.create[0].payMethod, 'mixed');
    }
  } finally { h.done(); }
});

test('pay：先登记 → 转账步骤；登记时问过订阅，点「我已完成转账」不再问；本机恢复的旧记录补问一次', async () => {
  const h = loadPay();
  try {
    fill(h.page, { paidFirst: false });
    await h.page.onConfirmTransfer();
    assert.strictEqual(h.page.data.step, 'transfer');
    assert.ok(!('paidFirst' in h.calls.create[0]));
    assert.strictEqual(h.calls.ask, 1);
    await h.page.onTransferred();
    assert.strictEqual(h.calls.ask, 1, '只弹一次');
    assert.strictEqual(h.calls.transferred.length, 1);
    assert.strictEqual(h.page.data.step, 'waiting');
  } finally { h.done(); }
  const g = loadPay();
  try {
    Object.assign(g.page.data, { step: 'transfer', record: { _id: 'old1', payerName: '张三', payStr: '500' } });
    await g.page.onTransferred();
    assert.strictEqual(g.calls.ask, 1, '恢复的旧记录没问过，补问一次');
  } finally { g.done(); }
});

test('pay：切换「已转账」后换新 reqId（不会拿到上一次的记录）', async () => {
  const h = loadPay({ createFail: true });
  try {
    fill(h.page, { paidFirst: false });
    await quiet(() => h.page.onConfirmTransfer());
    await quiet(() => h.page.onConfirmTransfer());
    h.page.onPaidFirst({ currentTarget: { dataset: { v: '1' } } });
    await quiet(() => h.page.onConfirmTransfer());
    const ids = h.calls.create.map(c => c.reqId);
    assert.strictEqual(ids[0], ids[1], '内容不变沿用同一个 reqId');
    assert.notStrictEqual(ids[1], ids[2], '切换后换新');
  } finally { h.done(); }
});

test('pay：转账步骤离开再回来只提醒一次「转好了吗？」；离开不足 3 秒不提醒；「已转账」等同点完成', async () => {
  const h = loadPay({ modalReply: () => ({ confirm: true }) });
  try {
    Object.assign(h.page.data, { step: 'transfer', record: { _id: 'r1', payerName: '张三', payStr: '500' } });
    h.page._subRid = 'r1';
    h.page.onHide();
    h.advance(1000);
    h.page.onShow();
    assert.strictEqual(h.calls.modals.length, 0, '不足 3 秒不提醒');
    h.page.onHide();
    h.advance(20000);
    h.page.onShow();
    assert.strictEqual(h.calls.modals.length, 1);
    const m = h.calls.modals[0];
    assert.strictEqual(m.title, '转好了吗？');
    assert.strictEqual(m.confirmText, '已转账');
    assert.strictEqual(m.cancelText, '还没转');
    h.page.onShow(); // 没有再离开：不再弹
    assert.strictEqual(h.calls.modals.length, 1);
    await h.tick(); await h.tick();
    assert.strictEqual(h.calls.transferred.length, 1, '点「已转账」= 我已完成转账');
    assert.strictEqual(h.calls.ask, 0, '登记时已问过，这里不再问');
    assert.strictEqual(h.page.data.step, 'waiting');
  } finally { h.done(); }
  // 「还没转」：只提示，不改状态
  const g = loadPay({ modalReply: () => ({ cancel: true }) });
  try {
    Object.assign(g.page.data, { step: 'transfer', record: { _id: 'r1', payerName: '张三', payStr: '500' } });
    g.page.onHide(); g.advance(10000); g.page.onShow();
    await g.tick();
    assert.strictEqual(g.page.data.step, 'transfer');
    assert.ok(g.calls.toasts.some(t => /转完请回来点/.test(t)));
    assert.strictEqual(g.calls.transferred.length, 0);
    // 其他步骤不提醒
    const k = loadPay();
    try { Object.assign(k.page.data, { step: 'waiting', record: { _id: 'r1' } }); k.page.onHide(); k.advance(10000); k.page.onShow(); assert.strictEqual(k.calls.modals.length, 0); } finally { k.done(); }
  } finally { g.done(); }
});

test('pay：宾客自己取消的记录——点「已转账」不进入空等；恢复时不再提示继续（超时自动取消的仍可继续）', async () => {
  const h = loadPay({ transferredRes: { status: 'cancelled', changed: false } });
  try {
    Object.assign(h.page.data, { step: 'transfer', record: { _id: 'r1', payerName: '张三', payStr: '500' } });
    h.page._subRid = 'r1';
    await h.page.onTransferred();
    assert.strictEqual(h.page.data.step, 'form');
    assert.ok(h.calls.toasts.some(t => /已取消/.test(t)));
  } finally { h.done(); }
  const open = { aid: 'acc1', rid: 'r1', record: { _id: 'r1', payerName: '张三', amount: 500, payStr: '500', amountStr: '500' }, payCodeUrl: '', at: 10000000 - 1000 };
  const a = loadPay({ storage: { pay_open: open }, statusRes: { status: 'cancelled', auto: false } });
  try {
    a.page.data.aid = 'acc1';
    await a.page.resumeOpen('acc1');
    assert.strictEqual(a.calls.modals.length, 0);
    assert.ok(!a.store.pay_open, '清掉本机记录');
  } finally { a.done(); }
  const b = loadPay({ storage: { pay_open: open }, statusRes: { status: 'cancelled', auto: true } });
  try {
    b.page.data.aid = 'acc1';
    await b.page.resumeOpen('acc1');
    assert.strictEqual(b.calls.modals.length, 1, '超时自动取消的仍可继续');
  } finally { b.done(); }
});

test('pay 页面结构：两个大按钮、固定底栏、长按识别提示；showModal 按钮不超过 4 个字', () => {
  const w = read('miniprogram/pages/pay/pay.wxml');
  assert.ok(w.includes('转账了吗？') && w.includes('已转账，现在登记') && w.includes('还没转，先登记'));
  assert.ok(w.includes('请填写刚才转账的金额'));
  assert.ok(w.includes('也可以点大图，长按试试识别'));
  const i = w.indexOf('bindtap="onTransferred"');
  assert.ok(i > 0 && w.lastIndexOf('bottom-bar', i) > w.lastIndexOf('step === \'transfer\'', i), '「我已完成转账」在固定底栏里');
  assert.ok(/\.pay-bar-ph \{[^}]*position: static[^}]*visibility: hidden/.test(read('miniprogram/pages/pay/pay.wxss'))) // v3.86.1 起用同高占位，不再写死留白;
  assert.ok(!/(^|[^-])gap:/m.test(read('miniprogram/pages/pay/pay.wxss')), '不用 gap');
  const js = read('miniprogram/pages/pay/pay.js');
  [...js.matchAll(/(confirmText|cancelText): '([^']+)'/g)].forEach(m => assert.ok(m[2].length <= 4, '按钮文字过长：' + m[2]));
});

// ———————— 台卡、文案 ————————
function loadQr() {
  const key = require.resolve(path.join(ROOT, 'miniprogram/pages/qrcode/qrcode.js'));
  delete require.cache[key];
  const drawn = { text: [], fills: [], images: 0 };
  const ctx = {
    fillRect() {}, strokeRect() {}, measureText: () => ({ width: 100 }), drawImage() { drawn.images++; },
    set fillStyle(v) { drawn.fills.push(v); }, get fillStyle() { return ''; },
    fillText: t => drawn.text.push(t)
  };
  const canvas = {
    getContext: () => ctx,
    createImage: () => { const im = {}; Object.defineProperty(im, 'src', { set() { setImmediate(() => im.onload && im.onload()); } }); return im; }
  };
  const prev = { wx: global.wx, Page: global.Page, getApp: global.getApp };
  global.wx = {
    createSelectorQuery: () => ({ select: () => ({ fields: () => ({ exec: cb => cb([{ node: canvas }]) }) }) }),
    canvasToTempFilePath: o => o.success({ tempFilePath: 'x.png' })
  };
  let def;
  global.Page = d => { def = d; };
  global.getApp = () => ({ globalData: {} });
  try { require(key); } finally { ['Page', 'getApp'].forEach(k => { if (prev[k] === undefined) delete global[k]; else global[k] = prev[k]; }); }
  const page = Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)), setData(x) { Object.assign(this.data, x); } });
  return { page, drawn, restore: () => { if (prev.wx === undefined) delete global.wx; else global.wx = prev.wx; } };
}

test('台卡：上下两块（第 1 步收款码转账·备注写姓名 / 第 2 步扫礼簿码登记），不同底色；机构称场次码；白事素灰', async () => {
  let { page, drawn, restore } = loadQr();
  try {
  Object.assign(page.data, { primary: '#C8161D', org: false, funeral: false });
  await page.drawCard({ accountName: '李府' }, 'q.png', 'p.png');
  assert.ok(drawn.text.includes('第 1 步：扫收款码转账') && drawn.text.includes('（备注写姓名）'));
  assert.ok(drawn.text.includes('第 2 步：扫礼簿码登记'));
  assert.ok(!drawn.text.some(t => /我已完成转账/.test(t)), '旧提示已换成新流程说明');
  assert.ok(drawn.fills.includes('#E8F7EE') && drawn.fills.some(c => /^rgba\(200,22,29,0\.10\)$/.test(c)), '两块底色不同');
  assert.strictEqual(drawn.images, 2);
  ({ page, drawn } = loadQr());
  Object.assign(page.data, { primary: '#4A4A4A', org: true, funeral: false });
  await page.drawCard({ accountName: '某机构' }, 'q.png', 'p.png');
  assert.ok(drawn.text.includes('第 2 步：扫场次码登记'));
  ({ page, drawn } = loadQr());
  Object.assign(page.data, { primary: '#4A4A4A', org: false, funeral: true });
  await page.drawCard({ accountName: '李府' }, 'q.png', 'p.png');
  assert.ok(drawn.fills.includes('#EDEDED') && drawn.fills.includes('#F7F7F7'), '白事素灰');
  assert.ok(!drawn.fills.includes('#E8F7EE'));
  } finally { restore(); }
});

test('亮屏双码页：收款码在上（第 1 步）、礼簿码在下（第 2 步）；机构用场次码；旧提示已移除', () => {
  const w = read('miniprogram/pages/qrcode/qrcode.wxml');
  assert.ok(w.indexOf('第 1 步：扫收款码转账') > 0 && w.indexOf('第 2 步：扫') > w.indexOf('第 1 步'));
  assert.ok(w.indexOf('payCodeUrl') < w.indexOf('第 2 步') && w.lastIndexOf('qrUrl') > w.indexOf('第 2 步'));
  assert.ok(w.includes("org ? '场次码' : '礼簿码'") && w.includes('（备注写姓名）'));
  assert.ok(!w.includes('转账后回到小程序点'));
  assert.ok(/\.s-blk\.a \{[^}]*background/.test(read('miniprogram/pages/qrcode/qrcode.wxss')) && /\.s-blk\.b \{[^}]*background/.test(read('miniprogram/pages/qrcode/qrcode.wxss')));
});

test('文案：主家待确认「先转后登」标签与说明、礼台补录提示、教程与 FAQ、版本号', () => {
  const p = read('miniprogram/pages/pending/pending.wxml');
  assert.ok(p.includes('wx:if="{{item.paidFirst}}">先转后登') && p.includes('宾客转了账没登记？用礼台记账选「微信」补录'));
  assert.ok(read('miniprogram/pages/cash/cash.wxml').includes('宾客转了账没登记？用礼台记账选「微信」补录'));
  assert.ok(read('miniprogram/utils/group.js').includes('paidFirst: recs.some(r => r.paidFirst)'));
  const g = read('miniprogram/pages/guide/guide.js');
  assert.ok(g.includes('先扫收款码转账') && g.includes('再扫礼簿码登记') && g.includes('还没转？先登记也行'));
  const f = read('miniprogram/pages/guide/faq.js');
  assert.ok(f.includes('现场建议先转账、再登记') && f.includes('我先转了账再登记') && f.includes('登记时选了「已转账，现在登记」'));
  assert.ok(/VERSION: '3\.86\.\d+'/.test(read('miniprogram/config.js')));
});
