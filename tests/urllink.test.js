// v3.57.1：URL Link 备用通道（system._urlLink，AppSecret + HTTPS）与 payment.issueQr 的回退顺序
const assert = require('assert');
const EventEmitter = require('events');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { test } = require('./helpers/harness.js');
const { sdk, db, state, loadFunction } = require('./helpers/sdk-stub.js');

const OWNER = 'o-owner', CLERK = 'u-clerk';
const TOKEN = 'AbCdEfGhIj12';
const NONCE = 'urlnonce_' + 'a'.repeat(24);
const origCallFn = sdk.callFunction;

function seedPay() {
  db.reset()
    .seed('accounts', [{ _id: 'acc1', ownerOpenid: OWNER, accountName: '李府', activeBookId: 'b1' }])
    .seed('users', [{ openid: OWNER }, { openid: CLERK, currentAid: 'acc1' }])
    .seed('members', [{ _id: 'm1', aid: 'acc1', memberOpenid: CLERK, role: 'clerk', bookIds: ['b1'], perms: ['confirm', 'desk', 'members'] }])
    .seed('books', [{ _id: 'b1', ownerOpenid: OWNER, type: 'wedding' }])
    .seed('records', [{ _id: 'r1', aid: 'acc1', ownerOpenid: OWNER, bookId: 'b1', bookType: 'wedding', status: 'paid', payerName: '张三', amount: 100, payerOpenid: '', rcptToken: TOKEN, paidAt: new Date(), createdAt: new Date() }]);
  db.applyUpdates = true;
}
const pay = (openid, event) => { state.openid = openid; return loadFunction('payment').main(event); };

function fakeHttps(handler) {
  const orig = https.request;
  const seen = [];
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = data => {
      const body = JSON.parse(data);
      seen.push({ url, body });
      const out = handler(url, body, seen);
      const res = new EventEmitter();
      process.nextTick(() => { cb(res); res.emit('data', JSON.stringify(out)); res.emit('end'); });
    };
    return req;
  };
  return { seen, restore: () => { https.request = orig; } };
}
const sys = (openid, event) => { state.openid = openid; return loadFunction('system').main(event); };
const seedNonce = (extra = {}) => db.reset().seed('settings', [{ _id: NONCE, kind: 'urllink', createdAt: Date.now(), ...extra }]);
const link = (extra = {}) => ({ action: '_urlLink', nonce: NONCE, path: 'pages/index/index', query: '', days: 1, ...extra });

test('issueQr 回退顺序：openapi 失败 → 走 system._urlLink（带一次性凭据）；openapi 成功则不调 system', async () => {
  seedPay();
  const calls = [];
  sdk.callFunction = async o => { calls.push(o); return { result: { code: 0, data: { url: 'https://wxaurl.cn/viasys' } } }; };
  try {
    sdk.openapi.urllink = { generate: async () => { const e = new Error('no permission'); e.errCode = -604101; throw e; } };
    const r = await pay(OWNER, { action: 'issueQr', rid: 'r1' });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.data.url, 'https://wxaurl.cn/viasys');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'system');
    assert.strictEqual(calls[0].data.action, '_urlLink');
    assert.strictEqual(calls[0].data.path, 'pages/receipt/receipt');
    assert.strictEqual(calls[0].data.query, 't=' + TOKEN);
    assert.strictEqual(calls[0].data.days, 30);
    assert.ok(/^urlnonce_[0-9a-f]{24}$/.test(calls[0].data.nonce));
    calls.length = 0;
    sdk.openapi.urllink = { generate: async () => ({ urlLink: 'https://wxaurl.cn/viaapi' }) };
    const r2 = await pay(OWNER, { action: 'issueQr', rid: 'r1' });
    assert.strictEqual(r2.data.url, 'https://wxaurl.cn/viaapi');
    assert.strictEqual(calls.length, 0);
  } finally { sdk.callFunction = origCallFn; }
});

test('issueQr：两条路都失败 → url 为空并带 reason（只有错误码，不含 token / 密钥），仍返回成功', async () => {
  seedPay();
  sdk.callFunction = async () => ({ result: { code: 0, data: { url: '', reason: 'secret-missing' } } });
  try {
    sdk.openapi.urllink = { generate: async () => { const e = new Error('x'); e.errCode = -604101; throw e; } };
    const r = await pay(OWNER, { action: 'issueQr', rid: 'r1' });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.data.url, '');
    assert.strictEqual(r.data.reason, 'openapi:-604101,system:secret-missing');
    assert.ok(!JSON.stringify(r).includes(TOKEN));
    sdk.callFunction = async () => { throw new Error('boom'); };
    const r2 = await pay(OWNER, { action: 'issueQr', rid: 'r1' });
    assert.strictEqual(r2.code, 0);
    assert.ok(/^openapi:-604101,call:/.test(r2.data.reason));
  } finally { sdk.callFunction = origCallFn; }
});

test('qrCheck：只有主家 / 有「样式」权限的人可用，生成指向首页、1 天有效的链接；内部 action 不在 request.js', async () => {
  seedPay();
  const seen = [];
  sdk.openapi.urllink = { generate: async o => { seen.push(o); return { urlLink: 'https://wxaurl.cn/chk' }; } };
  const r = await pay(OWNER, { action: 'qrCheck' });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.data, { ok: true, via: 'openapi', reason: '' });
  assert.strictEqual(seen[0].path, 'pages/index/index');
  assert.strictEqual(seen[0].expireInterval, 1);
  assert.notStrictEqual((await pay(CLERK, { action: 'qrCheck' })).code, 0);
  assert.ok(!fs.readFileSync(path.join(__dirname, '../miniprogram/utils/request.js'), 'utf8').includes('_urlLink'));
});

test('system._urlLink：没有有效一次性凭据一律拒绝（含带 OPENID 的客户端调用）', async () => {
  process.env.WX_APPSECRET = 'secret-for-test';
  const h = fakeHttps(() => { throw new Error('不应请求微信接口'); });
  try {
    db.reset();
    assert.notStrictEqual((await sys('some-client', { action: '_urlLink', path: 'pages/index/index', query: '' })).code, 0);
    assert.notStrictEqual((await sys('some-client', link())).code, 0); // 凭据不存在
    seedNonce({ createdAt: Date.now() - 120000 }); // 过期
    assert.notStrictEqual((await sys('', link())).code, 0);
    seedNonce({ _openid: 'forged' }); // 客户端伪造
    assert.notStrictEqual((await sys('some-client', link())).code, 0);
    assert.strictEqual(h.seen.length, 0);
  } finally { h.restore(); }
});

test('system._urlLink：凭据有效 → stable_token + generate_urllink（30 天 / env_version），access_token 实例内缓存', async () => {
  process.env.WX_APPSECRET = 'secret-for-test';
  const h = fakeHttps(url => (url.includes('stable_token') ? { access_token: 'AT1' } : { errcode: 0, url_link: 'https://wxaurl.cn/xyz' }));
  try {
    seedNonce();
    const fn = loadFunction('system');
    state.openid = 'whoever';
    const r = await fn.main(link({ path: 'pages/receipt/receipt', query: 't=' + TOKEN, days: 99, envVersion: 'trial' }));
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.data.url, 'https://wxaurl.cn/xyz');
    const gen = h.seen.find(x => x.url.includes('generate_urllink'));
    assert.ok(gen.url.includes('access_token=AT1'));
    assert.deepStrictEqual(gen.body, { path: 'pages/receipt/receipt', query: 't=' + TOKEN, expire_type: 1, expire_interval: 30, env_version: 'trial' });
    assert.strictEqual(h.seen.filter(x => x.url.includes('stable_token')).length, 1);
    seedNonce();
    await fn.main(link());
    assert.strictEqual(h.seen.filter(x => x.url.includes('stable_token')).length, 1); // 复用缓存
    seedNonce();
    const bad = await fn.main(link({ path: 'pages/records/records' }));
    assert.strictEqual(bad.data.reason, 'bad-param'); // 路径白名单
  } finally { h.restore(); }
});

test('system._urlLink：access_token 失效（40001）→ 强制刷新后重试一次；仍失败给出 http 错误码', async () => {
  process.env.WX_APPSECRET = 'secret-for-test';
  let n = 0;
  const h = fakeHttps((url, body) => {
    if (url.includes('stable_token')) return { access_token: body.force_refresh ? 'AT-NEW' : 'AT-OLD' };
    n++;
    return url.includes('AT-OLD') ? { errcode: 40001, errmsg: 'invalid credential' } : { errcode: 0, url_link: 'https://wxaurl.cn/retry' };
  });
  try {
    seedNonce();
    const r = await sys('x', link());
    assert.strictEqual(r.data.url, 'https://wxaurl.cn/retry');
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(h.seen.filter(x => x.url.includes('stable_token')).map(x => x.body.force_refresh), [false, true]);
  } finally { h.restore(); }
  const h2 = fakeHttps(url => (url.includes('stable_token') ? { access_token: 'AT' } : { errcode: 42001 }));
  try {
    seedNonce();
    const r = await sys('x', link());
    assert.strictEqual(r.data.url, '');
    assert.strictEqual(r.data.reason, 'http:42001');
    assert.strictEqual(h2.seen.filter(x => x.url.includes('generate_urllink')).length, 2); // 只重试一次
  } finally { h2.restore(); }
});

test('system._urlLink：WX_APPSECRET 未配置 → secret-missing；AppSecret 错误 → token:40125（不含密钥）', async () => {
  const saved = process.env.WX_APPSECRET;
  try {
    delete process.env.WX_APPSECRET;
    seedNonce();
    assert.strictEqual((await sys('x', link())).data.reason, 'secret-missing');
    process.env.WX_APPSECRET = 'wrong-secret-xyz';
    const h = fakeHttps(() => ({ errcode: 40125, errmsg: 'invalid appsecret' }));
    try {
      seedNonce();
      const r2 = await sys('x', link());
      assert.strictEqual(r2.data.reason, 'token:40125');
      assert.ok(!JSON.stringify(r2).includes('wrong-secret-xyz'));
    } finally { h.restore(); }
  } finally { if (saved === undefined) delete process.env.WX_APPSECRET; else process.env.WX_APPSECRET = saved; }
});
