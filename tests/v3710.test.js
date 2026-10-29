// v3.71.0：内容安全审核（secure.js：risky 拒绝、pass / review / 异常 / 超时放行、空串跳过；各入口接入）与宾客等待页轮询退避
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { db, state, sdk, loadFunction, ROOT } = require('./helpers/sdk-stub.js');
const S = require('../tools/cloud-shared/secure.js');
const paypoll = require('../miniprogram/utils/paypoll.js');

const OWNER = 'o-owner';
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const BAD_MSG = '内容含有不适宜信息，请修改后再提交';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]);
const quiet = async fn => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

/** 假的审核接口：opts.risky 里的词出现在文本里就 risky；记录调用 */
const calls = { text: [], img: [] };
function fakeSec(opts) {
  opts = opts || {};
  calls.text.length = 0; calls.img.length = 0;
  sdk.openapi = {
    security: {
      msgSecCheck: async o => {
        calls.text.push(o);
        if (opts.textThrow) throw opts.textThrow;
        if (opts.textHang) return new Promise(() => {});
        const c = String(o.content);
        if ((opts.risky || ['脏话']).some(w => c.includes(w))) return { result: { suggest: 'risky', label: 20001 } };
        if ((opts.review || []).some(w => c.includes(w))) return { result: { suggest: 'review' } };
        return { result: { suggest: 'pass' } };
      },
      imgSecCheck: async o => {
        calls.img.push(o);
        if (opts.imgThrow) throw opts.imgThrow;
        if (opts.imgRisky) { const e = new Error('risky'); e.errCode = 87014; throw e; }
        return {};
      }
    }
  };
  state.download = async () => opts.imgBuf || PNG;
}

test('secure.checkText：risky 拒绝；pass / review 放行；空串与空白不调用接口', async () => {
  fakeSec({ review: ['可疑'] });
  assert.strictEqual(await S.checkText(sdk, 'u1', ['张三', '']), null);
  assert.strictEqual(calls.text.length, 1);
  assert.strictEqual(calls.text[0].version, 2);
  assert.strictEqual(calls.text[0].scene, 1);
  assert.strictEqual(calls.text[0].openid, 'u1');
  const bad = await S.checkText(sdk, 'u1', ['张三', '脏话连篇']);
  assert.deepStrictEqual(bad, { code: 1, msg: BAD_MSG, data: null });
  await quiet(async () => assert.strictEqual(await S.checkText(sdk, 'u1', ['可疑内容']), null)); // review：通过
  calls.text.length = 0;
  assert.strictEqual(await S.checkText(sdk, 'u1', ['', '   ', null, undefined]), null);
  assert.strictEqual(calls.text.length, 0);
  assert.strictEqual(await S.checkText(sdk, '', ['脏话']), null, '没有 openid 无法审核：放行');
});

test('secure.checkText：无权限（-604101）、接口异常、超时都放行并 warn，不阻断', async () => {
  const warns = [];
  const w = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try {
    const e = new Error('no permission'); e.errCode = -604101;
    fakeSec({ textThrow: e });
    assert.strictEqual(await S.checkText(sdk, 'u1', ['脏话']), null);
    fakeSec({ textThrow: new Error('boom') });
    assert.strictEqual(await S.checkText(sdk, 'u1', ['脏话']), null);
    sdk.openapi = {}; // 接口对象都没有
    assert.strictEqual(await S.checkText(sdk, 'u1', ['脏话']), null);
    fakeSec({ textHang: true });
    const t0 = Date.now();
    assert.strictEqual(await S.checkText(sdk, 'u1', ['脏话']), null);
    assert.ok(Date.now() - t0 < 3600, '超时 3 秒内放行');
  } finally { console.warn = w; }
  assert.ok(warns.length >= 4 && warns.every(x => x.startsWith('secure:')));
});

test('secure.pack：多字段合并成一次调用，超长拆段', () => {
  assert.deepStrictEqual(S.pack(['a', '', 'b']), ['a\nb']);
  const long = 'x'.repeat(1500);
  assert.strictEqual(S.pack([long, long]).length, 2);
  assert.deepStrictEqual(S.pack([]), []);
});

test('secure.checkImage：87014 拒绝并删除文件；通过放行；>1MB、异常、非图片格式、非云文件放行', async () => {
  const deleted = [];
  sdk.deleteFile = async o => { deleted.push(...o.fileList); return {}; };
  fakeSec({ imgRisky: true });
  const bad = await S.checkImage(sdk, 'cloud://env/avatars/a.jpg');
  assert.strictEqual(bad.msg, BAD_MSG);
  assert.deepStrictEqual(deleted, ['cloud://env/avatars/a.jpg']);
  assert.strictEqual(calls.img[0].media.contentType, 'image/png');
  fakeSec();
  assert.strictEqual(await S.checkImage(sdk, 'cloud://env/a.png'), null);
  await quiet(async () => {
    fakeSec({ imgBuf: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]) });
    assert.strictEqual(await S.checkImage(sdk, 'cloud://env/a.png'), null);
    assert.strictEqual(calls.img.length, 0, '超过 1MB 不调用接口');
    fakeSec({ imgBuf: Buffer.from('not an image at all') });
    assert.strictEqual(await S.checkImage(sdk, 'cloud://env/a.png'), null);
    assert.strictEqual(calls.img.length, 0);
    const e = new Error('no permission'); e.errCode = -604101;
    fakeSec({ imgThrow: e });
    assert.strictEqual(await S.checkImage(sdk, 'cloud://env/a.png'), null);
    state.download = async () => { throw new Error('下载失败'); };
    assert.strictEqual(await S.checkImage(sdk, 'cloud://env/a.png'), null);
  });
  assert.strictEqual(await S.checkImage(sdk, ''), null);
  assert.strictEqual(await S.checkImage(sdk, 'https://x/a.png'), null);
  sdk.deleteFile = async () => ({ fileList: [] });
});

// ---- 各入口
const OWN_CODE = `cloud://env/paycodes/${OWNER}-1.png`;
function seed() {
  db.reset().applyUpdates = true;
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1', accountName: '张府', payCodeFileID: OWN_CODE }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '本场', type: 'wedding' }])
    .seed('users', [{ _id: OWNER, openid: OWNER, nickname: '主家' }]);
  state.openid = OWNER;
}
const books = ev => loadFunction('books').main(ev);

test('books.save：礼簿名 / 地点 / 本场主家称呼违规拒绝，没改的字段不送审', async () => {
  seed(); fakeSec();
  for (const book of [{ name: '脏话礼簿' }, { name: '本场', location: '脏话路' }, { name: '本场', hostName: '脏话' }]) {
    const r = await books({ action: 'save', book: { _id: 'b1', type: 'wedding', ...book } });
    assert.strictEqual(r.msg, BAD_MSG, JSON.stringify(book));
  }
  assert.strictEqual((await db.collection('books').doc('b1').get()).data.name, '本场');
  calls.text.length = 0;
  const same = await books({ action: 'save', book: { _id: 'b1', type: 'wedding', name: '本场' } });
  assert.strictEqual(same.code, 0, same.msg);
  assert.strictEqual(calls.text.length, 0, '未改动不调用审核');
  const ok = await books({ action: 'save', book: { _id: 'b1', type: 'wedding', name: '新名字', location: '北京' } });
  assert.strictEqual(ok.code, 0, ok.msg);
  assert.ok(calls.text[0].content.includes('新名字') && calls.text[0].content.includes('北京'));
});

test('books.save：本场收款码图片违规拒绝', async () => {
  seed(); fakeSec({ imgRisky: true });
  const r = await books({ action: 'save', book: { _id: 'b1', name: '本场', type: 'wedding', payCodeFileID: `cloud://env/paycodes/book-${OWNER}-2.png` } });
  assert.strictEqual(r.msg, BAD_MSG);
  fakeSec();
  const ok = await books({ action: 'save', book: { _id: 'b1', name: '本场', type: 'wedding', payCodeFileID: `cloud://env/paycodes/book-${OWNER}-3.png` } });
  assert.strictEqual(ok.code, 0, ok.msg);
  assert.strictEqual(calls.img.length, 1);
});

test('books.saveTpl：回执标题 / 页脚、小票致谢语违规拒绝；没改的不送审', async () => {
  seed(); fakeSec();
  const r1 = await books({ action: 'saveTpl', bookId: 'b1', receiptTpl: { style: 'card', title: '脏话回执' } });
  assert.strictEqual(r1.msg, BAD_MSG);
  const r2 = await books({ action: 'saveTpl', bookId: 'b1', printTpl: { fields: ['title'], thanks: '脏话谢谢' } });
  assert.strictEqual(r2.msg, BAD_MSG);
  const r3 = await books({ action: 'saveTpl', bookId: 'b1', receiptTpl: { style: 'card', footer: '脏话' } });
  assert.strictEqual(r3.msg, BAD_MSG);
  const ok = await books({ action: 'saveTpl', bookId: 'b1', receiptTpl: { style: 'card', title: '礼金回执', footer: '感谢光临' } });
  assert.strictEqual(ok.code, 0, ok.msg);
  db.reset().applyUpdates = true; // 假库不展开 _.set：直接用已存的模板重新播种
  db.seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, activeBookId: 'b1', accountName: '张府', payCodeFileID: OWN_CODE }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, name: '本场', type: 'wedding', receiptTpl: { title: '礼金回执', footer: '感谢光临' } }]);
  calls.text.length = 0;
  const again = await books({ action: 'saveTpl', bookId: 'b1', receiptTpl: { style: 'card', title: '礼金回执', footer: '感谢光临' } });
  assert.strictEqual(again.code, 0);
  assert.strictEqual(calls.text.length, 0);
});

test('account.save：主家称呼违规拒绝，没改的不送审；setHandlerName / acceptInvite 的名字送审', async () => {
  seed(); fakeSec();
  const acc = ev => loadFunction('account').main(ev);
  const save = name => acc({ action: 'save', accountName: name, payCodeFileID: '@current' });
  assert.strictEqual((await save('脏话府')).msg, BAD_MSG);
  calls.text.length = 0;
  assert.strictEqual((await save('张府')).code, 0);
  assert.strictEqual(calls.text.length, 0);
  assert.strictEqual((await save('李府')).code, 0);
  assert.strictEqual(calls.text.length, 1);
  assert.strictEqual((await acc({ action: 'setHandlerName', name: '脏话' })).msg, BAD_MSG);
  assert.strictEqual((await acc({ action: 'acceptInvite', token: 'tk', displayName: '脏话王' })).msg, BAD_MSG);
});

test('account.save：新收款码图片违规拒绝', async () => {
  seed(); fakeSec({ imgRisky: true });
  sdk.getTempFileURL = async () => ({ fileList: [{ tempFileURL: 'https://x', status: 0 }] });
  const r = await loadFunction('account').main({ action: 'save', accountName: '张府', payCodeFileID: `cloud://env/paycodes/${OWNER}-9.png` });
  assert.strictEqual(r.msg, BAD_MSG);
  sdk.getTempFileURL = async () => ({ fileList: [] });
});

test('login：新昵称违规拒绝登录，昵称没变不送审；违规头像拒绝', async () => {
  db.reset().applyUpdates = true;
  db.seed('users', [{ _id: 'u1', openid: 'u1', nickname: 'A', avatar: '' }]);
  fakeSec();
  const login = (o, u) => { state.openid = o; return loadFunction('login').main({ userInfo: u }); };
  assert.strictEqual((await login('u1', { nickname: '脏话' })).msg, BAD_MSG);
  calls.text.length = 0;
  assert.strictEqual((await login('u1', { nickname: 'A' })).code, 0);
  assert.strictEqual(calls.text.length, 0);
  assert.strictEqual((await login('new1', { nickname: '脏话新人' })).msg, BAD_MSG);
  assert.strictEqual((await login('new2', { nickname: '好人' })).code, 0);
  fakeSec({ imgRisky: true });
  assert.strictEqual((await login('u1', { nickname: 'A', avatar: 'cloud://env/avatars/zzz.jpg' })).msg, BAD_MSG);
});

test('payment.create：宾客姓名 / 备注 / 区分备注违规拒绝；cashEntry 同样送审', async () => {
  seed(); fakeSec();
  state.openid = 'g1';
  const pay = ev => loadFunction('payment').main(ev);
  assert.strictEqual((await pay({ action: 'create', aid: 'acc1', payerName: '脏话', amount: 100 })).msg, BAD_MSG);
  assert.strictEqual((await pay({ action: 'create', aid: 'acc1', payerName: '张三', amount: 100, remark: '脏话' })).msg, BAD_MSG);
  assert.strictEqual((await pay({ action: 'create', aid: 'acc1', payerName: '张三', amount: 100, tag: '脏话' })).msg, BAD_MSG);
  const okR = await pay({ action: 'create', aid: 'acc1', payerName: '张三', amount: 100, remark: '百年好合' });
  assert.notStrictEqual(okR.msg, BAD_MSG);
  assert.ok(calls.text.some(c => c.content.includes('百年好合')));
  state.openid = OWNER;
  assert.strictEqual((await pay({ action: 'cashEntry', payerName: '脏话', amount: 100 })).msg, BAD_MSG);
});

test('接入清单：四个云函数带 secure.js 副本与 openapi 权限，登记在 sync_shared', () => {
  for (const fn of ['account', 'books', 'login', 'payment']) {
    assert.strictEqual(read(`cloudfunctions/${fn}/secure.js`), read('tools/cloud-shared/secure.js'), fn);
    const cfg = JSON.parse(read(`cloudfunctions/${fn}/config.json`));
    assert.ok(cfg.permissions.openapi.includes('security.msgSecCheck') && cfg.permissions.openapi.includes('security.imgSecCheck'), fn);
  }
  assert.ok(/'secure\.js'/.test(read('tools/sync_shared.py')));
  const pay = JSON.parse(read('cloudfunctions/payment/config.json'));
  assert.ok(pay.permissions.openapi.includes('subscribeMessage.send') && pay.permissions.openapi.includes('wxacode.getUnlimited'), '原有权限保留');
});

// ---- 宾客等待页轮询退避
test('paypoll.delay：1 分钟内 3 秒，3 分钟内 5 秒，之后 10 秒；最长 10 分钟', () => {
  assert.strictEqual(paypoll.delay(0), 3000);
  assert.strictEqual(paypoll.delay(59999), 3000);
  assert.strictEqual(paypoll.delay(60000), 5000);
  assert.strictEqual(paypoll.delay(179999), 5000);
  assert.strictEqual(paypoll.delay(180000), 10000);
  assert.strictEqual(paypoll.delay(599000), 10000);
  assert.strictEqual(paypoll.MAX_MS, 600000);
});

/** 在假定时器 + 假时钟下运行 pay.js 的轮询 */
async function runPay(fn) {
  const src = read('miniprogram/pages/pay/pay.js');
  let def = null;
  const realNow = Date.now, rST = global.setTimeout, rCT = global.clearTimeout;
  let now = 1000000; const timers = new Map(); let seq = 0;
  const stat = { n: 0, times: [], status: 'transferred' };
  Date.now = () => now;
  global.setTimeout = (f, ms) => { timers.set(++seq, { f, at: now + ms }); return seq; };
  global.clearTimeout = id => timers.delete(id);
  const sandboxRequire = p => {
    if (p === '../../utils/request.js') return { payStatus: async () => { stat.n++; stat.times.push(now); return { status: stat.status }; }, receiptGet: async () => { throw new Error('x'); } };
    if (p.startsWith('../../')) return require(path.join(ROOT, 'miniprogram', p.replace('../../', '')));
    return require(p);
  };
  const wxStub = { vibrateShort() {}, getStorageSync() { return ''; } };
  new Function('require', 'Page', 'wx', 'getApp', src)(sandboxRequire, o => { def = o; }, wxStub, () => ({ globalData: {} }));
  const page = Object.assign({}, def, { data: { ...def.data, record: { _id: 'r1' } }, setData(o) { Object.assign(this.data, o); } });
  const tick = async ms => { // 推进假时钟，依次触发到期定时器
    const end = now + ms;
    for (;;) {
      await new Promise(r => setImmediate(r));
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = Math.max(now, due[1].at); due[1].f();
    }
    now = end; await new Promise(r => setImmediate(r));
  };
  try { await fn({ page, tick, stat, timers }); } finally { Date.now = realNow; global.setTimeout = rST; global.clearTimeout = rCT; }
}

test('pay 轮询：间隔 3 秒 → 5 秒 → 10 秒，10 分钟后停止并提示；刷新状态从头开始', async () => {
  await runPay(async ({ page, tick, stat, timers }) => {
    const gaps = () => stat.times.map((t, i) => (i ? t - stat.times[i - 1] : 0)).slice(1);
    page.startPoll();
    await tick(0);
    assert.strictEqual(stat.n, 1);
    await tick(59000);
    assert.ok(gaps().length >= 19 && gaps().every(g => g === 3000), gaps().join(','));
    await tick(130000); // 约 3 分钟
    assert.ok(gaps().includes(5000) && gaps().every(g => [3000, 5000, 10000].includes(g)));
    await tick(300000);
    const g2 = gaps();
    assert.strictEqual(g2[g2.length - 1], 10000);
    assert.strictEqual(page.data.pollTimeout, false);
    await tick(200000); // 总计超过 10 分钟
    assert.strictEqual(page.data.pollTimeout, true);
    assert.strictEqual(timers.size, 0, '超时后不再排定时器');
    const n = stat.n;
    await tick(60000);
    assert.strictEqual(stat.n, n);
    page.onRefresh(); // 刷新状态：重新开始，立即查一次并回到 3 秒
    await tick(0);
    assert.strictEqual(stat.n, n + 1);
    assert.strictEqual(page.data.pollTimeout, false);
    await tick(3000);
    assert.strictEqual(stat.n, n + 2);
  });
});

test('pay 轮询：页面隐藏停止，回到页面立即查一次并重新从 3 秒开始；确认后停止', async () => {
  await runPay(async ({ page, tick, stat, timers }) => {
    page.data.step = 'waiting';
    page.startPoll();
    await tick(200000); // 进入慢档
    page.onHide();
    assert.strictEqual(timers.size, 0);
    const n = stat.n;
    await tick(60000);
    assert.strictEqual(stat.n, n, '隐藏后不再查询');
    page.onShow();
    await tick(0);
    assert.strictEqual(stat.n, n + 1, '回到页面立即查一次');
    await tick(3000);
    assert.strictEqual(stat.n, n + 2, '重新从 3 秒开始');
    await tick(3000);
    assert.strictEqual(stat.n, n + 3);
    stat.status = 'paid';
    await tick(3000);
    assert.strictEqual(page.data.step, 'success');
    assert.strictEqual(timers.size, 0);
    const m = stat.n;
    await tick(30000);
    assert.strictEqual(stat.n, m);
  });
});

test('pay 轮询：源码不再使用固定间隔 / 次数上限；保留超时说明', () => {
  const src = read('miniprogram/pages/pay/pay.js');
  assert.ok(!/setInterval|POLL_MAX|POLL_MS/.test(src));
  assert.ok(/utils\/paypoll\.js/.test(src));
  assert.ok(/pollTimeout: true/.test(src) && /onRefresh\(\)/.test(src));
});
